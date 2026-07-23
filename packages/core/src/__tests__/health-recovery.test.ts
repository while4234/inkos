import { describe, expect, it, vi } from "vitest";
import {
  createEmptyBackendHealthFile,
  type BackendHealthStore,
} from "../llm/backend-health-store.js";
import {
  runBackendProbeSingleFlight,
  tryAcquireBackendRecoveryLease,
  withProbeTimeout,
} from "../llm/health-recovery.js";

describe("backend recovery coordination", () => {
  it("admits one half-open request for unknown and elapsed-cooldown backends", () => {
    const store = fakeStore();
    const first = tryAcquireBackendRecoveryLease(store, "backend-a", undefined, 10_000);
    const duplicate = tryAcquireBackendRecoveryLease(store, "backend-a", undefined, 10_000);
    expect(first).not.toBeNull();
    expect(duplicate).toBeNull();
    first?.release();
    expect(tryAcquireBackendRecoveryLease(store, "backend-a", {
      backendId: "backend-a",
      status: "temporary_cooldown",
      consecutiveFailures: 1,
      cooldownUntil: new Date(9_000).toISOString(),
    }, 10_000)).not.toBeNull();
  });

  it("deduplicates concurrent probes and releases the flight after completion", async () => {
    const store = fakeStore();
    let resolve!: (value: string) => void;
    const operation = vi.fn(() => new Promise<string>((done) => { resolve = done; }));
    const first = runBackendProbeSingleFlight(store, "backend-a", operation);
    const second = runBackendProbeSingleFlight(store, "backend-a", operation);
    expect(operation).toHaveBeenCalledTimes(1);
    resolve("healthy");
    await expect(Promise.all([first, second])).resolves.toEqual(["healthy", "healthy"]);
    await expect(runBackendProbeSingleFlight(store, "backend-a", async () => "again"))
      .resolves.toBe("again");
  });

  it("enforces timeout and caller cancellation without exposing probe payloads", async () => {
    vi.useFakeTimers();
    const timed = withProbeTimeout(
      async () => new Promise<never>(() => undefined),
      { timeoutMs: 50 },
    );
    const timedAssertion = expect(timed).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(50);
    await timedAssertion;
    vi.useRealTimers();

    const controller = new AbortController();
    const cancelled = withProbeTimeout(
      async () => new Promise<never>(() => undefined),
      { timeoutMs: 10_000, signal: controller.signal },
    );
    const cancelledAssertion = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    controller.abort(new DOMException("cancelled", "AbortError"));
    await cancelledAssertion;
  });
});

function fakeStore(): BackendHealthStore {
  return {
    read: async () => createEmptyBackendHealthFile(),
    recordFailure: async () => { throw new Error("unused"); },
    recordSuccess: async () => { throw new Error("unused"); },
    reset: async () => { throw new Error("unused"); },
    recordProbe: async () => { throw new Error("unused"); },
  };
}
