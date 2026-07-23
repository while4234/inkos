import { describe, expect, it } from "vitest";
import { reduceRoutingSummary } from "./routing-summary";

describe("routing summary", () => {
  it("tracks attempts, retries, switches, exhaustion, and active backend safely", () => {
    const base = {
      requestId: "request-1",
      timestamp: "2026-07-24T00:00:00.000Z",
      logicalModelId: "route-ab",
      logicalModelDisplayName: "Writer",
      phase: "request" as const,
      retryCount: 0,
    };
    const attempted = reduceRoutingSummary(undefined, {
      ...base,
      eventId: "request-1:1",
      type: "attempt_started",
      backendId: "backend-a",
    });
    const retried = reduceRoutingSummary(attempted, {
      ...base,
      eventId: "request-1:2",
      type: "local_retry",
      phase: "retry",
      backendId: "backend-a",
      retryCount: 1,
    });
    const switched = reduceRoutingSummary(retried, {
      ...base,
      eventId: "request-1:3",
      type: "backend_switched",
      phase: "retry",
      fromBackendId: "backend-a",
      toBackendId: "backend-b",
      reason: "quota",
      retryCount: 1,
    });
    const exhausted = reduceRoutingSummary(switched, {
      ...base,
      eventId: "request-1:4",
      type: "exhausted",
      phase: "complete",
      backendId: "backend-b",
      retryCount: 2,
    });
    expect(exhausted).toMatchObject({
      activeBackendId: "backend-b",
      retryCount: 1,
    });
    expect(exhausted.switches).toHaveLength(1);
    expect(reduceRoutingSummary(exhausted, {
      ...base,
      eventId: "request-1:3",
      type: "backend_switched",
      phase: "retry",
      fromBackendId: "backend-a",
      toBackendId: "backend-b",
      reason: "quota",
      retryCount: 1,
    })).toEqual(exhausted);
    expect(JSON.stringify(exhausted)).not.toContain("sk-");
  });

  it("does not mark a retryable trace failed and preserves cancellation", () => {
    const base = {
      eventId: "request-2:1",
      requestId: "request-2",
      timestamp: "2026-07-24T00:00:00.000Z",
      logicalModelId: "route-ab",
      logicalModelDisplayName: "Writer",
      phase: "request" as const,
      retryCount: 0,
      type: "failed" as const,
    };
    const running = reduceRoutingSummary(undefined, {
      ...base,
      trace: trace("running"),
    });
    expect(running.terminalState).toBeUndefined();
    const cancelled = reduceRoutingSummary(running, {
      ...base,
      eventId: "request-2:2",
      trace: trace("cancelled"),
    });
    expect(cancelled.terminalState).toBe("cancelled");
  });
});

function trace(finalStatus: "running" | "cancelled") {
  return {
    version: 1 as const,
    requestId: "request-2",
    operationId: "request-2",
    logicalModelId: "route-ab",
    logicalModelDisplayName: "Writer",
    prompt: null,
    context: {},
    attempts: [],
    switches: [],
    backends: [],
    visibleOutput: false,
    finalBackendId: null,
    finalModelId: null,
    finalStatus,
  };
}
