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
});
