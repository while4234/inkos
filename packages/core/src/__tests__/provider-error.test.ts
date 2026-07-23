import { describe, expect, it } from "vitest";
import {
  ProviderCancellationError,
  ProviderError,
  classifyProviderError,
  parseRetryAfter,
  providerErrorFromResponse,
  toProviderDisplayError,
  toSafeProviderErrorDetails,
  type ProviderErrorCategory,
} from "../llm/provider-error.js";
import { ContextWindowExceededError, PartialResponseError } from "../llm/provider.js";

type ClassificationCase = {
  readonly name: string;
  readonly error: unknown;
  readonly category: ProviderErrorCategory;
};

const CLASSIFICATION_CASES: readonly ClassificationCase[] = [
  {
    name: "quota from HTTP 402",
    error: { status: 402, message: "Payment Required" },
    category: "quota",
  },
  {
    name: "quota from an upstream code",
    error: { status: 400, error: { code: "insufficient_quota", message: "billing state" } },
    category: "quota",
  },
  {
    name: "period quota from a controlled message",
    error: new Error("Monthly usage limit reached. Resets next month."),
    category: "quota",
  },
  {
    name: "temporary rate limit",
    error: { status: 429, error: { type: "rate_limit_error" } },
    category: "rate_limit",
  },
  {
    name: "authentication",
    error: { statusCode: 401, error: { code: "invalid_api_key" } },
    category: "auth",
  },
  {
    name: "network",
    error: Object.assign(new Error("socket closed"), { code: "ECONNRESET" }),
    category: "network",
  },
  {
    name: "timeout",
    error: Object.assign(new Error("request failed"), { code: "ETIMEDOUT" }),
    category: "timeout",
  },
  {
    name: "overloaded",
    error: { status: 503, error: { code: "server_overloaded" } },
    category: "overloaded",
  },
  {
    name: "model unavailable",
    error: { status: 400, error: { code: "model_not_deployed" } },
    category: "model_unavailable",
  },
  {
    name: "invalid request",
    error: { status: 400, error: { type: "invalid_request_error" } },
    category: "invalid_request",
  },
  {
    name: "context overflow",
    error: new ContextWindowExceededError({
      estimatedInputTokens: 9,
      reservedOutputTokens: 2,
      contextWindow: 10,
      model: "mock-model",
    }),
    category: "context_overflow",
  },
  {
    name: "content policy",
    error: { status: 403, error: { code: "content_policy_violation" } },
    category: "content_policy",
  },
  {
    name: "unknown",
    error: new Error("provider returned an undocumented failure"),
    category: "unknown",
  },
];

describe("classifyProviderError", () => {
  for (const testCase of CLASSIFICATION_CASES) {
    it(`classifies ${testCase.name}`, () => {
      expect(classifyProviderError(testCase.error).category).toBe(testCase.category);
    });
  }

  it("prefers nested structured evidence and preserves the original cause", () => {
    const cause = Object.assign(new Error("upstream failed"), {
      status: 429,
      body: {
        error: {
          code: "rate_limit_exceeded",
          type: "rate_limit_error",
        },
      },
      headers: {
        "retry-after": "3",
        "x-request-id": "request_mock_123",
      },
    });
    const outer = Object.assign(new Error("provider adapter failed"), { cause });

    const error = classifyProviderError(outer, {
      backendId: "backend-mock",
      logicalModelId: "writer-default",
      upstreamModelId: "mock-v2",
      now: Date.parse("2026-01-01T00:00:00.000Z"),
    });

    expect(error).toBeInstanceOf(ProviderError);
    expect(error.category).toBe("rate_limit");
    expect(error.status).toBe(429);
    expect(error.upstreamCode).toBe("rate_limit_exceeded");
    expect(error.upstreamType).toBe("rate_limit_error");
    expect(error.retryAfter?.delayMs).toBe(3_000);
    expect(error.requestId).toBe("request_mock_123");
    expect(error.backendId).toBe("backend-mock");
    expect(error.logicalModelId).toBe("writer-default");
    expect(error.upstreamModelId).toBe("mock-v2");
    expect(error.cause).toBe(outer);
  });

  it("does not classify every 403 as auth", () => {
    expect(classifyProviderError({ status: 403, message: "Forbidden" }).category).toBe("unknown");
    expect(classifyProviderError({
      status: 403,
      error: { code: "invalid_token" },
    }).category).toBe("auth");
    expect(classifyProviderError({
      status: 403,
      error: { code: "safety_violation" },
    }).category).toBe("content_policy");
  });

  it("uses structured 400 semantics before the generic invalid-request fallback", () => {
    expect(classifyProviderError({
      status: 400,
      error: { code: "context_length_exceeded" },
    }).category).toBe("context_overflow");
    expect(classifyProviderError({
      status: 400,
      error: { code: "model_not_found" },
    }).category).toBe("model_unavailable");
    expect(classifyProviderError({ status: 400, message: "Bad Request" }).category).toBe("invalid_request");
  });

  it("treats AbortError as explicit cancellation, never as retry/failover", () => {
    const abort = new DOMException("The operation was aborted.", "AbortError");
    const error = classifyProviderError(abort);

    expect(error).toBeInstanceOf(ProviderCancellationError);
    expect(error.cancelled).toBe(true);
    expect(error.retryable).toBe(false);
    expect(error.onCurrentBackend).toBe(false);
    expect(error.failoverEligible).toBe(false);
    expect(error.cause).toBe(abort);
  });

  it("distinguishes AbortSignal timeout from user cancellation", () => {
    const timeout = new DOMException("The operation was aborted due to timeout.", "TimeoutError");
    const error = classifyProviderError(timeout);

    expect(error.category).toBe("timeout");
    expect(error.cancelled).toBe(false);
    expect(error.retryable).toBe(true);
  });

  it("propagates explicit visible-output state from partial stream errors", () => {
    const internal = classifyProviderError(new PartialResponseError("internal", new Error("closed")));
    const visible = classifyProviderError(
      new PartialResponseError("visible", new Error("closed"), { visibleOutput: true }),
    );

    expect(internal.category).toBe("network");
    expect(internal.visibleOutput).toBe(false);
    expect(visible.visibleOutput).toBe(true);
  });

  it("lets an output boundary update visibility without losing structured evidence", () => {
    const hidden = classifyProviderError({
      status: 503,
      error: { code: "server_overloaded" },
    }, {
      backendId: "backend-a",
      logicalModelId: "writer",
      upstreamModelId: "model-a",
    });

    const visible = hidden.withVisibleOutput();

    expect(visible.visibleOutput).toBe(true);
    expect(visible.category).toBe("overloaded");
    expect(visible.status).toBe(503);
    expect(visible.backendId).toBe("backend-a");
    expect(visible.logicalModelId).toBe("writer");
    expect(visible.upstreamModelId).toBe("model-a");
    expect(visible.cause).toBe(hidden.cause);
  });
});

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");

  it("parses seconds and HTTP-date forms", () => {
    expect(parseRetryAfter("2.5", now)).toEqual({
      source: "retry-after",
      raw: "2.5",
      delayMs: 2_500,
      retryAt: "2026-01-01T00:00:02.500Z",
    });
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:10 GMT", now)).toEqual({
      source: "retry-after",
      raw: "Thu, 01 Jan 2026 00:00:10 GMT",
      delayMs: 10_000,
      retryAt: "2026-01-01T00:00:10.000Z",
    });
  });

  it("bounds excessive values and preserves a bounded invalid source", () => {
    expect(parseRetryAfter("999999999", now)?.delayMs).toBe(86_400_000);
    expect(parseRetryAfter("not-a-date", now)).toEqual({
      source: "retry-after",
      raw: "not-a-date",
    });
    expect(parseRetryAfter("x".repeat(1_000), now)?.raw.length).toBe(160);
  });
});

describe("providerErrorFromResponse", () => {
  it("extracts JSON status, code, type, Retry-After and request id", async () => {
    const response = new Response(JSON.stringify({
      error: {
        code: "rate_limit_exceeded",
        type: "rate_limit_error",
        message: "limit for credential mock-secret",
      },
    }), {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": "4",
        "x-request-id": "request_mock_456",
      },
    });

    const error = await providerErrorFromResponse(response, {
      backendId: "backend-a",
      logicalModelId: "writer",
      upstreamModelId: "model-a",
      now: Date.parse("2026-01-01T00:00:00.000Z"),
    });

    expect(error.category).toBe("rate_limit");
    expect(error.status).toBe(429);
    expect(error.upstreamCode).toBe("rate_limit_exceeded");
    expect(error.upstreamType).toBe("rate_limit_error");
    expect(error.retryAfter?.delayMs).toBe(4_000);
    expect(error.requestId).toBe("request_mock_456");
    expect(error.cause).toBeInstanceOf(Error);
    expect(JSON.stringify(error)).not.toContain("mock-secret");
  });

  it("handles non-JSON and proxy HTML bodies without retaining or displaying them", async () => {
    const html = "<html><body>proxy failure Authorization: Bearer mock-token-secret</body></html>";
    const error = await providerErrorFromResponse(new Response(html, {
      status: 502,
      statusText: "Bad Gateway",
    }));

    expect(error.category).toBe("overloaded");
    expect(error.status).toBe(502);
    expect(error.message).not.toContain("mock-token-secret");
    expect(JSON.stringify(error)).not.toContain(html);
  });

  it("uses a controlled non-JSON body as classification evidence without retaining it", async () => {
    const body = "Invalid token: Authorization Bearer mock-token-secret";
    const error = await providerErrorFromResponse(new Response(body, {
      status: 403,
      statusText: "Forbidden",
    }));

    expect(error.category).toBe("auth");
    expect(error.message).toContain("认证失败");
    expect(error.cause).toBeInstanceOf(Error);
    expect(JSON.stringify(error)).not.toContain("mock-token-secret");
  });
});

describe("safe ProviderError presentation", () => {
  it("serializes only redacted structured fields, never cause or response bodies", () => {
    const cause = Object.assign(new Error("Authorization: Bearer mock-token-secret"), {
      body: { apiKey: "sk-mock-secret-value" },
    });
    const error = new ProviderError({
      category: "auth",
      status: 401,
      upstreamCode: "api_key=AIzaMockCredentialValue1234567890",
      backendId: "backend-a",
      cause,
    });

    const details = toSafeProviderErrorDetails(error);
    const serialized = JSON.stringify(details);
    expect(serialized).not.toContain("mock-token-secret");
    expect(serialized).not.toContain("AIzaMockCredentialValue1234567890");
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("body");
  });

  it("maps to a compatibility display Error while retaining ProviderError as cause", () => {
    const provider = classifyProviderError({ status: 401, error: { code: "invalid_api_key" } });
    const display = toProviderDisplayError(provider);

    expect(display.message).toContain("认证失败");
    expect((display as Error & { cause?: unknown }).cause).toBe(provider);
  });
});
