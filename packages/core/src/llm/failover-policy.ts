import type { BackendHealthStatus } from "./backend-health-store.js";
import type { ProviderError, ProviderErrorCategory } from "./provider-error.js";

export interface FailoverPolicyConfig {
  readonly localRetries: Readonly<Partial<Record<ProviderErrorCategory, number>>>;
  readonly baseDelayMs: number;
  readonly maxRetryDelayMs: number;
  readonly transientCooldownMs: number;
  readonly rateLimitCooldownMs: number;
  readonly modelUnavailableCooldownMs: number;
  readonly maxCooldownMs: number;
}

export type FailoverAction = "retry" | "switch" | "fail";

export interface FailoverDecision {
  readonly action: FailoverAction;
  readonly delayMs: number;
  readonly healthStatus: BackendHealthStatus;
  readonly cooldownMs?: number;
  readonly reason: ProviderErrorCategory | "cancelled" | "visible_output";
}

export const DEFAULT_FAILOVER_POLICY: FailoverPolicyConfig = {
  localRetries: {
    quota: 0,
    rate_limit: 1,
    auth: 0,
    network: 2,
    timeout: 2,
    overloaded: 2,
    model_unavailable: 0,
    invalid_request: 0,
    context_overflow: 0,
    content_policy: 0,
    unknown: 0,
  },
  baseDelayMs: 800,
  maxRetryDelayMs: 5_000,
  transientCooldownMs: 30_000,
  rateLimitCooldownMs: 60_000,
  modelUnavailableCooldownMs: 60_000,
  maxCooldownMs: 5 * 60_000,
};

export function decideFailover(
  error: ProviderError,
  retriesUsed: number,
  config: FailoverPolicyConfig = DEFAULT_FAILOVER_POLICY,
): FailoverDecision {
  if (error.cancelled) {
    return {
      action: "fail",
      delayMs: 0,
      healthStatus: "unknown",
      reason: "cancelled",
    };
  }
  if (error.visibleOutput) {
    return {
      action: "fail",
      delayMs: 0,
      healthStatus: healthStatusForCategory(error.category),
      reason: "visible_output",
    };
  }

  const retryLimit = boundedRetryLimit(config.localRetries[error.category]);
  if (error.retryable && error.onCurrentBackend && retriesUsed < retryLimit) {
    return {
      action: "retry",
      delayMs: retryDelay(error, retriesUsed, config),
      healthStatus: healthStatusForCategory(error.category),
      cooldownMs: cooldownForCategory(error, config),
      reason: error.category,
    };
  }

  if (error.failoverEligible) {
    return {
      action: "switch",
      delayMs: 0,
      healthStatus: healthStatusForCategory(error.category),
      cooldownMs: cooldownForCategory(error, config),
      reason: error.category,
    };
  }

  return {
    action: "fail",
    delayMs: 0,
    healthStatus: healthStatusForCategory(error.category),
    reason: error.category,
  };
}

export async function abortableRoutingDelay(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (delayMs <= 0) {
    signal?.throwIfAborted();
    return;
  }
  if (!signal) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
    return;
  }

  signal.throwIfAborted();
  await new Promise<void>((resolveDelay, rejectDelay) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveDelay();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      rejectDelay(signal.reason ?? new DOMException("LLM request aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function retryDelay(
  error: ProviderError,
  retriesUsed: number,
  config: FailoverPolicyConfig,
): number {
  const retryAfterMs = error.category === "rate_limit"
    ? error.retryAfter?.delayMs
    : undefined;
  const exponential = config.baseDelayMs * (2 ** retriesUsed);
  return Math.max(
    0,
    Math.min(config.maxRetryDelayMs, retryAfterMs ?? exponential),
  );
}

function cooldownForCategory(
  error: ProviderError,
  config: FailoverPolicyConfig,
): number | undefined {
  const proposed = error.category === "rate_limit"
    ? Math.max(config.rateLimitCooldownMs, error.retryAfter?.delayMs ?? 0)
    : error.category === "model_unavailable"
      ? config.modelUnavailableCooldownMs
      : error.category === "network"
        || error.category === "timeout"
        || error.category === "overloaded"
        ? config.transientCooldownMs
        : undefined;
  return proposed === undefined
    ? undefined
    : Math.max(0, Math.min(config.maxCooldownMs, proposed));
}

function healthStatusForCategory(category: ProviderErrorCategory): BackendHealthStatus {
  switch (category) {
    case "quota":
      return "quota_exhausted";
    case "auth":
      return "auth_required";
    case "rate_limit":
    case "network":
    case "timeout":
    case "overloaded":
    case "model_unavailable":
      return "temporary_cooldown";
    case "invalid_request":
    case "context_overflow":
    case "content_policy":
    case "unknown":
      return "unknown";
  }
}

function boundedRetryLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(10, Math.trunc(value ?? 0)));
}
