import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
} from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentRouteRuntime,
  isMaterialAgentStreamEvent,
  prepareAgentCandidateContext,
  type AgentRouteContinuity,
  type AgentStreamInvoke,
  type AgentRouteRuntimeOptions,
} from "../agent/agent-route-runtime.js";
import { FileBackendHealthStore } from "../llm/backend-health-store.js";
import {
  CredentialResolver,
  type CredentialProvider,
  type ResolvedApiKeyCredential,
  type ResolvedCodexCredential,
  type ResolvedGrokOAuthCredential,
} from "../llm/credentials/index.js";
import { MODEL_GLOBAL_PROMPT_ASSETS, countModelGlobalPromptMarkers, resolveModelGlobalPrompt } from "../llm/model-global-prompt.js";
import type { ModelRoutingConfig } from "../llm/model-routing.js";
import { ProviderError } from "../llm/provider-error.js";
import type { RoutingEvent } from "../llm/routing-trace.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("AgentRouteRuntime", () => {
  it("discards pre-output metadata from A, emits a safe switch, and forwards only B business events", async () => {
    const calls: string[] = [];
    const events: RoutingEvent[] = [];
    const runtime = await createRuntime((model) => {
      calls.push(model.id);
      return model.id === "model-a"
        ? fakeStream([
            event("start", model),
            event("text_start", model),
            failure(model, "insufficient_quota"),
          ])
        : fakeStream([
            event("start", model),
            textDelta(model, "from-b"),
            done(model, "from-b"),
          ]);
    }, { observer: (routingEvent) => events.push(routingEvent) });

    const received = await collect(runtime.runtime.stream(
      runtime.runtime.reference("route-main"),
      context(),
      undefined,
    ));

    expect(calls).toEqual(["model-a", "model-b"]);
    expect(received.map((item) => item.type)).toEqual(["start", "text_delta", "done"]);
    expect(received.filter((item) => item.type === "text_delta"))
      .toEqual([expect.objectContaining({ delta: "from-b" })]);
    expect(events.map((item) => item.type)).toEqual([
      "attempt_started",
      "failed",
      "backend_switched",
      "attempt_started",
      "succeeded",
    ]);
    expect(events.find((item) => item.type === "backend_switched")).toMatchObject({
      fromBackendId: "backend-a",
      toBackendId: "backend-b",
      visibleOutput: false,
    });
  });

  it("does not invoke B after a non-empty text delta and reports visible output", async () => {
    const calls: string[] = [];
    let terminal: unknown;
    const runtime = await createRuntime((model) => {
      calls.push(model.id);
      return fakeStream([
        event("start", model),
        textDelta(model, "partial"),
        failure(model, "network connection reset"),
      ]);
    });

    const received = await collect(runtime.runtime.stream(
      runtime.runtime.reference("route-main"),
      context(),
      undefined,
      { onTerminalError: (error) => { terminal = error; } },
    ));

    expect(calls).toEqual(["model-a"]);
    expect(received.map((item) => item.type)).toEqual(["start", "text_delta", "error"]);
    expect(terminal).toBeInstanceOf(ProviderError);
    expect((terminal as ProviderError).visibleOutput).toBe(true);
    expect((terminal as ProviderError).attempts).toEqual([
      expect.objectContaining({ backendId: "backend-a", visibleOutput: true }),
    ]);
  });

  it.each(["toolcall_start", "toolcall_delta", "toolcall_end"] as const)(
    "locks failover after %s so a tool call cannot be replayed",
    async (boundary) => {
      const calls: string[] = [];
      const runtime = await createRuntime((model) => {
        calls.push(model.id);
        return fakeStream([
          event("start", model),
          toolEvent(boundary, model),
          failure(model, "network connection reset"),
        ]);
      });

      const received = await collect(runtime.runtime.stream(
        runtime.runtime.reference("route-main"),
        context(),
        undefined,
      ));

      expect(calls).toEqual(["model-a"]);
      expect(received.some((item) => item.type === boundary)).toBe(true);
      expect(received.at(-1)?.type).toBe("error");
    },
  );

  it("treats forwarded thinking as material but may discard non-forwarded thinking before switching", async () => {
    const calls: string[] = [];
    const runtime = await createRuntime((model) => {
      calls.push(model.id);
      return model.id === "model-a"
        ? fakeStream([
            event("start", model),
            thinkingDelta(model, "private"),
            failure(model, "network connection reset"),
          ])
        : fakeStream([event("start", model), textDelta(model, "ok"), done(model, "ok")]);
    });

    const forwarded = await collect(runtime.runtime.stream(
      runtime.runtime.reference("route-main"),
      context(),
      undefined,
    ));
    expect(calls).toEqual(["model-a"]);
    expect(forwarded.map((item) => item.type)).toEqual(["start", "thinking_delta", "error"]);

    calls.length = 0;
    await runtime.runtime.healthStore.reset("backend-a");
    const hidden = await collect(runtime.runtime.stream(
      runtime.runtime.reference("route-main"),
      context(),
      undefined,
      { forwardThinking: false },
    ));
    expect(calls).toEqual(["model-a", "model-b"]);
    expect(hidden.map((item) => item.type)).toEqual(["start", "text_delta", "done"]);
  });

  it("clones context per attempt, injects the route prompt once, and strips Grok reasoning only for Grok", async () => {
    const source = context();
    source.messages.push({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "secret reasoning" },
        { type: "text", text: "answer" },
      ],
      api: "openai-completions",
      provider: "openai",
      model: "old",
      usage: usage(),
      stopReason: "stop",
      timestamp: 1,
    });
    const resolution = resolveModelGlobalPrompt({ configuredFamily: "grok" });

    const grok = prepareAgentCandidateContext(source, resolution, true);
    const generic = prepareAgentCandidateContext(source, resolution, false);

    expect(grok).not.toBe(source);
    expect(grok.messages).not.toBe(source.messages);
    expect(countModelGlobalPromptMarkers(grok.systemPrompt ?? "")).toBe(1);
    expect(grok.systemPrompt).toContain(MODEL_GLOBAL_PROMPT_ASSETS.grok.id);
    expect(JSON.stringify(grok.messages)).not.toContain("secret reasoning");
    expect(JSON.stringify(generic.messages)).toContain("secret reasoning");
    expect(JSON.stringify(source.messages)).toContain("secret reasoning");
  });

  it("forces a Codex credential refresh once, keeps Responses semantics, and never stores the token in revision", async () => {
    const refresh = vi.fn(async (): Promise<ResolvedCodexCredential> => ({
      kind: "codex",
      accessToken: "fresh-token-value",
      accountId: "acct-1",
      refresh,
    }));
    const calls: Array<{ readonly api: string; readonly apiKey?: string; readonly headers?: Record<string, string> }> = [];
    const runtime = await createRuntime((model, _context, options) => {
      calls.push({ api: model.api, apiKey: options?.apiKey, headers: options?.headers });
      return calls.length === 1
        ? fakeStream([failure(model, "401 unauthorized invalid_token")])
        : fakeStream([event("start", model), textDelta(model, "ok"), done(model, "ok")]);
    }, {
      credentialKind: "codex",
      credential: {
        kind: "codex",
        accessToken: "initial-token-value",
        accountId: "acct-1",
        refresh,
      },
      apiFormat: "responses",
    });

    const reference = runtime.runtime.reference("route-main");
    const received = await collect(runtime.runtime.stream(reference, context(), undefined));

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(calls.map((item) => item.api)).toEqual([
      "openai-codex-responses",
      "openai-codex-responses",
    ]);
    expect(calls.map((item) => item.apiKey)).toEqual([
      "initial-token-value",
      "fresh-token-value",
    ]);
    expect(calls[0]?.headers).toMatchObject({ "chatgpt-account-id": "acct-1" });
    expect(reference.revision).not.toContain("token");
    expect(received.at(-1)?.type).toBe("done");
  });

  it("forces Grok refresh once, marks auth-required on repeated auth, and uses chat transport", async () => {
    const markAuthRequired = vi.fn(async () => undefined);
    const refresh = vi.fn(async (): Promise<ResolvedGrokOAuthCredential> => ({
      kind: "grok_oauth",
      accessToken: "fresh-grok-token",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      refresh,
      markAuthRequired,
    }));
    const calls: Array<{ readonly apiKey?: string; readonly api: string }> = [];
    const grokRouting = routing("grok_oauth");
    grokRouting.routes[0]!.candidates = [grokRouting.routes[0]!.candidates[0]!];
    const runtime = await createRuntime((model, _context, options) => {
      calls.push({ apiKey: options?.apiKey, api: model.api });
      return fakeStream([failure(model, "403 forbidden invalid_token")]);
    }, {
      credentialKind: "grok_oauth",
      credential: {
        kind: "grok_oauth",
        accessToken: "initial-grok-token",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        refresh,
        markAuthRequired,
      },
      routing: grokRouting,
    });

    const received = await collect(runtime.runtime.stream(
      runtime.runtime.reference("route-main"),
      context(),
      undefined,
    ));

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(markAuthRequired).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.apiKey).toBe("fresh-grok-token");
    expect(calls.every((item) => item.api === "openai-completions")).toBe(true);
    expect(received.at(-1)?.type).toBe("error");
  });

  it("stops the current attempt and emits no switch or business event after cancellation", async () => {
    const controller = new AbortController();
    const routingEvents: RoutingEvent[] = [];
    const runtime = await createRuntime((model) => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push(event("start", model));
        controller.abort(new DOMException("stopped", "AbortError"));
        stream.push(textDelta(model, "late"));
        stream.push(failure(model, "network"));
        stream.end();
      });
      return stream;
    }, { observer: (routingEvent) => routingEvents.push(routingEvent) });

    const received = await collect(runtime.runtime.stream(
      runtime.runtime.reference("route-main"),
      context(),
      { signal: controller.signal },
    ));

    expect(received.some((item) => item.type === "text_delta")).toBe(false);
    expect(routingEvents.some((item) => item.type === "backend_switched")).toBe(false);
    expect(received.at(-1)?.type).toBe("error");
  });

  it("changes the cache revision for route edits but not runtime credential refreshes", async () => {
    const base = routing();
    const first = await createRuntime(() => fakeStream([]), { routing: base });
    const firstRevision = first.runtime.reference("route-main").revision;
    const edited = structuredClone(base);
    edited.routes[0]!.candidates[0]!.upstreamModelId = "model-a-v2";
    const second = await createRuntime(() => fakeStream([]), { routing: edited });

    expect(second.runtime.reference("route-main").revision).not.toBe(firstRevision);
    expect(first.runtime.reference("route-main").revision).toBe(firstRevision);
  });

  it("settles the downstream stream when route resolution fails before an attempt starts", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-agent-route-resolution-"));
    roots.push(root);
    const runtime = new AgentRouteRuntime({
      routing: routing(),
      projectRoot: root,
      baseConfig: {
        provider: "openai",
        service: "custom",
        configSource: "studio",
        baseUrl: "https://compat.invalid/v1",
        apiKey: "",
        model: "compat",
        temperature: 0.7,
        thinkingBudget: 0,
        apiFormat: "chat",
        stream: true,
      },
      credentials: new CredentialResolver([{
        kind: "api_key",
        resolve: async () => {
          throw new Error("fixture credential resolution failed");
        },
      }]),
      healthStore: new FileBackendHealthStore(root),
      invoke: () => {
        throw new Error("invoke must not run");
      },
    });

    const received = await collect(runtime.stream(runtime.reference("route-main"), context(), undefined));

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: "error" });
  });

  it.each(["invalid_request", "context_overflow", "content_policy"] as const)(
    "does not retry or switch for %s",
    async (category) => {
      const calls: string[] = [];
      const runtime = await createRuntime((model) => {
        calls.push(model.id);
        return fakeStream([providerFailure(model, new ProviderError({ category }))]);
      });

      const received = await collect(runtime.runtime.stream(
        runtime.runtime.reference("route-main"),
        context(),
        undefined,
      ));

      expect(calls).toEqual(["model-a"]);
      expect(received.at(-1)?.type).toBe("error");
    },
  );

  it("honors bounded Retry-After on the same backend and cancellation during the retry wait", async () => {
    const delays: number[] = [];
    const calls: string[] = [];
    const runtime = await createRuntime((model) => {
      calls.push(model.id);
      return calls.length === 1
        ? fakeStream([providerFailure(model, new ProviderError({
            category: "rate_limit",
            status: 429,
            retryAfter: { source: "retry-after", raw: "2", delayMs: 2_000 },
          }))])
        : fakeStream([done(model, "ok")]);
    }, {
      sleep: async (delayMs) => { delays.push(delayMs); },
      policy: {
        ...testPolicy(),
        localRetries: { ...testPolicy().localRetries, rate_limit: 1 },
        maxRetryDelayMs: 5_000,
      },
    });

    await collect(runtime.runtime.stream(runtime.runtime.reference("route-main"), context(), undefined));
    expect(calls).toEqual(["model-a", "model-a"]);
    expect(delays).toEqual([2_000]);

    let retryWaitStarted!: () => void;
    const waiting = new Promise<void>((resolve) => { retryWaitStarted = resolve; });
    const abortController = new AbortController();
    const cancelledCalls: string[] = [];
    const cancelled = await createRuntime((model) => {
      cancelledCalls.push(model.id);
      return fakeStream([providerFailure(model, new ProviderError({ category: "rate_limit", status: 429 }))]);
    }, {
      sleep: (_delayMs, signal) => new Promise<void>((_resolve, reject) => {
        retryWaitStarted();
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
      policy: {
        ...testPolicy(),
        localRetries: { ...testPolicy().localRetries, rate_limit: 1 },
      },
    });
    const collecting = collect(cancelled.runtime.stream(
      cancelled.runtime.reference("route-main"),
      context(),
      undefined,
      { signal: abortController.signal },
    ));
    await waiting;
    abortController.abort(new Error("cancel fixture"));
    const cancelledEvents = await collecting;
    expect(cancelledCalls).toEqual(["model-a"]);
    expect(cancelledEvents.at(-1)?.type).toBe("error");
  });

  it("skips unavailable health candidates and isolates throwing observers", async () => {
    const calls: string[] = [];
    const runtime = await createRuntime((model) => {
      calls.push(model.id);
      return fakeStream([done(model, "ok")]);
    }, {
      observer: () => { throw new Error("observer fixture"); },
    });
    await runtime.runtime.healthStore.recordFailure({
      backendId: "backend-a",
      status: "quota_exhausted",
      reason: "quota",
      at: Date.now(),
    });

    const received = await collect(runtime.runtime.stream(
      runtime.runtime.reference("route-main"),
      context(),
      undefined,
      { observer: () => { throw new Error("request observer fixture"); } },
    ));

    expect(calls).toEqual(["model-b"]);
    expect(received.at(-1)?.type).toBe("done");
  });

  it("allowlists terminal assistant fields so provider internals never enter emitted errors", async () => {
    const runtime = await createRuntime((model) => {
      const failed = failure(model, "401 invalid_token");
      if (failed.type === "error") {
        Object.assign(failed.error, {
          providerError: new ProviderError({ category: "auth", status: 401 }),
          rawBody: "Authorization: Bearer mock-secret",
          headers: { authorization: "Bearer mock-secret" },
          code: "invalid_token",
          status: 401,
        });
      }
      return fakeStream([failed]);
    });

    const received = await collect(runtime.runtime.stream(
      runtime.runtime.reference("route-main"),
      context(),
      undefined,
    ));
    const serialized = JSON.stringify(received.at(-1));
    expect(serialized).not.toMatch(/mock-secret|authorization|rawBody|providerError/i);
    expect(serialized).not.toContain('"status":401');
  });

  it("latches material output across multiple pi streams in one Agent turn", async () => {
    const calls: string[] = [];
    let toolExecutions = 0;
    let terminal: ProviderError | undefined;
    const runtime = await createRuntime((model) => {
      calls.push(model.id);
      return calls.length === 1
        ? fakeStream([toolEvent("toolcall_start", model), done(model, "")])
        : fakeStream([providerFailure(model, new ProviderError({ category: "network" }))]);
    });
    const continuity: AgentRouteContinuity = { material: false };
    const first = await collect(runtime.runtime.stream(
      runtime.runtime.reference("route-main"),
      context(),
      undefined,
      { continuity },
    ));
    toolExecutions += first.filter((item) => item.type === "toolcall_start").length;
    const second = await collect(runtime.runtime.stream(
      runtime.runtime.reference("route-main"),
      context(),
      undefined,
      {
        continuity,
        onTerminalError: (error) => {
          if (error instanceof ProviderError) terminal = error;
        },
      },
    ));

    expect(toolExecutions).toBe(1);
    expect(continuity.material).toBe(true);
    expect(continuity.lockedBackendId).toBe("backend-a");
    expect(continuity.upstreamModelId).toBe("model-a");
    expect(calls).toEqual(["model-a", "model-a"]);
    expect(second.at(-1)?.type).toBe("error");
    expect(terminal?.visibleOutput).toBe(true);
    expect(terminal?.attempts).toEqual([
      expect.objectContaining({ backendId: "backend-a", visibleOutput: true }),
    ]);
  });

  it("pins later pi streams to the backend that produced material output", async () => {
    const calls: string[] = [];
    let terminal: ProviderError | undefined;
    const runtime = await createRuntime((model) => {
      calls.push(model.id);
      if (calls.length === 1) {
        return fakeStream([failure(model, "insufficient_quota")]);
      }
      if (calls.length === 2) {
        return fakeStream([toolEvent("toolcall_start", model), done(model, "")]);
      }
      return fakeStream([providerFailure(model, new ProviderError({ category: "network" }))]);
    });
    const continuity: AgentRouteContinuity = { material: false };

    await collect(runtime.runtime.stream(
      runtime.runtime.reference("route-main"),
      context(),
      undefined,
      { continuity },
    ));
    expect(calls).toEqual(["model-a", "model-b"]);
    expect(continuity).toEqual({
      material: true,
      lockedBackendId: "backend-b",
      upstreamModelId: "model-b",
    });

    await runtime.runtime.healthStore.reset("backend-a");
    const second = await collect(runtime.runtime.stream(
      runtime.runtime.reference("route-main"),
      context(),
      undefined,
      {
        continuity,
        onTerminalError: (error) => {
          if (error instanceof ProviderError) terminal = error;
        },
      },
    ));

    expect(calls).toEqual(["model-a", "model-b", "model-b"]);
    expect(second.at(-1)?.type).toBe("error");
    expect(terminal?.visibleOutput).toBe(true);
    expect(terminal?.backendId).toBe("backend-b");
    expect(terminal?.attempts).toEqual([
      expect.objectContaining({ backendId: "backend-b", visibleOutput: true }),
    ]);
  });

  it("locks the selected candidate when only the done message contains material", async () => {
    const runtime = await createRuntime((model) => fakeStream([done(model, "done-only")]));
    const continuity: AgentRouteContinuity = { material: false };

    await collect(runtime.runtime.stream(
      runtime.runtime.reference("route-main"),
      context(),
      undefined,
      { continuity },
    ));

    expect(continuity).toEqual({
      material: true,
      lockedBackendId: "backend-a",
      upstreamModelId: "model-a",
    });
  });

  it("keeps the turn latch for synchronous throws, metadata overflow, and next-stream event order", async () => {
    const continuity = {
      material: true,
      lockedBackendId: "backend-a",
      upstreamModelId: "model-a",
    };

    const syncCalls: string[] = [];
    const syncRuntime = await createRuntime((model) => {
      syncCalls.push(model.id);
      throw new Error("network fixture");
    });
    await collect(syncRuntime.runtime.stream(
      syncRuntime.runtime.reference("route-main"),
      context(),
      undefined,
      { continuity },
    ));
    expect(syncCalls).toEqual(["model-a"]);

    const overflowCalls: string[] = [];
    const overflowRuntime = await createRuntime((model) => {
      overflowCalls.push(model.id);
      return fakeStream(Array.from({ length: 33 }, () => event("start", model)));
    });
    await collect(overflowRuntime.runtime.stream(
      overflowRuntime.runtime.reference("route-main"),
      context(),
      undefined,
      { continuity },
    ));
    expect(overflowCalls).toEqual(["model-a"]);

    const orderedRuntime = await createRuntime((model) => fakeStream([
      event("start", model),
      textDelta(model, "next"),
      done(model, "next"),
    ]));
    const ordered = await collect(orderedRuntime.runtime.stream(
      orderedRuntime.runtime.reference("route-main"),
      context(),
      undefined,
      { continuity },
    ));
    expect(ordered.map((item) => item.type)).toEqual(["start", "text_delta", "done"]);
  });
});

describe("isMaterialAgentStreamEvent", () => {
  const model = modelFor("model-a");

  it("uses non-empty deltas and every tool-call phase as the boundary", () => {
    expect(isMaterialAgentStreamEvent(textDelta(model, ""))).toBe(false);
    expect(isMaterialAgentStreamEvent(textDelta(model, "x"))).toBe(true);
    expect(isMaterialAgentStreamEvent(thinkingDelta(model, "x"), true)).toBe(true);
    expect(isMaterialAgentStreamEvent(thinkingDelta(model, "x"), false)).toBe(false);
    expect(isMaterialAgentStreamEvent(toolEvent("toolcall_start", model))).toBe(true);
    expect(isMaterialAgentStreamEvent(toolEvent("toolcall_delta", model))).toBe(true);
    expect(isMaterialAgentStreamEvent(toolEvent("toolcall_end", model))).toBe(true);
  });
});

async function createRuntime(
  invoke: AgentStreamInvoke,
  options: {
    readonly observer?: (event: RoutingEvent) => void;
    readonly credentialKind?: "api_key" | "codex" | "grok_oauth";
    readonly credential?: ResolvedApiKeyCredential | ResolvedCodexCredential | ResolvedGrokOAuthCredential;
    readonly apiFormat?: "chat" | "responses";
    readonly routing?: ModelRoutingConfig;
    readonly sleep?: AgentRouteRuntimeOptions["sleep"];
    readonly policy?: AgentRouteRuntimeOptions["policy"];
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "inkos-agent-route-"));
  roots.push(root);
  const config = options.routing ?? routing(options.credentialKind, options.apiFormat);
  const defaultCredential: ResolvedApiKeyCredential = { kind: "api_key", apiKey: "fixture-key" };
  const credential = options.credential ?? defaultCredential;
  const provider: CredentialProvider = {
    kind: credential.kind,
    resolve: async () => credential,
  };
  const credentials = new CredentialResolver([provider]);
  const runtime = new AgentRouteRuntime({
    routing: config,
    projectRoot: root,
    baseConfig: {
      provider: "openai",
      service: "custom",
      configSource: "studio",
      baseUrl: "https://compat.invalid/v1",
      apiKey: "",
      model: "compat",
      temperature: 0.7,
      thinkingBudget: 0,
      apiFormat: "chat",
      stream: true,
    },
    credentials,
    healthStore: new FileBackendHealthStore(root),
    invoke,
    observer: options.observer,
    sleep: options.sleep,
    policy: options.policy ?? testPolicy(),
  });
  return { root, runtime };
}

function testPolicy(): NonNullable<AgentRouteRuntimeOptions["policy"]> {
  return {
    localRetries: {
      quota: 0,
      rate_limit: 0,
      auth: 0,
      network: 0,
      timeout: 0,
      overloaded: 0,
      model_unavailable: 0,
      invalid_request: 0,
      context_overflow: 0,
      content_policy: 0,
      unknown: 0,
    },
    baseDelayMs: 0,
    maxRetryDelayMs: 0,
    transientCooldownMs: 0,
    rateLimitCooldownMs: 0,
    modelUnavailableCooldownMs: 0,
    maxCooldownMs: 0,
  };
}

function routing(
  credentialKind: "api_key" | "codex" | "grok_oauth" = "api_key",
  apiFormat: "chat" | "responses" = "chat",
): ModelRoutingConfig {
  return {
    version: 1,
    credentials: [
      { id: "credential-a", kind: credentialKind, label: "A", scope: credentialKind === "api_key" ? "project" : "user" },
      { id: "credential-b", kind: credentialKind, label: "B", scope: credentialKind === "api_key" ? "project" : "user" },
    ],
    backends: [
      {
        id: "backend-a",
        displayName: "A",
        service: credentialKind === "codex" ? "openai-codex" : credentialKind === "grok_oauth" ? "xai" : "custom",
        provider: "openai",
        baseUrl: credentialKind === "codex"
          ? "https://chatgpt.com/backend-api"
          : credentialKind === "grok_oauth"
            ? "https://api.x.ai/v1"
            : "https://a.invalid/v1",
        credentialRef: { id: "credential-a", kind: credentialKind },
        enabled: true,
        transport: { apiFormat, stream: true },
      },
      {
        id: "backend-b",
        displayName: "B",
        service: "custom",
        provider: "openai",
        baseUrl: "https://b.invalid/v1",
        credentialRef: { id: "credential-b", kind: credentialKind },
        enabled: true,
        transport: { apiFormat, stream: true },
      },
    ],
    routes: [{
      id: "route-main",
      displayName: "Main",
      promptFamily: credentialKind === "grok_oauth" ? "grok" : "gpt",
      enabled: true,
      candidates: [
        { backendId: "backend-a", upstreamModelId: "model-a" },
        { backendId: "backend-b", upstreamModelId: "model-b" },
      ],
    }],
    defaultRouteId: "route-main",
  };
}

function context(): Context {
  return {
    systemPrompt: "agent role",
    messages: [{ role: "user", content: "hello", timestamp: 1 }],
    tools: [{ name: "read", description: "read", parameters: { type: "object" } as never }],
  };
}

function modelFor(id: string): Model<Api> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "openai",
    baseUrl: "https://fixture.invalid/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 16_000,
    maxTokens: 2_000,
  };
}

function message(model: Model<Api>, content: AssistantMessage["content"] = []): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: usage(),
    stopReason: "stop",
    timestamp: 1,
  };
}

function usage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function event(
  type: "start" | "text_start" | "thinking_start",
  model: Model<Api>,
): AssistantMessageEvent {
  const partial = message(model);
  if (type === "start") return { type, partial };
  return { type, contentIndex: 0, partial };
}

function textDelta(model: Model<Api>, delta: string): AssistantMessageEvent {
  return {
    type: "text_delta",
    contentIndex: 0,
    delta,
    partial: message(model, [{ type: "text", text: delta }]),
  };
}

function thinkingDelta(model: Model<Api>, delta: string): AssistantMessageEvent {
  return {
    type: "thinking_delta",
    contentIndex: 0,
    delta,
    partial: message(model, [{ type: "thinking", thinking: delta }]),
  };
}

function toolEvent(
  type: "toolcall_start" | "toolcall_delta" | "toolcall_end",
  model: Model<Api>,
): AssistantMessageEvent {
  const toolCall = { type: "toolCall" as const, id: "call-1", name: "read", arguments: { path: "safe.txt" } };
  const partial = message(model, [toolCall]);
  if (type === "toolcall_start") return { type, contentIndex: 0, partial };
  if (type === "toolcall_delta") return { type, contentIndex: 0, delta: "{\"path\":", partial };
  return { type, contentIndex: 0, toolCall, partial };
}

function done(model: Model<Api>, text: string): AssistantMessageEvent {
  return {
    type: "done",
    reason: "stop",
    message: message(model, text ? [{ type: "text", text }] : []),
  };
}

function failure(model: Model<Api>, errorMessage: string): AssistantMessageEvent {
  return {
    type: "error",
    reason: "error",
    error: { ...message(model), stopReason: "error", errorMessage },
  };
}

function providerFailure(model: Model<Api>, error: ProviderError): AssistantMessageEvent {
  const failed = failure(model, error.safeMessage);
  (failed as Extract<AssistantMessageEvent, { type: "error" }>).error = Object.assign(
    failed.type === "error" ? failed.error : message(model),
    { providerError: error },
  );
  return failed;
}

function fakeStream(events: ReadonlyArray<AssistantMessageEvent>): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    for (const item of events) stream.push(item);
    const terminal = events.at(-1);
    stream.end(
      terminal?.type === "done"
        ? terminal.message
        : terminal?.type === "error"
          ? terminal.error
          : undefined,
    );
  });
  return stream;
}

async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const item of stream) events.push(item);
  return events;
}
