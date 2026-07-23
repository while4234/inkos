import type {
  BackendHealthRecord,
  BackendHealthStore,
} from "./backend-health-store.js";

const activeRecoverySlots = new Map<string, Set<string>>();
const probeFlights = new Map<string, Promise<unknown>>();

export interface BackendRecoveryLease {
  readonly backendId: string;
  release(): void;
}

/**
 * Allows one half-open business request after cooldown expiry or while a
 * backend has never established health. Healthy backends do not need a lease.
 */
export function tryAcquireBackendRecoveryLease(
  store: BackendHealthStore,
  backendId: string,
  record: BackendHealthRecord | undefined,
  now = Date.now(),
): BackendRecoveryLease | null {
  if (!requiresControlledRecovery(record, now)) {
    return { backendId, release() {} };
  }
  const key = recoveryStoreKey(store);
  const active = activeRecoverySlots.get(key) ?? new Set<string>();
  if (active.has(backendId)) return null;
  active.add(backendId);
  activeRecoverySlots.set(key, active);
  let released = false;
  return {
    backendId,
    release() {
      if (released) return;
      released = true;
      active.delete(backendId);
      if (active.size === 0) activeRecoverySlots.delete(key);
    },
  };
}

export function runBackendProbeSingleFlight<T>(
  store: BackendHealthStore,
  backendId: string,
  probe: () => Promise<T>,
): Promise<T> {
  const key = `${recoveryStoreKey(store)}\0${backendId}`;
  const existing = probeFlights.get(key);
  if (existing) return existing as Promise<T>;
  const current = probe().finally(() => {
    if (probeFlights.get(key) === current) probeFlights.delete(key);
  });
  probeFlights.set(key, current);
  return current;
}

export async function withProbeTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: {
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  },
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException("Backend probe timed out", "TimeoutError")),
    options.timeoutMs,
  );
  timeout.unref?.();
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => {
          reject(controller.signal.reason ?? new DOMException("Backend probe aborted", "AbortError"));
        }, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

function requiresControlledRecovery(
  record: BackendHealthRecord | undefined,
  now: number,
): boolean {
  if (!record) return true;
  if (record.status === "unknown") return true;
  return record.status === "temporary_cooldown"
    && Boolean(record.cooldownUntil && Date.parse(record.cooldownUntil) <= now);
}

function recoveryStoreKey(store: BackendHealthStore): string {
  const path = (store as BackendHealthStore & { readonly path?: string }).path;
  return path ? `file:${path}` : `instance:${objectId(store)}`;
}

const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;

function objectId(value: object): number {
  const current = objectIds.get(value);
  if (current) return current;
  const created = nextObjectId++;
  objectIds.set(value, created);
  return created;
}
