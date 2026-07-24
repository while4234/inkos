import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileBackendHealthStore } from "../llm/backend-health-store.js";
import {
  CredentialResolver,
  type ResolvedCodexCredential,
  type ResolvedGrokOAuthCredential,
} from "../llm/credentials/index.js";
import type { ModelRoutingConfig } from "../llm/model-routing.js";
import type { PromptFamily } from "../llm/model-routing.js";
import {
  MODEL_GLOBAL_PROMPT_ASSETS,
  applyModelGlobalPromptToLLMMessages,
  countModelGlobalPromptMarkers,
} from "../llm/model-global-prompt.js";
import { classifyProviderError, ProviderError } from "../llm/provider-error.js";
import { chatCompletion, type LLMClient } from "../llm/provider.js";
import { requestCodexResponses } from "../llm/codex-responses-transport.js";
import {
  ResilientChatRuntime,
  RouteExhaustedError,
} from "../llm/resilient-client.js";
import type { RoutingEvent } from "../llm/routing-trace.js";
import { LLMConfigSchema } from "../models/project.js";

interface MockRequest {
  readonly body: Record<string, unknown>;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

interface MockBackend {
  readonly baseUrl: string;
  readonly requests: MockRequest[];
  close(): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("ResilientChatRuntime", () => {
  it("keeps the legacy chatCompletion signature and one request for a healthy single candidate", async () => {
    const backendA = await createMockBackend((_request, response) => sendCompletion(response, "single", 3));
    const backendB = await createMockBackend((_request, response) => sendCompletion(response, "unused", 1));
    const { runtime } = await createRuntime(backendA, backendB, { singleCandidate: true });
    const compatibilityClient = {
      provider: "openai",
      apiFormat: "chat",
      stream: false,
      defaults: {
        temperature: 0.7,
        maxTokens: 1024,
        thinkingBudget: 0,
        extra: {},
      },
    } satisfies LLMClient;
    const routeClient = runtime.createRouteClient("route-main", compatibilityClient);

    const response = await chatCompletion(
      routeClient,
      "legacy-model-name",
      [{ role: "user", content: "single candidate" }],
    );

    expect(response).toEqual({
      content: "single",
      usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
    });
    expect(backendA.requests).toHaveLength(1);
    expect(backendB.requests).toHaveLength(0);
  });

  it("fails over A→B on quota, persists the skip, and restores A only after reset", async () => {
    let aHealthy = false;
    const backendA = await createMockBackend((_request, response) => {
      if (!aHealthy) {
        sendJson(response, 402, {
          error: {
            code: "insufficient_quota",
            message: "quota exhausted",
          },
        });
        return;
      }
      sendCompletion(response, "from-a", 5);
    });
    const backendB = await createMockBackend((_request, response) => {
      sendCompletion(response, "from-b", 7);
    });
    const { runtime, healthStore } = await createRuntime(backendA, backendB);
    const events: RoutingEvent[] = [];
    const observed = await createRuntime(backendA, backendB, {
      healthStore,
      observer: (event) => events.push(event),
    });
    const messages = [
      { role: "system" as const, content: "keep context" },
      { role: "user" as const, content: "write chapter" },
    ];
    const original = structuredClone(messages);

    const first = await observed.runtime.complete("route-main", messages, {
      temperature: 0.25,
      maxTokens: 321,
    });
    expect(first).toEqual({
      content: "from-b",
      usage: { promptTokens: 7, completionTokens: 2, totalTokens: 9 },
    });
    expect(messages).toEqual(original);
    expect(backendA.requests).toHaveLength(1);
    expect(backendB.requests).toHaveLength(1);
    expect(backendA.requests[0]?.body).toMatchObject({
      model: "model-a",
      messages: [
        {
          role: "system",
          content: expect.stringMatching(
            /^<!-- inkos:model-global-prompt[\s\S]*\n\nkeep context$/,
          ),
        },
        original[1],
      ],
      temperature: 0.25,
      max_tokens: 321,
    });
    expect(backendB.requests[0]?.body).toMatchObject({
      model: "model-b",
      messages: [
        {
          role: "system",
          content: expect.stringMatching(
            /^<!-- inkos:model-global-prompt[\s\S]*\n\nkeep context$/,
          ),
        },
        original[1],
      ],
      temperature: 0.25,
      max_tokens: 321,
    });
    expect(backendA.requests[0]?.headers.authorization).toMatch(/^Bearer /);
    expect(backendB.requests[0]?.headers.authorization).toMatch(/^Bearer /);

    const healthAfterFirst = await healthStore.read();
    expect(healthAfterFirst.backends["backend-a"]).toMatchObject({
      status: "quota_exhausted",
      consecutiveFailures: 1,
    });
    expect(healthAfterFirst.routes["route-main"]?.activeBackendId).toBe("backend-b");

    const second = await runtime.complete("route-main", messages);
    expect(second.content).toBe("from-b");
    expect(backendA.requests).toHaveLength(1);
    expect(backendB.requests).toHaveLength(2);

    aHealthy = true;
    await runtime.resetBackend("backend-a");
    const third = await runtime.complete("route-main", messages);
    expect(third.content).toBe("from-a");
    expect(backendA.requests).toHaveLength(2);
    expect(backendB.requests).toHaveLength(2);

    expect(events.map((event) => event.type)).toEqual([
      "attempt_started",
      "failed",
      "backend_switched",
      "attempt_started",
      "succeeded",
    ]);
    expect(events[2]).toMatchObject({
      logicalModelId: "route-main",
      fromBackendId: "backend-a",
      toBackendId: "backend-b",
      reason: "quota",
    });
  });

  it("reuses one route prompt family/revision across A→B failover and traces metadata only", async () => {
    const backendA = await createMockBackend((_request, response) => {
      sendJson(response, 402, {
        error: { code: "insufficient_quota", message: "quota exhausted" },
      });
    });
    const backendB = await createMockBackend((_request, response) => {
      sendCompletion(response, "from-b", 7);
    });
    const events: RoutingEvent[] = [];
    const { runtime } = await createRuntime(backendA, backendB, {
      promptFamily: "gpt",
      observer: (event) => events.push(event),
    });
    const messages = [
      { role: "system" as const, content: "role prompt\n\nproject prompt pack" },
      { role: "user" as const, content: "write chapter" },
    ];
    const original = structuredClone(messages);

    await runtime.complete("route-main", messages);

    const firstMessages = backendA.requests[0]?.body.messages;
    const secondMessages = backendB.requests[0]?.body.messages;
    expect(secondMessages).toEqual(firstMessages);
    expect(firstMessages).toEqual([
      {
        role: "system",
        content: expect.stringMatching(
          /^<!-- inkos:model-global-prompt[\s\S]*\n\nrole prompt\n\nproject prompt pack$/,
        ),
      },
      { role: "user", content: "write chapter" },
    ]);
    const system = String((firstMessages as Array<{ content: string }>)[0]?.content);
    expect(countModelGlobalPromptMarkers(system)).toBe(1);
    expect(messages).toEqual(original);
    expect(events).not.toHaveLength(0);
    for (const event of events) {
      expect(event.modelGlobalPrompt).toEqual({
        family: "gpt",
        assetId: "inkos:model-global-prompt:gpt",
        revision: 1,
        enabled: true,
        source: "explicit",
      });
      expect(JSON.stringify(event)).not.toContain(MODEL_GLOBAL_PROMPT_ASSETS.gpt.text);
    }
  });

  it("uses bounded local retries and injectable time before switching", async () => {
    const backendA = await createMockBackend((_request, response) => sendCompletion(response, "unused", 1));
    const backendB = await createMockBackend((_request, response) => sendCompletion(response, "unused", 1));
    const waits: number[] = [];
    const calls: string[] = [];
    const { runtime } = await createRuntime(backendA, backendB, {
      sleep: async (delayMs) => {
        waits.push(delayMs);
      },
      invoke: async (client) => {
        calls.push(client._routingBackendId!);
        if (client._routingBackendId === "backend-a") {
          throw classifyProviderError({
            status: 429,
            headers: new Headers({ "retry-after": "10" }),
          }, { now: 0 });
        }
        return {
          content: "recovered",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
    });

    const response = await runtime.complete(
      "route-main",
      [{ role: "user", content: "same request" }],
    );

    expect(response.content).toBe("recovered");
    expect(calls).toEqual(["backend-a", "backend-a", "backend-b"]);
    expect(waits).toEqual([5_000]);
  });

  it("does not switch conservative errors or cancellation", async () => {
    const sources = [
      { status: 400 },
      { code: "context_length_exceeded" },
      { code: "content_policy_violation" },
      new Error("opaque failure"),
      new DOMException("cancelled", "AbortError"),
    ];

    for (const source of sources) {
      const backendA = await createMockBackend((_request, response) => sendCompletion(response, "unused", 1));
      const backendB = await createMockBackend((_request, response) => sendCompletion(response, "unused", 1));
      const calls: string[] = [];
      const { runtime } = await createRuntime(backendA, backendB, {
        invoke: async (client) => {
          calls.push(client._routingBackendId!);
          throw source;
        },
      });

      await expect(runtime.complete(
        "route-main",
        [{ role: "user", content: "do not switch" }],
      )).rejects.toBeInstanceOf(ProviderError);
      expect(calls).toEqual(["backend-a"]);
    }
  });

  it("returns structured cancellation before resolving or calling a backend", async () => {
    const backendA = await createMockBackend((_request, response) => sendCompletion(response, "unused", 1));
    const backendB = await createMockBackend((_request, response) => sendCompletion(response, "unused", 1));
    const calls: string[] = [];
    const { runtime } = await createRuntime(backendA, backendB, {
      invoke: async (client) => {
        calls.push(client._routingBackendId!);
        throw new Error("should not run");
      },
    });
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));

    const failure = await captureFailure(runtime.complete(
      "route-main",
      [{ role: "user", content: "cancelled" }],
      { signal: controller.signal },
    ));

    expect(failure).toBeInstanceOf(ProviderError);
    expect(failure).toMatchObject({ cancelled: true, logicalModelId: "route-main" });
    expect(calls).toHaveLength(0);
  });

  it("returns a secret-safe ordered aggregate when every candidate fails", async () => {
    const backendA = await createMockBackend((_request, response) => sendCompletion(response, "unused", 1));
    const backendB = await createMockBackend((_request, response) => sendCompletion(response, "unused", 1));
    const rawSecret = "sk-fixture-never-print-this-value";
    const { runtime } = await createRuntime(backendA, backendB, {
      invoke: async (client) => {
        if (client._routingBackendId === "backend-a") {
          throw {
            status: 402,
            error: { code: "insufficient_quota", message: `Authorization: Bearer ${rawSecret}` },
          };
        }
        throw {
          status: 401,
          error: { code: "invalid_api_key", message: `api_key=${rawSecret}` },
        };
      },
    });

    const error = await captureFailure(runtime.complete(
      "route-main",
      [{ role: "user", content: "all fail" }],
    ));

    expect(error).toBeInstanceOf(RouteExhaustedError);
    const aggregate = error as RouteExhaustedError;
    expect(aggregate.attempts.map((attempt) => ({
      backendId: attempt.backendId,
      attemptNumber: attempt.attemptNumber,
      category: attempt.category,
    }))).toEqual([
      { backendId: "backend-a", attemptNumber: 1, category: "quota" },
      { backendId: "backend-b", attemptNumber: 1, category: "auth" },
    ]);
    const safe = JSON.stringify(aggregate);
    expect(safe).not.toContain(rawSecret);
    expect(safe).not.toContain("Authorization");
    expect(safe).not.toContain("Bearer");
  });

  it("switches before the first text delta but never after visible output", async () => {
    const backendA = await createMockBackend((_request, response) => {
      sendJson(response, 402, {
        error: { code: "insufficient_quota", message: "quota exhausted" },
      });
    });
    const backendB = await createMockBackend((_request, response) => {
      sendStream(response, ["B"]);
    });
    const beforeOutput = await createRuntime(backendA, backendB, { stream: true });
    const deltas: string[] = [];
    const success = await beforeOutput.runtime.complete(
      "route-main",
      [{ role: "user", content: "stream" }],
      { onTextDelta: (text) => deltas.push(text) },
    );
    expect(success.content).toBe("B");
    expect(deltas).toEqual(["B"]);
    expect(backendB.requests).toHaveLength(1);

    const visibleA = await createMockBackend((_request, response) => {
      sendInterruptedStream(response, "A");
    });
    const neverB = await createMockBackend((_request, response) => {
      sendStream(response, ["B"]);
    });
    const afterOutput = await createRuntime(visibleA, neverB, { stream: true });
    const visibleDeltas: string[] = [];
    const failure = await captureFailure(afterOutput.runtime.complete(
      "route-main",
      [{ role: "user", content: "stream" }],
      { onTextDelta: (text) => visibleDeltas.push(text) },
    ));
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).visibleOutput).toBe(true);
    expect((failure as ProviderError).attempts).toEqual([
      expect.objectContaining({
        backendId: "backend-a",
        logicalModelId: "route-main",
        upstreamModelId: "model-a",
        attemptNumber: 1,
        visibleOutput: true,
      }),
    ]);
    expect(visibleDeltas).toEqual(["A"]);
    expect(neverB.requests).toHaveLength(0);
  });

  it("clones messages for each attempt and never mutates caller input", async () => {
    const backendA = await createMockBackend((_request, response) => sendCompletion(response, "unused", 1));
    const backendB = await createMockBackend((_request, response) => sendCompletion(response, "unused", 1));
    const seen: string[][] = [];
    const { runtime } = await createRuntime(backendA, backendB, {
      invoke: async (client, _model, messages) => {
        seen.push(messages.map((message) => message.content));
        if (client._routingBackendId === "backend-a") {
          (messages[0] as { content: string }).content = "mutated by backend A";
          throw { status: 402, error: { code: "insufficient_quota" } };
        }
        return {
          content: "ok",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
    });
    const messages = [{ role: "user" as const, content: "immutable" }];

    await runtime.complete("route-main", messages);

    expect(seen).toEqual([["immutable"], ["immutable"]]);
    expect(messages).toEqual([{ role: "user", content: "immutable" }]);
  });

  it("refreshes once on Codex auth failure, retries that backend, then marks auth_required and fails over", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "inkos-codex-route-"));
    cleanups.push(() => rm(projectRoot, { recursive: true, force: true }));
    const routing: ModelRoutingConfig = {
      version: 1,
      credentials: [
        { id: "credential-codex", kind: "codex", label: "Codex", scope: "user" },
        { id: "credential-api", kind: "api_key", label: "API", scope: "project" },
      ],
      backends: [
        {
          id: "backend-codex",
          displayName: "Codex",
          service: "codex",
          provider: "openai",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          credentialRef: { id: "credential-codex", kind: "codex" },
          enabled: true,
          transport: { apiFormat: "responses", stream: true },
        },
        {
          id: "backend-api",
          displayName: "API",
          service: "custom",
          provider: "custom",
          baseUrl: "https://api.example.test/v1",
          credentialRef: { id: "credential-api", kind: "api_key" },
          enabled: true,
          transport: { apiFormat: "chat", stream: false },
        },
      ],
      routes: [{
        id: "route-main",
        displayName: "Main",
        promptFamily: "gpt",
        enabled: true,
        candidates: [
          { backendId: "backend-codex", upstreamModelId: "gpt-codex" },
          { backendId: "backend-api", upstreamModelId: "gpt-backup" },
        ],
      }],
      modelGlobalPrompts: {},
      defaultRouteId: "route-main",
    };
    let refreshes = 0;
    let codexRequests = 0;
    const refreshedCredential: ResolvedCodexCredential = {
      kind: "codex" as const,
      accessToken: "runtime-only-refreshed",
      refresh: async () => {
        refreshes += 1;
        return refreshedCredential;
      },
    };
    const credentials = new CredentialResolver([
      {
        kind: "codex",
        resolve: async () => ({
          kind: "codex",
          accessToken: "runtime-only",
          refresh: async () => {
            refreshes += 1;
            return refreshedCredential;
          },
        }),
      },
      {
        kind: "api_key",
        resolve: async () => ({ kind: "api_key", apiKey: "runtime-only" }),
      },
    ]);
    const seen = new Map<string, {
      readonly markerCount: number;
      readonly revision: string | number | undefined;
      readonly businessMessage: string | undefined;
    }>();
    const events: RoutingEvent[] = [];
    const runtime = new ResilientChatRuntime({
      routing,
      projectRoot,
      credentials,
      baseConfig: LLMConfigSchema.parse({
        provider: "custom",
        service: "custom",
        baseUrl: "https://api.example.test/v1",
        apiKey: "",
        model: "legacy",
        routing,
      }),
      observer: (event) => {
        events.push(event);
      },
      invoke: async (client, _model, messages, options) => {
        const applied = applyModelGlobalPromptToLLMMessages(
          messages,
          options?._modelGlobalPromptResolution!,
        ).messages;
        seen.set(client._routingBackendId!, {
          markerCount: countModelGlobalPromptMarkers(
            applied.map((message) => message.content).join("\n"),
          ),
          revision: options?._modelGlobalPromptResolution?.revision,
          businessMessage: applied.find((message) => message.role === "user")?.content,
        });
        if (client._routingBackendId === "backend-codex") {
          return requestCodexResponses({
            model: "gpt-codex",
            messages: applied,
            credential: client._codexCredential!,
            errorContext: options?.errorContext,
            fetch: async () => {
              codexRequests += 1;
              return new Response("{}", {
                status: codexRequests === 1 ? 401 : 403,
              });
            },
          });
        }
        return {
          content: "backup",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
    });

    const response = await runtime.complete(
      "route-main",
      [{ role: "user", content: "same business request" }],
    );
    expect(response.content).toBe("backup");
    expect(codexRequests).toBe(2);
    expect(refreshes).toBe(1);
    expect(seen.get("backend-codex")).toMatchObject({
      markerCount: 1,
      businessMessage: "same business request",
    });
    expect(seen.get("backend-api")).toEqual(seen.get("backend-codex"));
    expect((await runtime.healthStore.read()).backends["backend-codex"]?.status)
      .toBe("auth_required");
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "backend_switched",
        fromBackendId: "backend-codex",
        toBackendId: "backend-api",
        reason: "auth",
      }),
    ]));
  });

  it("routes Grok OAuth through one prompt injection, one auth refresh, and structured failover", async () => {
    let grokRequests = 0;
    const grokBackend = await createMockBackend((request, response) => {
      grokRequests += 1;
      expect(request.headers.authorization).toBe(
        grokRequests === 1 ? "Bearer grok-before" : "Bearer grok-after",
      );
      sendJson(response, grokRequests === 1 ? 401 : 403, {
        error: { code: "invalid_token", message: "fixture auth failure" },
      });
    });
    const backup = await createMockBackend((_request, response) =>
      sendCompletion(response, "backup", 2));
    const projectRoot = await mkdtemp(join(tmpdir(), "inkos-grok-route-"));
    cleanups.push(() => rm(projectRoot, { recursive: true, force: true }));
    let refreshes = 0;
    const refreshed: ResolvedGrokOAuthCredential = {
      kind: "grok_oauth",
      accessToken: "grok-after",
      expiresAt: "2099-01-01T00:00:00.000Z",
      refresh: async () => {
        refreshes += 1;
        return refreshed;
      },
      markAuthRequired: async () => undefined,
    };
    const credentials = new CredentialResolver([
      {
        kind: "grok_oauth",
        resolve: async () => ({
          kind: "grok_oauth",
          accessToken: "grok-before",
          expiresAt: "2099-01-01T00:00:00.000Z",
          refresh: async () => {
            refreshes += 1;
            return refreshed;
          },
          markAuthRequired: async () => undefined,
        }),
      },
      {
        kind: "api_key",
        resolve: async () => ({ kind: "api_key", apiKey: "backup-key" }),
      },
    ]);
    const routing: ModelRoutingConfig = {
      version: 1,
      credentials: [
        { id: "credential-grok", kind: "grok_oauth", label: "Grok", scope: "user" },
        { id: "credential-api", kind: "api_key", label: "Backup", scope: "project" },
      ],
      backends: [
        {
          id: "backend-grok",
          displayName: "Grok",
          service: "xai",
          provider: "openai",
          baseUrl: grokBackend.baseUrl,
          credentialRef: { id: "credential-grok", kind: "grok_oauth" },
          enabled: true,
          transport: { apiFormat: "chat", stream: true },
        },
        {
          id: "backend-api",
          displayName: "Backup",
          service: "custom",
          provider: "custom",
          baseUrl: backup.baseUrl,
          credentialRef: { id: "credential-api", kind: "api_key" },
          enabled: true,
          transport: { apiFormat: "chat", stream: false },
        },
      ],
      routes: [{
        id: "route-main",
        displayName: "Grok writing",
        promptFamily: "grok",
        enabled: true,
        candidates: [
          { backendId: "backend-grok", upstreamModelId: "grok-4" },
          { backendId: "backend-api", upstreamModelId: "backup-model" },
        ],
      }],
      modelGlobalPrompts: {},
      defaultRouteId: "route-main",
    };
    const events: RoutingEvent[] = [];
    const runtime = new ResilientChatRuntime({
      routing,
      projectRoot,
      credentials,
      baseConfig: LLMConfigSchema.parse({
        provider: "custom",
        service: "custom",
        baseUrl: backup.baseUrl,
        apiKey: "",
        model: "legacy",
        routing,
      }),
      observer: (event) => {
        events.push(event);
      },
    });

    const result = await runtime.complete(
      "route-main",
      [
        { role: "assistant", content: "ordinary assistant text" },
        { role: "user", content: "same business request" },
      ],
    );

    expect(result.content).toBe("backup");
    expect(grokRequests).toBe(2);
    expect(refreshes).toBe(1);
    expect(grokBackend.requests).toHaveLength(2);
    const grokMessages = grokBackend.requests[0]?.body.messages as Array<{
      readonly role: string;
      readonly content: string;
    }>;
    expect(countModelGlobalPromptMarkers(
      grokMessages.map((message) => message.content).join("\n"),
    )).toBe(1);
    expect(grokMessages).toEqual(expect.arrayContaining([
      { role: "assistant", content: "ordinary assistant text" },
      { role: "user", content: "same business request" },
    ]));
    expect((await runtime.healthStore.read()).backends["backend-grok"]?.status)
      .toBe("auth_required");
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "backend_switched",
        fromBackendId: "backend-grok",
        toBackendId: "backend-api",
        reason: "auth",
      }),
    ]));
  });
});

async function createRuntime(
  backendA: MockBackend,
  backendB: MockBackend,
  options: {
    readonly healthStore?: FileBackendHealthStore;
    readonly observer?: (event: RoutingEvent) => void;
    readonly sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
    readonly invoke?: ConstructorParameters<typeof ResilientChatRuntime>[0]["invoke"];
    readonly stream?: boolean;
    readonly singleCandidate?: boolean;
    readonly promptFamily?: PromptFamily;
  } = {},
): Promise<{ runtime: ResilientChatRuntime; healthStore: FileBackendHealthStore }> {
  const projectRoot = await mkdtemp(join(tmpdir(), "inkos-resilient-runtime-"));
  cleanups.push(() => rm(projectRoot, { recursive: true, force: true }));
  const healthStore = options.healthStore ?? new FileBackendHealthStore(projectRoot);
  const routing = createRouting(
    backendA.baseUrl,
    backendB.baseUrl,
    options.stream ?? false,
    options.singleCandidate ?? false,
    options.promptFamily ?? "generic",
  );
  const credentials = new CredentialResolver([{
    kind: "api_key" as const,
    resolve: async (ref) => ({
      kind: "api_key" as const,
      apiKey: `fixture-${ref.id}`,
    }),
  }]);
  const baseConfig = LLMConfigSchema.parse({
    provider: "custom",
    service: "custom",
    configSource: "env",
    baseUrl: backendA.baseUrl,
    apiKey: "",
    model: "legacy-model",
    stream: options.stream ?? false,
    routing,
  });
  const runtime = new ResilientChatRuntime({
    routing,
    projectRoot,
    baseConfig,
    credentials,
    healthStore,
    observer: options.observer,
    sleep: options.sleep,
    invoke: options.invoke,
  });
  return { runtime, healthStore };
}

function createRouting(
  baseUrlA: string,
  baseUrlB: string,
  stream: boolean,
  singleCandidate: boolean,
  promptFamily: PromptFamily,
): ModelRoutingConfig {
  return {
    version: 1,
    credentials: [
      { id: "credential-a", kind: "api_key", label: "A", scope: "project" },
      { id: "credential-b", kind: "api_key", label: "B", scope: "project" },
    ],
    backends: [
      {
        id: "backend-a",
        displayName: "Backend A",
        service: "custom-a",
        provider: "custom",
        baseUrl: baseUrlA,
        credentialRef: { id: "credential-a", kind: "api_key" },
        enabled: true,
        transport: { apiFormat: "chat", stream },
      },
      {
        id: "backend-b",
        displayName: "Backend B",
        service: "custom-b",
        provider: "custom",
        baseUrl: baseUrlB,
        credentialRef: { id: "credential-b", kind: "api_key" },
        enabled: true,
        transport: { apiFormat: "chat", stream },
      },
    ],
    routes: [{
      id: "route-main",
      displayName: "Main",
      promptFamily,
      enabled: true,
      candidates: singleCandidate
        ? [{ backendId: "backend-a", upstreamModelId: "model-a" }]
        : [
            { backendId: "backend-a", upstreamModelId: "model-a" },
            { backendId: "backend-b", upstreamModelId: "model-b" },
          ],
    }],
    modelGlobalPrompts: {},
    defaultRouteId: "route-main",
  };
}

async function createMockBackend(
  handler: (request: MockRequest, response: ServerResponse) => void,
): Promise<MockBackend> {
  const requests: MockRequest[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf-8");
      const body = bodyText ? JSON.parse(bodyText) as Record<string, unknown> : {};
      const received = { body, headers: request.headers };
      requests.push(received);
      handler(received, response);
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address() as AddressInfo;
  const backend = {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    }),
  };
  cleanups.push(backend.close);
  return backend;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function sendCompletion(response: ServerResponse, content: string, promptTokens: number): void {
  sendJson(response, 200, {
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: 2,
      total_tokens: promptTokens + 2,
    },
  });
}

function sendStream(response: ServerResponse, deltas: readonly string[]): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const delta of deltas) {
    response.write(`data: ${JSON.stringify({
      choices: [{ delta: { content: delta }, finish_reason: null }],
    })}\n\n`);
  }
  response.write(`data: ${JSON.stringify({
    choices: [{ delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })}\n\n`);
  response.end("data: [DONE]\n\n");
}

function sendInterruptedStream(response: ServerResponse, delta: string): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(`data: ${JSON.stringify({
    choices: [{ delta: { content: delta }, finish_reason: null }],
  })}\n\n`);
}

async function captureFailure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    throw new Error("Expected operation to fail.");
  } catch (error) {
    return error;
  }
}
