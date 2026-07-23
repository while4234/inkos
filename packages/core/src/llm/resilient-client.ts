import type { LLMConfig } from "../models/project.js";
import { BackendPool, type BackendPoolOptions, type SkippedBackendCandidate } from "./backend-pool.js";
import {
  FileBackendHealthStore,
  type BackendHealthStore,
  type BackendProbeUpdate,
} from "./backend-health-store.js";
import { tryAcquireBackendRecoveryLease } from "./health-recovery.js";
import { createProjectCredentialResolver, type CredentialResolver } from "./credentials/index.js";
import {
  abortableRoutingDelay,
  decideFailover,
  DEFAULT_FAILOVER_POLICY,
  type FailoverPolicyConfig,
} from "./failover-policy.js";
import type { ModelRoutingConfig } from "./model-routing.js";
import {
  resolveModelGlobalPrompt,
  toModelGlobalPromptTrace,
} from "./model-global-prompt.js";
import {
  classifyProviderError,
  type ProviderError,
  type ProviderErrorCategory,
} from "./provider-error.js";
import {
  chatCompletion,
  createLLMClient,
  type ChatCompletionOptions,
  type LLMClient,
  type LLMMessage,
  type LLMResponse,
} from "./provider.js";
import {
  RoutingEventEmitter,
  type RoutingEventObserver,
} from "./routing-trace.js";

export interface RoutingAttemptFailure {
  readonly backendId: string;
  readonly upstreamModelId: string;
  readonly attemptNumber: number;
  readonly category: ProviderErrorCategory | "candidate_unavailable";
  readonly safeReason: string;
  readonly visibleOutput: boolean;
}

export interface RouteExhaustedErrorDetails {
  readonly logicalModelId: string;
  readonly message: string;
  readonly attempts: ReadonlyArray<RoutingAttemptFailure>;
}

export class RouteExhaustedError extends Error {
  public readonly logicalModelId: string;
  public readonly attempts: ReadonlyArray<RoutingAttemptFailure>;

  public constructor(
    logicalModelId: string,
    attempts: ReadonlyArray<RoutingAttemptFailure>,
  ) {
    const safeLogicalModelId = sanitizeRoutingField(logicalModelId) || "unknown";
    super(`Logical model route "${safeLogicalModelId}" exhausted all available backends.`);
    this.name = "RouteExhaustedError";
    this.logicalModelId = safeLogicalModelId;
    this.attempts = attempts.map((attempt) => ({
      ...attempt,
      backendId: sanitizeRoutingField(attempt.backendId) || "unknown",
      upstreamModelId: sanitizeRoutingField(attempt.upstreamModelId) || "unknown",
      safeReason: sanitizeRoutingField(attempt.safeReason) || "Provider request failed.",
      attemptNumber: Number.isInteger(attempt.attemptNumber)
        ? Math.max(0, attempt.attemptNumber)
        : 0,
    }));
  }

  public toJSON(): RouteExhaustedErrorDetails {
    return {
      logicalModelId: this.logicalModelId,
      message: this.message,
      attempts: this.attempts,
    };
  }
}

export interface ResilientChatRuntimeOptions extends BackendPoolOptions {
  readonly routing: ModelRoutingConfig;
  readonly projectRoot: string;
  readonly baseConfig: LLMConfig;
  readonly credentials?: CredentialResolver;
  readonly healthStore?: BackendHealthStore;
  readonly observer?: RoutingEventObserver;
  readonly policy?: FailoverPolicyConfig;
  readonly sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  readonly invoke?: typeof chatCompletion;
}

export interface CreateRouteAwareLLMClientOptions
  extends Omit<ResilientChatRuntimeOptions, "routing" | "baseConfig"> {
  readonly config: LLMConfig;
  readonly compatibilityClient?: LLMClient;
  readonly routeId?: string;
}

export function createRouteAwareLLMClient(
  options: CreateRouteAwareLLMClientOptions,
): LLMClient {
  const {
    config,
    compatibilityClient: providedClient,
    routeId,
    ...runtimeOptions
  } = options;
  const compatibilityClient = providedClient ?? createLLMClient(config);
  const routing = config.routing;
  const selectedRouteId = routeId ?? routing?.defaultRouteId;
  if (!routing || !selectedRouteId) return compatibilityClient;
  const runtime = new ResilientChatRuntime({
    ...runtimeOptions,
    routing,
    baseConfig: config,
  });
  return runtime.createRouteClient(
    selectedRouteId,
    compatibilityClient,
  );
}

export class ResilientChatRuntime {
  public readonly healthStore: BackendHealthStore;
  private readonly pool: BackendPool;
  private readonly policy: FailoverPolicyConfig;
  private readonly observer?: RoutingEventObserver;
  private readonly now: () => number;
  private readonly sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  private readonly invoke: typeof chatCompletion;

  public constructor(private readonly options: ResilientChatRuntimeOptions) {
    this.healthStore = options.healthStore ?? new FileBackendHealthStore(options.projectRoot);
    const credentials = options.credentials ?? createProjectCredentialResolver(options.projectRoot);
    this.now = options.now ?? Date.now;
    this.pool = new BackendPool(
      options.routing,
      credentials,
      this.healthStore,
      {
        supportsModel: options.supportsModel,
        now: this.now,
      },
    );
    this.policy = options.policy ?? DEFAULT_FAILOVER_POLICY;
    this.observer = options.observer;
    this.sleep = options.sleep ?? abortableRoutingDelay;
    this.invoke = options.invoke ?? chatCompletion;
  }

  public createRouteClient(routeId: string, compatibilityClient: LLMClient): LLMClient {
    return {
      ...compatibilityClient,
      _routeRuntime: {
        complete: (_model, messages, options) =>
          this.complete(routeId, messages, options),
      },
    };
  }

  public async complete(
    routeId: string,
    messages: ReadonlyArray<LLMMessage>,
    options?: ChatCompletionOptions,
  ): Promise<LLMResponse> {
    throwIfRoutingCancelled(options?.signal, { logicalModelId: routeId });
    const immutableMessages = snapshotMessages(messages);
    const resolution = await this.pool.resolve(routeId, new Set(), options?.signal);
    const promptResolution = this.resolveRoutePrompt(
      resolution.route,
      options?.modelGlobalPrompt,
    );
    const emitter = new RoutingEventEmitter(
      routeId,
      this.observer,
      this.now,
      undefined,
      toModelGlobalPromptTrace(promptResolution),
      options?.routingContext,
    );
    throwIfRoutingCancelled(options?.signal, { logicalModelId: routeId });
    const failures = resolution.skipped.map(skippedCandidateFailure);
    const healthSnapshot = await this.healthStore.read();
    let switchFrom: { readonly backendId: string; readonly reason: ProviderErrorCategory } | undefined;

    for (const resolvedCandidate of resolution.candidates) {
      const backendId = resolvedCandidate.backend.id;
      const upstreamModelId = resolvedCandidate.candidate.upstreamModelId;
      const recoveryLease = tryAcquireBackendRecoveryLease(
        this.healthStore,
        backendId,
        healthSnapshot.backends[backendId],
        this.now(),
      );
      if (!recoveryLease) {
        failures.push({
          backendId,
          upstreamModelId,
          attemptNumber: 0,
          category: "candidate_unavailable",
          safeReason: "Backend recovery is already being checked by another request.",
          visibleOutput: false,
        });
        continue;
      }
      try {
      if (switchFrom) {
        await emitter.emit({
          type: "backend_switched",
          phase: "selection",
          fromBackendId: switchFrom.backendId,
          toBackendId: backendId,
          reason: switchFrom.reason,
          retryCount: 0,
          visibleOutput: false,
        });
        switchFrom = undefined;
      }

      const concreteClient = this.createBackendClient(resolvedCandidate);
      let retriesUsed = 0;
      while (true) {
        throwIfRoutingCancelled(options?.signal, {
          backendId,
          logicalModelId: routeId,
          upstreamModelId,
        });
        const attemptNumber = retriesUsed + 1;
        let visibleOutput = false;
        const onTextDelta = options?.onTextDelta
          ? (text: string) => {
              if (text.length > 0) visibleOutput = true;
              options.onTextDelta?.(text);
            }
          : undefined;

        await emitter.emit({
          type: "attempt_started",
          phase: "request",
          backendId,
          upstreamModelId,
          credentialKind: resolvedCandidate.credential.kind,
          ...(resolvedCandidate.candidate.pricing
            ? { pricing: resolvedCandidate.candidate.pricing }
            : {}),
          retryCount: retriesUsed,
          visibleOutput: false,
        });

        try {
          const response = await this.invoke(
            concreteClient,
            upstreamModelId,
            cloneMessages(immutableMessages),
            {
              ...options,
              onTextDelta,
              retry: false,
              _modelGlobalPromptResolution: promptResolution,
              errorContext: {
                backendId,
                logicalModelId: routeId,
                upstreamModelId,
              },
            },
          );
          await this.healthStore.recordSuccess(routeId, backendId, this.now());
          await emitter.emit({
            type: "succeeded",
            phase: "complete",
            finalStatus: "succeeded",
            backendId,
            upstreamModelId,
            credentialKind: resolvedCandidate.credential.kind,
            usage: {
              inputTokens: response.usage.promptTokens,
              outputTokens: response.usage.completionTokens,
              cacheReadTokens: null,
              cacheWriteTokens: null,
              reasoningTokens: null,
              providerObserved: response.usage.totalTokens > 0,
            },
            ...(resolvedCandidate.candidate.pricing
              ? { pricing: resolvedCandidate.candidate.pricing }
              : {}),
            retryCount: retriesUsed,
            visibleOutput,
          });
          return response;
        } catch (error) {
          const observedFailureUsage = routingUsageFromUnknown(error);
          let providerError = classifyProviderError(error, {
            backendId,
            logicalModelId: routeId,
            upstreamModelId,
            signal: options?.signal,
            visibleOutput,
            now: this.now(),
          });
          if (visibleOutput && !providerError.visibleOutput) {
            providerError = providerError.withVisibleOutput();
          }
          failures.push({
            backendId,
            upstreamModelId,
            attemptNumber,
            category: providerError.category,
            safeReason: providerError.safeMessage,
            visibleOutput: providerError.visibleOutput,
          });

          const decision = decideFailover(
            providerError,
            options?.retry === false ? Number.MAX_SAFE_INTEGER : retriesUsed,
            this.policy,
          );
          if (shouldRecordBackendFailure(providerError)) {
            await this.healthStore.recordFailure({
              backendId,
              status: decision.healthStatus,
              reason: decision.reason,
              at: this.now(),
              ...(decision.cooldownMs !== undefined
                ? { cooldownUntil: this.now() + decision.cooldownMs }
                : {}),
            });
          }
          await emitter.emit({
            type: "failed",
            phase: "request",
            ...(decision.action === "fail"
              ? {
                  finalStatus: providerError.cancelled
                    ? "cancelled" as const
                    : providerError.visibleOutput
                      ? "interrupted" as const
                      : "failed" as const,
                }
              : {}),
            backendId,
            upstreamModelId,
            credentialKind: resolvedCandidate.credential.kind,
            ...(resolvedCandidate.candidate.pricing
              ? { pricing: resolvedCandidate.candidate.pricing }
              : {}),
            ...(observedFailureUsage ? { usage: observedFailureUsage } : {}),
            reason: providerError.category,
            retryCount: retriesUsed,
            visibleOutput: providerError.visibleOutput,
          });

          if (decision.action === "fail") {
            throw providerError.withAttempts(
              failures
                .filter((attempt): attempt is RoutingAttemptFailure & {
                  readonly category: ProviderErrorCategory;
                } => attempt.category !== "candidate_unavailable")
                .map((attempt) => ({
                  backendId: attempt.backendId,
                  logicalModelId: routeId,
                  upstreamModelId: attempt.upstreamModelId,
                  attemptNumber: attempt.attemptNumber,
                  category: attempt.category,
                  safeReason: attempt.safeReason,
                  visibleOutput: attempt.visibleOutput,
                })),
            );
          }
          if (decision.action === "retry") {
            retriesUsed += 1;
            await emitter.emit({
              type: "local_retry",
              phase: "retry",
              backendId,
              upstreamModelId,
              reason: providerError.category,
              retryCount: retriesUsed,
              visibleOutput: false,
            });
            try {
              await this.sleep(decision.delayMs, options?.signal);
            } catch (delayError) {
              throw classifyProviderError(delayError, {
                backendId,
                logicalModelId: routeId,
                upstreamModelId,
                signal: options?.signal,
                now: this.now(),
              });
            }
            continue;
          }

          switchFrom = {
            backendId,
            reason: providerError.category,
          };
          break;
        }
      }
      } finally {
        recoveryLease.release();
      }
    }

    await emitter.emit({
      type: "exhausted",
      phase: "complete",
      finalStatus: "exhausted",
      ...(switchFrom ? { backendId: switchFrom.backendId, reason: switchFrom.reason } : {}),
      retryCount: 0,
      visibleOutput: false,
    });
    throw new RouteExhaustedError(routeId, failures);
  }

  public resetBackend(backendId: string, at = this.now()) {
    return this.healthStore.reset(backendId, at);
  }

  public recordProbe(update: BackendProbeUpdate) {
    return this.healthStore.recordProbe(update);
  }

  private createBackendClient(
    resolved: Awaited<ReturnType<BackendPool["resolve"]>>["candidates"][number],
  ): LLMClient {
    const { backend, candidate, credential } = resolved;
    const client = createLLMClient({
      provider: backend.provider,
      service: backend.service,
      configSource: this.options.baseConfig.configSource,
      baseUrl: backend.baseUrl,
      apiKey: credential.kind === "api_key" ? credential.apiKey : "",
      model: candidate.upstreamModelId,
      proxyUrl: this.options.baseConfig.proxyUrl,
      temperature: this.options.baseConfig.temperature,
      thinkingBudget: this.options.baseConfig.thinkingBudget,
      extra: this.options.baseConfig.extra,
      headers: this.options.baseConfig.headers,
      apiFormat: backend.transport.apiFormat,
      stream: backend.transport.stream,
    });
    return {
      ...client,
      _routingBackendId: backend.id,
      ...(credential.kind === "codex"
        ? { _codexCredential: credential }
        : {}),
      ...(credential.kind === "grok_oauth"
        ? { _grokCredential: credential }
        : {}),
    };
  }

  private resolveRoutePrompt(
    route: Awaited<ReturnType<BackendPool["resolve"]>>["route"],
    mode: ChatCompletionOptions["modelGlobalPrompt"],
  ) {
    const firstCandidate = route.candidates[0];
    const firstBackend = firstCandidate
      ? this.options.routing.backends.find((backend) => backend.id === firstCandidate.backendId)
      : undefined;
    return resolveModelGlobalPrompt({
      configuredFamily: route.promptFamily,
      endpoint: firstBackend?.baseUrl,
      service: firstBackend?.service,
      model: firstCandidate?.upstreamModelId,
      mode,
    });
  }
}

function snapshotMessages(
  messages: ReadonlyArray<LLMMessage>,
): ReadonlyArray<LLMMessage> {
  return messages.map((message) => Object.freeze({ ...message }));
}

function cloneMessages(
  messages: ReadonlyArray<LLMMessage>,
): ReadonlyArray<LLMMessage> {
  return messages.map((message) => ({ ...message }));
}

function skippedCandidateFailure(
  candidate: SkippedBackendCandidate,
): RoutingAttemptFailure {
  return {
    backendId: candidate.backendId,
    upstreamModelId: candidate.upstreamModelId,
    attemptNumber: 0,
    category: "candidate_unavailable",
    safeReason: candidateSkipMessage(candidate),
    visibleOutput: false,
  };
}

function candidateSkipMessage(candidate: SkippedBackendCandidate): string {
  switch (candidate.reason) {
    case "disabled":
      return "Backend is disabled.";
    case "duplicate_backend":
      return "Backend was already present in this route.";
    case "missing_backend":
      return "Backend configuration is unavailable.";
    case "already_attempted":
      return "Backend was already attempted for this request.";
    case "health_unavailable":
      return "Backend is unavailable according to persisted health state.";
    case "unsupported_credential_kind":
      return "Credential kind is not supported by this runtime.";
    case "credential_unavailable":
      return "API key credential is unavailable.";
    case "model_unsupported":
      return "Backend does not support the configured upstream model.";
  }
}

function throwIfRoutingCancelled(
  signal: AbortSignal | undefined,
  context: {
    readonly backendId?: string;
    readonly logicalModelId: string;
    readonly upstreamModelId?: string;
  },
): void {
  if (!signal?.aborted) return;
  throw classifyProviderError(
    signal.reason ?? new DOMException("LLM request aborted", "AbortError"),
    { ...context, signal },
  );
}

function sanitizeRoutingField(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b(api[_ -]?key|token|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\b(?:sk|key|token|xai)-[A-Za-z0-9._-]{8,}\b/gi, "[REDACTED]")
    .replace(/\b(?:AIza[0-9A-Za-z_-]{20,}|(?:ghp|gsk|sk_live)_[A-Za-z0-9_-]{16,})\b/g, "[REDACTED]")
    .replace(/[\r\n\t]/g, " ")
    .trim()
    .slice(0, 160);
}

function shouldRecordBackendFailure(error: ProviderError): boolean {
  return !error.cancelled
    && error.category !== "invalid_request"
    && error.category !== "context_overflow"
    && error.category !== "content_policy";
}

function routingUsageFromUnknown(error: unknown) {
  if (!error || typeof error !== "object" || !("usage" in error)) return undefined;
  const usage = (error as { readonly usage?: Record<string, unknown> }).usage;
  if (!usage) return undefined;
  const inputTokens = finiteToken(usage.promptTokens ?? usage.inputTokens ?? usage.input);
  const outputTokens = finiteToken(
    usage.completionTokens ?? usage.outputTokens ?? usage.output,
  );
  const cacheReadTokens = finiteToken(usage.cacheReadTokens ?? usage.cacheRead);
  const cacheWriteTokens = finiteToken(usage.cacheWriteTokens ?? usage.cacheWrite);
  const reasoningTokens = finiteToken(usage.reasoningTokens ?? usage.reasoning);
  const values = [
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
  ];
  if (!values.some((value) => value !== null)) return undefined;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    providerObserved: true,
  };
}

function finiteToken(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}
