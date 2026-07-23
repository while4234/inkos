import { describe, expect, it } from "vitest";
import {
  buildCodexResponsesPayload,
  normalizeCodexResponsesUrl,
  requestCodexResponses,
} from "../llm/codex-responses-transport.js";
import { ProviderError } from "../llm/provider-error.js";
import type { ResolvedCodexCredential } from "../llm/credentials/codex-auth.js";

describe("Codex Responses transport", () => {
  it("normalizes backend paths and strips fields rejected by Codex", () => {
    expect(normalizeCodexResponsesUrl("https://example.test/backend-api/codex/v1"))
      .toBe("https://example.test/backend-api/codex/responses");
    expect(normalizeCodexResponsesUrl("https://example.test/backend-api/codex/v1/responses"))
      .toBe("https://example.test/backend-api/codex/responses");
    expect(buildCodexResponsesPayload({
      model: "gpt-fixture",
      messages: [
        { role: "system", content: "global" },
        { role: "user", content: "hello" },
      ],
      extra: { temperature: 1, max_output_tokens: 8, reasoning: { effort: "medium" } },
    })).toEqual({
      model: "gpt-fixture",
      instructions: "global",
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      }],
      reasoning: { effort: "medium" },
      store: false,
      stream: true,
    });
  });

  it("sends safe required headers, collects an SSE-only response, and maps usage", async () => {
    let captured: { readonly url: string; readonly init?: RequestInit } | undefined;
    const credential = codexCredential();
    const result = await requestCodexResponses({
      baseUrl: "https://example.test/backend-api/codex/v1",
      model: "gpt-fixture",
      messages: [{ role: "user", content: "hello" }],
      credential,
      requestId: () => "request-fixture",
      fetch: async (url, init) => {
        captured = { url: url.toString(), init };
        return sseResponse([
          { type: "response.output_text.delta", delta: "safe " },
          { type: "response.output_text.delta", delta: "answer" },
          {
            type: "response.completed",
            response: {
              usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
            },
          },
        ]);
      },
    });
    expect(captured?.url).toBe("https://example.test/backend-api/codex/responses");
    const headers = new Headers(captured?.init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${credential.accessToken}`);
    expect(headers.get("chatgpt-account-id")).toBe("account-fixture");
    expect(headers.get("accept")).toBe("text/event-stream");
    expect(headers.get("originator")).toBe("codex_vscode");
    expect(headers.get("x-client-request-id")).toBe("request-fixture");
    expect(result).toEqual({
      content: "safe answer",
      usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
    });
  });

  it("processes the final SSE record when the stream closes without a blank delimiter", async () => {
    const completed = JSON.stringify({
      type: "response.completed",
      response: {
        output: [{
          content: [{ type: "output_text", text: "final answer" }],
        }],
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    });
    const result = await requestCodexResponses({
      model: "gpt-fixture",
      messages: [{ role: "user", content: "hello" }],
      credential: codexCredential(),
      fetch: async () => new Response(`data: ${completed}`, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    });

    expect(result).toEqual({
      content: "final answer",
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    });
  });

  it("force-refreshes at most once for 401/403 and returns auth after a second rejection", async () => {
    let requests = 0;
    let refreshes = 0;
    const credential = codexCredential(async () => {
      refreshes += 1;
      return codexCredential();
    });
    await expect(requestCodexResponses({
      model: "gpt-fixture",
      messages: [{ role: "user", content: "hello" }],
      credential,
      fetch: async () => {
        requests += 1;
        return new Response("{}", { status: requests === 1 ? 401 : 403 });
      },
    })).rejects.toMatchObject({
      category: "auth",
      status: 403,
    } satisfies Partial<ProviderError>);
    expect(refreshes).toBe(1);
    expect(requests).toBe(2);
  });

  it("maps cancellation and partial streams without leaking request credentials", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(requestCodexResponses({
      model: "gpt-fixture",
      messages: [{ role: "user", content: "hello" }],
      credential: codexCredential(),
      signal: controller.signal,
      fetch: async () => {
        throw new Error("must not fetch");
      },
    })).rejects.toMatchObject({ name: "AbortError" });

    const error = await requestCodexResponses({
      model: "gpt-fixture",
      messages: [{ role: "user", content: "hello" }],
      credential: codexCredential(),
      fetch: async () => sseResponse([
        { type: "response.output_text.delta", delta: "partial" },
      ]),
    }).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ name: "PartialResponseError" });
    expect(JSON.stringify(error)).not.toContain(tokenValue("access"));
  });
});

function codexCredential(
  refresh: ResolvedCodexCredential["refresh"] = async () => codexCredential(),
): ResolvedCodexCredential {
  return {
    kind: "codex",
    accessToken: tokenValue("access"),
    accountId: "account-fixture",
    refresh,
  };
}

function sseResponse(payloads: ReadonlyArray<Record<string, unknown>>): Response {
  const body = payloads
    .map((payload) => `data: ${JSON.stringify(payload)}\n\n`)
    .join("");
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function tokenValue(label: string): string {
  return ["fixture", label, "credential"].join("-");
}
