import { describe, expect, it } from "vitest";
import {
  RoutingTraceCollector,
  buildRoutingTrace,
  calculateRoutingCost,
  type RoutingEvent,
  type RoutingTokenUsage,
} from "../llm/routing-trace.js";

const observedUsage: RoutingTokenUsage = {
  inputTokens: 1_000,
  outputTokens: 500,
  cacheReadTokens: 200,
  cacheWriteTokens: null,
  reasoningTokens: 100,
  providerObserved: true,
};

describe("unified routing trace", () => {
  it("keeps attempt order and aggregates observed usage without turning failures into zero", () => {
    const events = [
      event(1, "attempt_started", { backendId: "backend-a", upstreamModelId: "model-a" }),
      event(2, "failed", {
        backendId: "backend-a",
        upstreamModelId: "model-a",
        reason: "quota",
      }),
      event(3, "backend_switched", {
        fromBackendId: "backend-a",
        toBackendId: "backend-b",
        reason: "quota",
      }),
      event(4, "attempt_started", {
        backendId: "backend-b",
        upstreamModelId: "model-b",
        retryCount: 1,
        credentialKind: "codex",
        pricing: {
          currency: "USD",
          inputPerMillion: 2,
          outputPerMillion: 4,
          cacheReadPerMillion: 1,
          reasoningPerMillion: 3,
          source: "operator-contract",
          revision: "2026-07",
        },
      }),
      event(5, "succeeded", {
        backendId: "backend-b",
        upstreamModelId: "model-b",
        retryCount: 1,
        credentialKind: "codex",
        usage: observedUsage,
        pricing: {
          currency: "USD",
          inputPerMillion: 2,
          outputPerMillion: 4,
          cacheReadPerMillion: 1,
          reasoningPerMillion: 3,
          source: "operator-contract",
          revision: "2026-07",
        },
      }),
    ];

    const trace = buildRoutingTrace(events)!;

    expect(trace.version).toBe(1);
    expect(trace.attempts).toHaveLength(2);
    expect(trace.attempts[0]?.usage).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      providerObserved: false,
    });
    expect(trace.backends[0]).toMatchObject({
      backendId: "backend-a",
      inputTokens: null,
      outputTokens: null,
      cost: { status: "unknown", amount: null },
    });
    expect(trace.backends[1]).toMatchObject({
      backendId: "backend-b",
      inputTokens: 1_000,
      outputTokens: 500,
      cacheReadTokens: 200,
      reasoningTokens: 100,
      cost: {
        status: "known",
        amount: 0.0045,
        currency: "USD",
        priceSource: "operator-contract",
        priceRevision: "2026-07",
      },
    });
    expect(trace.switches).toEqual([{
      at: "2026-07-24T00:00:03.000Z",
      fromBackendId: "backend-a",
      toBackendId: "backend-b",
      reason: "quota",
    }]);
    expect(trace.finalStatus).toBe("succeeded");
  });

  it("requires explicit complete price metadata and never treats a zero placeholder as free", () => {
    expect(calculateRoutingCost(observedUsage, undefined)).toEqual({
      status: "unknown",
      amount: null,
      currency: null,
      priceSource: null,
      priceRevision: null,
    });
    expect(calculateRoutingCost(observedUsage, {
      currency: "USD",
      inputPerMillion: 0,
      outputPerMillion: 0,
      source: "explicit-free-tier",
      revision: "contract-1",
    })).toMatchObject({
      status: "unknown",
      amount: null,
    });
  });

  it("counts provider-observed partial usage once and refuses to merge price revisions", () => {
    const firstPrice = {
      currency: "USD",
      inputPerMillion: 1,
      outputPerMillion: 1,
      source: "contract",
      revision: "r1",
    } as const;
    const secondPrice = { ...firstPrice, revision: "r2" };
    const events = [
      event(1, "attempt_started", {
        backendId: "backend-a",
        upstreamModelId: "model-a",
        pricing: firstPrice,
      }),
      event(2, "failed", {
        backendId: "backend-a",
        upstreamModelId: "model-a",
        reason: "network",
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          reasoningTokens: null,
          providerObserved: true,
        },
        pricing: firstPrice,
      }),
      event(3, "local_retry", {
        backendId: "backend-a",
        upstreamModelId: "model-a",
        reason: "network",
        retryCount: 1,
      }),
      event(4, "attempt_started", {
        backendId: "backend-a",
        upstreamModelId: "model-a",
        retryCount: 1,
        pricing: secondPrice,
      }),
      event(5, "succeeded", {
        backendId: "backend-a",
        upstreamModelId: "model-a",
        retryCount: 1,
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          reasoningTokens: null,
          providerObserved: true,
        },
        pricing: secondPrice,
      }),
    ];

    expect(buildRoutingTrace(events)?.backends[0]).toMatchObject({
      attemptCount: 2,
      localRetryCount: 1,
      inputTokens: 20,
      outputTokens: 7,
      cost: { status: "unknown", amount: null },
    });
  });

  it("bounds retained observer events and strips credential-like context", () => {
    const collector = new RoutingTraceCollector();
    for (let index = 1; index <= 450; index += 1) {
      void collector.observer(event(index, index % 2 ? "attempt_started" : "failed", {
        backendId: "backend-a",
        upstreamModelId: "model-a",
        reason: index % 2 ? undefined : "network",
        context: {
          taskId: "task Authorization: Bearer fixture-secret-value",
        },
      }));
    }

    const trace = collector.snapshot()!;
    expect(trace.attempts.length).toBeLessThanOrEqual(100);
    expect(new Set(trace.attempts.map((attempt) => attempt.sequence)).size)
      .toBe(trace.attempts.length);
    expect(JSON.stringify(trace)).not.toContain("fixture-secret-value");
  });

  it("distinguishes in-progress, cancelled, and interrupted terminal traces", () => {
    const started = event(1, "attempt_started", {
      backendId: "backend-a",
      upstreamModelId: "model-a",
    });
    expect(buildRoutingTrace([started])?.finalStatus).toBe("running");
    expect(buildRoutingTrace([
      started,
      event(2, "failed", {
        backendId: "backend-a",
        upstreamModelId: "model-a",
        reason: "unknown",
        finalStatus: "cancelled",
      }),
    ])?.finalStatus).toBe("cancelled");
    expect(buildRoutingTrace([
      started,
      event(2, "failed", {
        backendId: "backend-a",
        upstreamModelId: "model-a",
        reason: "network",
        visibleOutput: true,
        finalStatus: "interrupted",
      }),
    ])?.finalStatus).toBe("interrupted");
  });

  it("fails trace diagnostics closed without throwing into the model request", () => {
    const invalid = event(1, "attempt_started", {
      backendId: "backend-a",
      upstreamModelId: "model-a",
      timestamp: "not-a-timestamp",
    });
    expect(buildRoutingTrace([invalid])).toBeNull();
    expect(calculateRoutingCost(observedUsage, {
      currency: "USD",
      inputPerMillion: Number.MAX_VALUE,
      outputPerMillion: Number.MAX_VALUE,
      cacheReadPerMillion: Number.MAX_VALUE,
      reasoningPerMillion: Number.MAX_VALUE,
      source: "fixture",
      revision: "overflow",
    })).toMatchObject({ status: "unknown", amount: null });
  });
});

function event(
  sequence: number,
  type: RoutingEvent["type"],
  overrides: Partial<RoutingEvent>,
): RoutingEvent {
  return {
    eventId: `request-1:${sequence}`,
    requestId: "request-1",
    type,
    timestamp: new Date(Date.UTC(2026, 6, 24) + sequence * 1_000).toISOString(),
    logicalModelId: "route-main",
    phase: type === "backend_switched" ? "selection" : type === "succeeded" ? "complete" : "request",
    retryCount: 0,
    visibleOutput: false,
    ...overrides,
  };
}
