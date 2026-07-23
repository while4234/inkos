import { describe, expect, it, vi } from "vitest";
import {
  buildGrokChatPayload,
  normalizeGrokChatUrl,
  requestGrokChatCompletion,
} from "../llm/grok-chat-transport.js";
import type { ResolvedGrokOAuthCredential } from "../llm/credentials/grok-oauth.js";

describe("Grok OAuth chat transport", () => {
  it("centralizes bearer auth, model payload, streaming text, and usage", async () => {
    let captured: { readonly url: string; readonly init?: RequestInit } | undefined;
    const result = await requestGrokChatCompletion({
      baseUrl: "https://api.x.ai/v1",
      model: "grok-4",
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "hello" },
      ],
      credential: credential("bearer-token"),
      temperature: 0.4,
      maxTokens: 123,
      fetch: vi.fn(async (
        url: Parameters<typeof globalThis.fetch>[0],
        init?: RequestInit,
      ) => {
        captured = { url: url.toString(), init };
        return streamResponse([
          { choices: [{ delta: { content: "hel" }, finish_reason: null }] },
          {
            choices: [{ delta: { content: "lo" }, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 2,
              completion_tokens: 1,
              total_tokens: 3,
            },
          },
          "[DONE]",
        ]);
      }),
    });
    expect(captured?.url).toBe("https://api.x.ai/v1/chat/completions");
    expect(new Headers(captured?.init?.headers).get("Authorization"))
      .toBe("Bearer bearer-token");
    expect(JSON.parse(String(captured?.init?.body))).toMatchObject({
      model: "grok-4",
      stream: true,
      temperature: 0.4,
      max_tokens: 123,
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "hello" },
      ],
    });
    expect(result).toEqual({
      content: "hello",
      usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
    });
  });

  it("force-refreshes once for 401/403 and never loops", async () => {
    let calls = 0;
    let refreshes = 0;
    let marked = 0;
    const initial = credential("old-token", async () => {
      refreshes += 1;
      return credential("new-token", undefined, async () => {
        marked += 1;
      });
    });
    await expect(requestGrokChatCompletion({
      model: "grok-4",
      messages: [{ role: "user", content: "hello" }],
      credential: initial,
      fetch: vi.fn(async () => {
        calls += 1;
        return new Response("", { status: calls === 1 ? 401 : 403 });
      }),
    })).rejects.toMatchObject({ category: "auth" });
    expect(calls).toBe(2);
    expect(refreshes).toBe(1);
    expect(marked).toBe(1);
  });

  it("marks auth_required when a forced refresh fails", async () => {
    let marked = 0;
    const rejected = credential(
      "old-token",
      async () => {
        throw new Error("fixture refresh unavailable");
      },
      async () => {
        marked += 1;
      },
    );
    await expect(requestGrokChatCompletion({
      model: "grok-4",
      messages: [{ role: "user", content: "hello" }],
      credential: rejected,
      fetch: vi.fn(async () => new Response("", { status: 401 })),
    })).rejects.toMatchObject({ category: "auth" });
    expect(marked).toBe(1);
  });

  it("preserves a visible-output partial failure for route failover safety", async () => {
    const deltas: string[] = [];
    await expect(requestGrokChatCompletion({
      model: "grok-4",
      messages: [{ role: "user", content: "hello" }],
      credential: credential("token"),
      onTextDelta: (delta) => deltas.push(delta),
      fetch: vi.fn(async () => streamResponse([
        { choices: [{ delta: { content: "partial" }, finish_reason: null }] },
      ], false)),
    })).rejects.toMatchObject({ visibleOutput: true });
    expect(deltas).toEqual(["partial"]);
  });

  it("normalizes endpoints and prevents caller override of protected fields", () => {
    expect(normalizeGrokChatUrl("https://example.test"))
      .toBe("https://example.test/v1/chat/completions");
    expect(buildGrokChatPayload({
      model: "grok-4",
      messages: [{ role: "user", content: "safe" }],
      extra: {
        model: "attacker-model",
        messages: [{ role: "user", content: "attacker" }],
        stream: false,
        custom: "allowed",
      },
    })).toMatchObject({
      model: "grok-4",
      messages: [{ role: "user", content: "safe" }],
      stream: true,
      custom: "allowed",
    });
  });

  it("propagates cancellation without retrying or refreshing", async () => {
    const controller = new AbortController();
    controller.abort(new Error("fixture cancelled"));
    const refresh = vi.fn(async () => credential("unused"));
    await expect(requestGrokChatCompletion({
      model: "grok-4",
      messages: [{ role: "user", content: "hello" }],
      credential: credential("token", refresh),
      signal: controller.signal,
      fetch: vi.fn(),
    })).rejects.toThrow("fixture cancelled");
    expect(refresh).not.toHaveBeenCalled();
  });
});

function credential(
  accessToken: string,
  refresh?: ResolvedGrokOAuthCredential["refresh"],
  markAuthRequired: ResolvedGrokOAuthCredential["markAuthRequired"] = async () => undefined,
): ResolvedGrokOAuthCredential {
  return {
    kind: "grok_oauth",
    accessToken,
    expiresAt: "2026-07-24T01:00:00.000Z",
    refresh: refresh ?? (async () => credential(accessToken)),
    markAuthRequired,
  };
}

function streamResponse(
  events: ReadonlyArray<unknown>,
  terminal = true,
): Response {
  const body = events
    .map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(terminal ? body : body.replace(/data: \[DONE\]\n\n$/u, ""), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}
