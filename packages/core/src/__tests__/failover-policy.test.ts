import { describe, expect, it } from "vitest";
import {
  abortableRoutingDelay,
  decideFailover,
  DEFAULT_FAILOVER_POLICY,
} from "../llm/failover-policy.js";
import { classifyProviderError } from "../llm/provider-error.js";

describe("decideFailover", () => {
  it("uses the bounded retry and switching matrix", () => {
    const cases = [
      { source: { status: 402 }, category: "quota", retries: 0, action: "switch", status: "quota_exhausted" },
      { source: { status: 401 }, category: "auth", retries: 0, action: "switch", status: "auth_required" },
      { source: { code: "ECONNRESET" }, category: "network", retries: 0, action: "retry", status: "temporary_cooldown" },
      { source: { code: "ECONNRESET" }, category: "network", retries: 1, action: "retry", status: "temporary_cooldown" },
      { source: { code: "ECONNRESET" }, category: "network", retries: 2, action: "switch", status: "temporary_cooldown" },
      { source: { code: "ETIMEDOUT" }, category: "timeout", retries: 2, action: "switch", status: "temporary_cooldown" },
      { source: { status: 503 }, category: "overloaded", retries: 2, action: "switch", status: "temporary_cooldown" },
      { source: { code: "model_not_found" }, category: "model_unavailable", retries: 0, action: "switch", status: "temporary_cooldown" },
      { source: { status: 400 }, category: "invalid_request", retries: 0, action: "fail", status: "unknown" },
      { source: { code: "context_length_exceeded" }, category: "context_overflow", retries: 0, action: "fail", status: "unknown" },
      { source: { code: "content_policy_violation" }, category: "content_policy", retries: 0, action: "fail", status: "unknown" },
      { source: new Error("opaque"), category: "unknown", retries: 0, action: "fail", status: "unknown" },
    ] as const;

    for (const testCase of cases) {
      const error = classifyProviderError(testCase.source);
      expect(error.category).toBe(testCase.category);
      const decision = decideFailover(error, testCase.retries);
      expect(decision.action).toBe(testCase.action);
      expect(decision.healthStatus).toBe(testCase.status);
    }
  });

  it("honors a bounded Retry-After and then switches", () => {
    const error = classifyProviderError({
      status: 429,
      headers: new Headers({ "retry-after": "10" }),
    }, { now: 0 });

    expect(decideFailover(error, 0)).toMatchObject({
      action: "retry",
      delayMs: DEFAULT_FAILOVER_POLICY.maxRetryDelayMs,
      healthStatus: "temporary_cooldown",
    });
    expect(decideFailover(error, 1)).toMatchObject({
      action: "switch",
      delayMs: 0,
      healthStatus: "temporary_cooldown",
    });
  });

  it("never retries or switches after visible output or cancellation", () => {
    const visible = classifyProviderError(
      { code: "ECONNRESET" },
      { visibleOutput: true },
    );
    const abort = new DOMException("cancelled", "AbortError");
    const cancelled = classifyProviderError(abort);

    expect(decideFailover(visible, 0)).toMatchObject({
      action: "fail",
      reason: "visible_output",
    });
    expect(decideFailover(cancelled, 0)).toMatchObject({
      action: "fail",
      reason: "cancelled",
    });
  });

  it("interrupts policy waits immediately when the caller aborts", async () => {
    const controller = new AbortController();
    const wait = abortableRoutingDelay(60_000, controller.signal);
    controller.abort(new DOMException("cancelled", "AbortError"));

    await expect(wait).rejects.toMatchObject({ name: "AbortError" });
  });
});
