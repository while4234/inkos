import { createHash } from "node:crypto";
import {
  createAssistantMessageEventStream,
  streamSimple,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import { BackendPool, type BackendPoolOptions, type ResolvedBackendCandidate, type SkippedBackendCandidate } from "../llm/backend-pool.js";
import {
  FileBackendHealthStore,
  type BackendHealthStore,
} from "../llm/backend-health-store.js";
import { tryAcquireBackendRecoveryLease } from "../llm/health-recovery.js";
import {
  createProjectCredentialResolver,
  type CredentialResolver,
  type ResolvedCredential,
} from "../llm/credentials/index.js";
import {
  abortableRoutingDelay,
  decideFailover,
  DEFAULT_FAILOVER_POLICY,
  type FailoverPolicyConfig,
} from "../llm/failover-policy.js";
import {
  applyModelGlobalPrompt,
  modelGlobalPromptOverridesFromConfig,
  resolveModelGlobalPrompt,
  toModelGlobalPromptTrace,
  transformGrokHistory,
  type ModelGlobalPromptResolution,
} from "../llm/model-global-prompt.js";
import type { ModelRoutingConfig } from "../llm/model-routing.js";
import {
  classifyProviderError,
  ProviderError,
  type ProviderErrorAttemptSummary,
  type ProviderErrorCategory,
} from "../llm/provider-error.js";
import {
  assertWithinContextWindow,
  createLLMClient,
  estimatePiContextTokens,
} from "../llm/provider.js";
import {
  RoutingEventEmitter,
  type RoutingEventObserver,
  type RoutingTraceContext,
} from "../llm/routing-trace.js";
import {
  CODEX_ORIGINATOR,
  CODEX_USER_AGENT,
} from "../llm/codex-responses-transport.js";

const MAX_BUFFERED_METADATA_EVENTS = 32;
const MAX_BUFFERED_METADATA_BYTES = 64 * 1024;

export interface AgentRouteReference {
  readonly routeId: string;
  /** Stable, secret-free fingerprint used to evict stale cached Agents. */
  readonly revision: string;
}

export interface AgentRouteStreamOptions {
  readonly signal?: AbortSignal;
  readonly forwardThinking?: boolean;
  readonly observer?: RoutingEventObserver;
  readonly onTerminalError?: (error: ProviderError | AgentRouteExhaustedError) => void;
  /** Shared by every pi stream invocation in one Agent turn. */
  readonly continuity?: AgentRouteContinuity;
  /** Safe operation metadata copied into the unified routing trace. */
  readonly routingContext?: RoutingTraceContext;
}

export interface AgentRouteContinuity {
  material: boolean;
  lockedBackendId?: string;
  upstreamModelId?: string;
}

export type AgentStreamInvoke = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export interface AgentRouteRuntimeOptions extends BackendPoolOptions {
  readonly routing: ModelRoutingConfig;
  readonly projectRoot: string;
  readonly baseConfig: Parameters<typeof createLLMClient>[0];
  readonly credentials?: CredentialResolver;
  readonly healthStore?: BackendHealthStore;
  readonly observer?: RoutingEventObserver;
  readonly policy?: FailoverPolicyConfig;
  readonly sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  readonly invoke?: AgentStreamInvoke;
  readonly now?: () => number;
}

export class AgentRouteExhaustedError extends Error {
  public constructor(
    public readonly logicalModelId: string,
    public readonly attempts: ReadonlyArray<ProviderErrorAttemptSummary>,
  ) {
    super(`Logical model route "${safeField(logicalModelId)}" exhausted all available backends.`);
    this.name = "AgentRouteExhaustedError";
  }
}

export class AgentRouteRuntime {
  public readonly healthStore: BackendHealthStore;
  private readonly pool: BackendPool;
  private readonly policy: FailoverPolicyConfig;
  private readonly sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  private readonly invoke: AgentStreamInvoke;
  private readonly now: () => number;

  public constructor(private readonly options: AgentRouteRuntimeOptions) {
    this.healthStore = options.healthStore ?? new FileBackendHealthStore(options.projectRoot);
    const credentials = options.credentials ?? createProjectCredentialResolver(options.projectRoot);
    this.now = options.now ?? Date.now;
    this.pool = new BackendPool(options.routing, credentials, this.healthStore, {
      supportsModel: options.supportsModel,
      now: this.now,
    });
    this.policy = options.policy ?? DEFAULT_FAILOVER_POLICY;
    this.sleep = options.sleep ?? abortableRoutingDelay;
    this.invoke = options.invoke ?? streamSimple;
  }

  public reference(routeId: string): AgentRouteReference {
    const route = this.options.routing.routes.find((candidate) => candidate.id === routeId);
    if (!route) throw new Error(`Logical model route "${routeId}" is not configured.`);
    const backendIds = new Set(route.candidates.map((candidate) => candidate.backendId));
    const snapshot = {
      version: this.options.routing.version,
      route,
      backends: this.options.routing.backends
        .filter((backend) => backendIds.has(backend.id))
        .map((backend) => ({
          id: backend.id,
          service: backend.service,
          provider: backend.provider,
          baseUrl: backend.baseUrl,
          credentialRef: backend.credentialRef,
          enabled: backend.enabled,
          transport: backend.transport,
        })),
    };
    return {
      routeId,
      revision: createHash("sha256")
        .update(JSON.stringify(snapshot))
        .digest("hex")
        .slice(0, 20),
    };
  }

  /** Secret-free model template used only for pi-agent state and context shaping. */
  public compatibilityModel(reference: AgentRouteReference): Model<Api> {
    if (this.reference(reference.routeId).revision !== reference.revision) {
      throw new Error(`Logical model route "${reference.routeId}" changed before Agent construction.`);
    }
    const route = this.options.routing.routes.find((candidate) => candidate.id === reference.routeId);
    const candidate = route?.candidates[0];
    const backend = candidate
      ? this.options.routing.backends.find((entry) => entry.id === candidate.backendId)
      : undefined;
    if (!candidate || !backend) {
      throw new Error(`Logical model route "${reference.routeId}" has no configured backend candidate.`);
    }
    const client = createLLMClient({
      ...this.options.baseConfig,
      provider: backend.provider,
      service: backend.service,
      baseUrl: backend.baseUrl,
      apiKey: "",
      model: candidate.upstreamModelId,
      apiFormat: backend.transport.apiFormat,
      stream: true,
    });
    if (!client._piModel) {
      throw new Error(`Backend "${backend.id}" did not resolve a pi-ai model.`);
    }
    return { ...client._piModel, id: candidate.upstreamModelId };
  }

  public stream(
    reference: AgentRouteReference,
    originalContext: Context,
    streamOptions: SimpleStreamOptions | undefined,
    routeOptions: AgentRouteStreamOptions = {},
  ): AssistantMessageEventStream {
    const output = createAssistantMessageEventStream();
    queueMicrotask(() => {
      void this.run(reference, originalContext, streamOptions, routeOptions, output);
    });
    return output;
  }

  private async run(
    reference: AgentRouteReference,
    originalContext: Context,
    streamOptions: SimpleStreamOptions | undefined,
    routeOptions: AgentRouteStreamOptions,
    output: AssistantMessageEventStream,
  ): Promise<void> {
    const signal = routeOptions.signal ?? streamOptions?.signal;
    const forwardThinking = routeOptions.forwardThinking ?? true;
    try {
      const currentReference = this.reference(reference.routeId);
      if (currentReference.revision !== reference.revision) {
        const stale = classifyProviderError(
          new Error(`Logical model route "${safeField(reference.routeId)}" changed before dispatch.`),
          { logicalModelId: reference.routeId },
        );
        notifyTerminalError(routeOptions, stale);
        finishWithError(output, undefined, stale);
        return;
      }
      const route = this.options.routing.routes.find((candidate) => candidate.id === reference.routeId);
      const continuity = routeOptions.continuity;
      const lockedCandidate = continuity?.material
        ? resolveLockedCandidate(continuity, route)
        : undefined;
      if (continuity?.material && !lockedCandidate) {
        const invalidContinuity = new ProviderError({
          category: "model_unavailable",
          safeMessage: "The backend selected earlier in this Agent turn is no longer available.",
          logicalModelId: reference.routeId,
          visibleOutput: true,
        });
        notifyTerminalError(routeOptions, invalidContinuity);
        finishWithError(output, undefined, invalidContinuity);
        return;
      }
      const excludedBackendIds = lockedCandidate
        ? new Set(
            route?.candidates
              .map((candidate) => candidate.backendId)
              .filter((backendId) => backendId !== lockedCandidate.backendId),
          )
        : new Set<string>();
      const resolution = await this.pool.resolve(reference.routeId, excludedBackendIds, signal);
      const promptResolution = resolveRoutePrompt(this.options.routing, resolution.route);
      const observer = composeObservers(this.options.observer, routeOptions.observer);
      const emitter = new RoutingEventEmitter(
        reference.routeId,
        observer,
        this.now,
        undefined,
        toModelGlobalPromptTrace(promptResolution),
        routeOptions.routingContext,
      );
      const relevantSkipped = lockedCandidate
        ? resolution.skipped.filter((candidate) =>
            candidate.backendId === lockedCandidate.backendId
            && candidate.upstreamModelId === lockedCandidate.upstreamModelId
          )
        : resolution.skipped;
      const failures: ProviderErrorAttemptSummary[] = relevantSkipped.map((candidate) =>
        skippedAttempt(reference.routeId, candidate)
      );
      if (lockedCandidate && resolution.candidates.length === 0) {
        await emitter.emit({
          type: "exhausted",
          phase: "complete",
          finalStatus: "interrupted",
          backendId: lockedCandidate.backendId,
          upstreamModelId: lockedCandidate.upstreamModelId,
          reason: "candidate_unavailable",
          retryCount: 0,
          visibleOutput: true,
        });
        const unavailable = new ProviderError({
          category: "model_unavailable",
          safeMessage: "The backend selected earlier in this Agent turn is no longer available.",
          backendId: lockedCandidate.backendId,
          logicalModelId: reference.routeId,
          upstreamModelId: lockedCandidate.upstreamModelId,
          visibleOutput: true,
          attempts: failures,
        });
        notifyTerminalError(routeOptions, unavailable);
        finishWithError(output, undefined, unavailable);
        return;
      }
      let switchFrom: { readonly backendId: string; readonly reason: ProviderErrorCategory } | undefined;
      const healthSnapshot = await this.healthStore.read();

      throwIfCancelled(signal, reference.routeId);
      for (const resolvedCandidate of resolution.candidates) {
        throwIfCancelled(signal, reference.routeId);
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
            logicalModelId: reference.routeId,
            upstreamModelId,
            attemptNumber: 0,
            category: "model_unavailable",
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
          throwIfCancelled(signal, reference.routeId);
          switchFrom = undefined;
        }

        let retriesUsed = 0;
        let forcedRefreshUsed = false;
        let credential = resolvedCandidate.credential;
        while (true) {
          throwIfCancelled(signal, reference.routeId, backendId, upstreamModelId);
          const attemptNumber = retriesUsed + 1;
          await emitter.emit({
            type: "attempt_started",
            phase: "request",
            backendId,
            upstreamModelId,
            credentialKind: credential.kind,
            ...(resolvedCandidate.candidate.pricing
              ? { pricing: resolvedCandidate.candidate.pricing }
              : {}),
            retryCount: retriesUsed,
            visibleOutput: false,
          });
          throwIfCancelled(signal, reference.routeId, backendId, upstreamModelId);

          const attempt = await this.consumeAttempt({
            resolvedCandidate,
            credential,
            originalContext,
            promptResolution,
            streamOptions: { ...streamOptions, signal },
            output,
            forwardThinking,
            continuity: routeOptions.continuity,
          });
          if (attempt.kind === "success") {
            await this.healthStore.recordSuccess(reference.routeId, backendId, this.now());
            await emitter.emit({
              type: "succeeded",
              phase: "complete",
              finalStatus: "succeeded",
              backendId,
              upstreamModelId,
              credentialKind: credential.kind,
              usage: routingUsageFromAssistantMessage(attempt.terminalEvent.message),
              ...(resolvedCandidate.candidate.pricing
                ? { pricing: resolvedCandidate.candidate.pricing }
                : {}),
              retryCount: retriesUsed,
              visibleOutput: attempt.visibleOutput,
            });
            output.push(attempt.terminalEvent);
            output.end(attempt.terminalEvent.message);
            return;
          }

          let providerError = withProviderRouteContext(
            classifyProviderError(attempt.error, {
              backendId,
              logicalModelId: reference.routeId,
              upstreamModelId,
              signal,
              visibleOutput: attempt.visibleOutput,
              now: this.now(),
            }),
            {
              backendId,
              logicalModelId: reference.routeId,
              upstreamModelId,
            },
          );
          if (attempt.visibleOutput && !providerError.visibleOutput) {
            providerError = providerError.withVisibleOutput();
          }

          if (
            providerError.category === "auth"
            && !providerError.visibleOutput
            && !forcedRefreshUsed
            && credential.kind !== "api_key"
          ) {
            forcedRefreshUsed = true;
            try {
              await emitter.emit({
                type: "failed",
                phase: "request",
                backendId,
                upstreamModelId,
                credentialKind: credential.kind,
                ...(resolvedCandidate.candidate.pricing
                  ? { pricing: resolvedCandidate.candidate.pricing }
                  : {}),
                ...(attempt.lastMessage
                  ? { usage: routingUsageFromAssistantMessage(attempt.lastMessage) }
                  : {}),
                reason: "auth",
                retryCount: retriesUsed,
                visibleOutput: false,
              });
              credential = await credential.refresh(true, { signal });
              retriesUsed += 1;
              await emitter.emit({
                type: "local_retry",
                phase: "retry",
                backendId,
                upstreamModelId,
                reason: "auth",
                retryCount: retriesUsed,
                visibleOutput: false,
              });
              continue;
            } catch (refreshError) {
              if (credential.kind === "grok_oauth") {
                await credential.markAuthRequired().catch(() => undefined);
              }
              providerError = classifyProviderError({
                status: providerError.status ?? 401,
                code: "invalid_token",
                providerCause: refreshError,
              }, {
                backendId,
                logicalModelId: reference.routeId,
                upstreamModelId,
                signal,
              });
            }
          } else if (
            providerError.category === "auth"
            && credential.kind === "grok_oauth"
          ) {
            await credential.markAuthRequired().catch(() => undefined);
          }

          const attemptSummary: ProviderErrorAttemptSummary = {
            backendId,
            logicalModelId: reference.routeId,
            upstreamModelId,
            attemptNumber,
            category: providerError.category,
            safeReason: providerError.safeMessage,
            visibleOutput: providerError.visibleOutput,
          };
          failures.push(attemptSummary);
          const decision = providerError.visibleOutput
            ? {
                action: "fail" as const,
                delayMs: 0,
                healthStatus: healthStatusForVisibleFailure(providerError.category),
                reason: "visible_output" as const,
              }
            : decideFailover(providerError, retriesUsed, this.policy);
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
            credentialKind: credential.kind,
            ...(resolvedCandidate.candidate.pricing
              ? { pricing: resolvedCandidate.candidate.pricing }
              : {}),
            ...(attempt.lastMessage
              ? { usage: routingUsageFromAssistantMessage(attempt.lastMessage) }
              : {}),
            reason: providerError.category,
            retryCount: retriesUsed,
            visibleOutput: providerError.visibleOutput,
          });

          if (decision.action === "fail") {
            const terminal = providerError.withAttempts(failures);
            notifyTerminalError(routeOptions, terminal);
            finishWithError(output, attempt.lastMessage, terminal);
            return;
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
            await this.sleep(decision.delayMs, signal);
            continue;
          }
          switchFrom = { backendId, reason: providerError.category };
          break;
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
      const exhausted = classifyProviderError(
        new Error(`Logical model route "${safeField(reference.routeId)}" exhausted all available backends.`),
        { logicalModelId: reference.routeId },
      ).withAttempts(failures);
      notifyTerminalError(routeOptions, exhausted);
      finishWithError(output, undefined, exhausted);
    } catch (error) {
      const providerError = classifyProviderError(error, {
        logicalModelId: reference.routeId,
        signal,
      });
      notifyTerminalError(routeOptions, providerError);
      finishWithError(output, undefined, providerError);
    }
  }

  private async consumeAttempt(input: {
    readonly resolvedCandidate: ResolvedBackendCandidate;
    readonly credential: ResolvedCredential;
    readonly originalContext: Context;
    readonly promptResolution: ModelGlobalPromptResolution;
    readonly streamOptions: SimpleStreamOptions;
    readonly output: AssistantMessageEventStream;
    readonly forwardThinking: boolean;
    readonly continuity?: AgentRouteContinuity;
  }): Promise<
    | {
        readonly kind: "success";
        readonly visibleOutput: boolean;
        readonly terminalEvent: Extract<AssistantMessageEvent, { readonly type: "done" }>;
      }
    | {
        readonly kind: "failure";
        readonly error: unknown;
        readonly visibleOutput: boolean;
        readonly lastMessage?: AssistantMessage;
      }
  > {
    const { model, options } = createCandidateInvocation(
      this.options.baseConfig,
      input.resolvedCandidate,
      input.credential,
      input.streamOptions,
    );
    const context = prepareAgentCandidateContext(
      input.originalContext,
      input.promptResolution,
      input.promptResolution.family === "grok",
    );
    let source: AssistantMessageEventStream;
    const requestMaterial = input.continuity?.material ?? false;
    try {
      const reservedOutputTokens = Number.isFinite(options.maxTokens)
        ? options.maxTokens!
        : Number.isFinite(model.maxTokens)
          ? model.maxTokens
          : 4096;
      assertWithinContextWindow({
        piModel: model,
        model: model.id,
        estimatedInputTokens: estimatePiContextTokens(context),
        reservedOutputTokens,
      });
      source = this.invoke(model, context, options);
    } catch (error) {
      return { kind: "failure", error, visibleOutput: requestMaterial };
    }

    const buffered: AssistantMessageEvent[] = [];
    let bufferedBytes = 0;
    let attemptMaterial = false;
    let lastMessage: AssistantMessage | undefined;
    try {
      for await (const event of source) {
        input.streamOptions.signal?.throwIfAborted();
        lastMessage = eventMessage(event) ?? lastMessage;
        if (event.type === "error") {
          return {
            kind: "failure",
            error: providerFailureFromEvent(event),
            visibleOutput: requestMaterial || attemptMaterial,
            lastMessage: event.error,
          };
        }
        if (event.type === "done") {
          if (isMaterialAssistantMessage(event.message, input.forwardThinking)) {
            attemptMaterial = true;
            lockContinuity(input.continuity, input.resolvedCandidate);
          }
          flushBuffered(input.output, buffered);
          return {
            kind: "success",
            visibleOutput: requestMaterial || attemptMaterial,
            terminalEvent: event,
          };
        }
        if (isMaterialAgentStreamEvent(event, input.forwardThinking)) {
          if (!attemptMaterial) {
            flushBuffered(input.output, buffered);
            bufferedBytes = 0;
          }
          attemptMaterial = true;
          lockContinuity(input.continuity, input.resolvedCandidate);
          input.output.push(event);
          continue;
        }
        if (!input.forwardThinking && isThinkingEvent(event)) continue;
        bufferedBytes += estimateEventBytes(event);
        if (
          buffered.length >= MAX_BUFFERED_METADATA_EVENTS
          || bufferedBytes > MAX_BUFFERED_METADATA_BYTES
        ) {
          return {
            kind: "failure",
            error: new Error("Provider metadata buffer exceeded the bounded pre-output limit."),
            visibleOutput: requestMaterial || attemptMaterial,
            lastMessage,
          };
        }
        buffered.push(event);
      }
      return {
        kind: "failure",
        error: new Error("Provider stream ended without a terminal event."),
        visibleOutput: requestMaterial || attemptMaterial,
        lastMessage,
      };
    } catch (error) {
      return {
        kind: "failure",
        error,
        visibleOutput: requestMaterial || attemptMaterial,
        lastMessage,
      };
    }
  }
}

export function isMaterialAgentStreamEvent(
  event: AssistantMessageEvent,
  forwardThinking = true,
): boolean {
  switch (event.type) {
    case "text_delta":
      return event.delta.length > 0;
    case "text_end":
      return event.content.length > 0;
    case "thinking_delta":
      return forwardThinking && event.delta.length > 0;
    case "thinking_end":
      return forwardThinking && event.content.length > 0;
    case "toolcall_start":
    case "toolcall_delta":
    case "toolcall_end":
      return true;
    case "start":
    case "text_start":
    case "thinking_start":
    case "done":
    case "error":
      return false;
  }
}

function isMaterialAssistantMessage(
  message: AssistantMessage,
  forwardThinking: boolean,
): boolean {
  return message.content.some((content) => {
    if (content.type === "text") return content.text.length > 0;
    if (content.type === "thinking") {
      return forwardThinking && content.thinking.length > 0;
    }
    return content.type === "toolCall";
  });
}

function resolveLockedCandidate(
  continuity: AgentRouteContinuity,
  route: ModelRoutingConfig["routes"][number] | undefined,
): { readonly backendId: string; readonly upstreamModelId: string } | undefined {
  if (!continuity.lockedBackendId || !continuity.upstreamModelId) return undefined;
  return route?.candidates.find((candidate) =>
    candidate.backendId === continuity.lockedBackendId
    && candidate.upstreamModelId === continuity.upstreamModelId
  );
}

function lockContinuity(
  continuity: AgentRouteContinuity | undefined,
  resolvedCandidate: ResolvedBackendCandidate,
): void {
  if (!continuity) return;
  const backendId = resolvedCandidate.backend.id;
  const upstreamModelId = resolvedCandidate.candidate.upstreamModelId;
  if (
    (continuity.lockedBackendId && continuity.lockedBackendId !== backendId)
    || (continuity.upstreamModelId && continuity.upstreamModelId !== upstreamModelId)
  ) {
    throw new Error("Agent turn continuity attempted to change backend after material output.");
  }
  continuity.lockedBackendId = backendId;
  continuity.upstreamModelId = upstreamModelId;
  continuity.material = true;
}

export function prepareAgentCandidateContext(
  original: Context,
  promptResolution: ModelGlobalPromptResolution,
  grokHistory: boolean,
): Context {
  const cloned = cloneValue(original);
  const prompt = applyModelGlobalPrompt([{
    role: "system",
    content: cloned.systemPrompt ?? "",
  }], promptResolution).messages[0]?.content;
  const messages = grokHistory
    ? transformGrokHistory(cloned.messages)
    : cloned.messages;
  return {
    ...cloned,
    systemPrompt: typeof prompt === "string" ? prompt : cloned.systemPrompt,
    messages: messages as Context["messages"],
  };
}

function createCandidateInvocation(
  baseConfig: AgentRouteRuntimeOptions["baseConfig"],
  resolved: ResolvedBackendCandidate,
  credential: ResolvedCredential,
  streamOptions: SimpleStreamOptions,
): { readonly model: Model<Api>; readonly options: SimpleStreamOptions } {
  const client = createLLMClient({
    ...baseConfig,
    provider: resolved.backend.provider,
    service: resolved.backend.service,
    baseUrl: resolved.backend.baseUrl,
    apiKey: "",
    model: resolved.candidate.upstreamModelId,
    apiFormat: resolved.backend.transport.apiFormat,
    stream: true,
  });
  if (!client._piModel) {
    throw new Error(`Backend "${resolved.backend.id}" did not resolve a pi-ai model.`);
  }
  let model = { ...client._piModel, id: resolved.candidate.upstreamModelId };
  let headers = model.headers;
  if (credential.kind === "codex") {
    if (resolved.backend.transport.apiFormat !== "responses") {
      throw new Error(`Codex backend "${resolved.backend.id}" must use the Responses transport.`);
    }
    model = {
      ...model,
      api: "openai-codex-responses",
      provider: "openai-codex",
      headers: {
        ...headers,
        originator: CODEX_ORIGINATOR,
        "User-Agent": CODEX_USER_AGENT,
        ...(credential.accountId ? { "chatgpt-account-id": credential.accountId } : {}),
      },
    };
    headers = model.headers;
  }
  if (credential.kind === "grok_oauth" && resolved.backend.transport.apiFormat !== "chat") {
    throw new Error(`Grok backend "${resolved.backend.id}" must use the Chat Completions transport.`);
  }
  return {
    model,
    options: {
      ...streamOptions,
      apiKey: credential.kind === "api_key" ? credential.apiKey : credential.accessToken,
      headers,
    },
  };
}

function resolveRoutePrompt(
  routing: ModelRoutingConfig,
  route: ModelRoutingConfig["routes"][number],
): ModelGlobalPromptResolution {
  const firstCandidate = route.candidates[0];
  const firstBackend = firstCandidate
    ? routing.backends.find((backend) => backend.id === firstCandidate.backendId)
    : undefined;
  return resolveModelGlobalPrompt({
    configuredFamily: route.promptFamily,
    endpoint: firstBackend?.baseUrl,
    service: firstBackend?.service,
    model: firstCandidate?.upstreamModelId,
    customPrompts: modelGlobalPromptOverridesFromConfig(
      routing.modelGlobalPrompts,
    ),
  });
}

function composeObservers(
  first: RoutingEventObserver | undefined,
  second: RoutingEventObserver | undefined,
): RoutingEventObserver | undefined {
  if (!first && !second) return undefined;
  return async (event) => {
    await Promise.allSettled(
      [first, second]
        .filter((observer): observer is RoutingEventObserver => Boolean(observer))
        .map((observer) => Promise.resolve().then(() => observer(event))),
    );
  };
}

function notifyTerminalError(
  options: AgentRouteStreamOptions,
  error: ProviderError | AgentRouteExhaustedError,
): void {
  try {
    options.onTerminalError?.(error);
  } catch {
    // Observability must never leave the downstream stream unsettled.
  }
}

function skippedAttempt(
  routeId: string,
  candidate: SkippedBackendCandidate,
): ProviderErrorAttemptSummary {
  return {
    backendId: candidate.backendId,
    logicalModelId: routeId,
    upstreamModelId: candidate.upstreamModelId,
    attemptNumber: 0,
    category: "model_unavailable",
    safeReason: `Backend candidate unavailable (${candidate.reason}).`,
    visibleOutput: false,
  };
}

function withProviderRouteContext(
  error: ProviderError,
  context: {
    readonly backendId: string;
    readonly logicalModelId: string;
    readonly upstreamModelId: string;
  },
): ProviderError {
  if (error.backendId && error.logicalModelId && error.upstreamModelId) return error;
  return new ProviderError({
    category: error.category,
    safeMessage: error.safeMessage,
    status: error.status,
    upstreamCode: error.upstreamCode,
    upstreamType: error.upstreamType,
    retryAfter: error.retryAfter,
    requestId: error.requestId,
    backendId: error.backendId ?? context.backendId,
    logicalModelId: error.logicalModelId ?? context.logicalModelId,
    upstreamModelId: error.upstreamModelId ?? context.upstreamModelId,
    visibleOutput: error.visibleOutput,
    cancelled: error.cancelled,
    cause: error.cause,
    attempts: error.attempts,
  });
}

function throwIfCancelled(
  signal: AbortSignal | undefined,
  logicalModelId: string,
  backendId?: string,
  upstreamModelId?: string,
): void {
  if (!signal?.aborted) return;
  throw classifyProviderError(
    signal.reason ?? new DOMException("LLM request aborted", "AbortError"),
    { signal, logicalModelId, backendId, upstreamModelId },
  );
}

function shouldRecordBackendFailure(error: ProviderError): boolean {
  return !error.cancelled
    && error.category !== "invalid_request"
    && error.category !== "context_overflow"
    && error.category !== "content_policy";
}

function healthStatusForVisibleFailure(
  category: ProviderErrorCategory,
): "temporary_cooldown" | "quota_exhausted" | "auth_required" | "unknown" {
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

function providerFailureFromEvent(
  event: Extract<AssistantMessageEvent, { readonly type: "error" }>,
): unknown {
  const raw = event.error as AssistantMessage & {
    readonly providerError?: unknown;
    readonly status?: unknown;
    readonly code?: unknown;
  };
  if (raw.providerError) return raw.providerError;
  const message = raw.errorMessage ?? "Provider stream failed.";
  const embeddedStatus = /\b(401|402|403|408|409|413|422|429|500|502|503|504)\b/.exec(message);
  const status = typeof raw.status === "number"
    ? raw.status
    : embeddedStatus
      ? Number(embeddedStatus[1])
      : undefined;
  const code = typeof raw.code === "string"
    ? raw.code
    : /\b(invalid_token|insufficient_quota|rate_limit(?:ed)?|model_not_found)\b/i.exec(message)?.[1];
  return status === undefined && code === undefined
    ? new Error(message)
    : { status, code, message };
}

function flushBuffered(
  output: AssistantMessageEventStream,
  events: AssistantMessageEvent[],
): void {
  for (const event of events) output.push(event);
  events.length = 0;
}

function finishWithError(
  output: AssistantMessageEventStream,
  partial: AssistantMessage | undefined,
  error: Error,
): void {
  const source = partial ?? emptyAssistantMessage();
  const message: AssistantMessage = {
    role: "assistant",
    content: source.content,
    api: source.api,
    provider: source.provider,
    model: source.model,
    usage: source.usage,
    stopReason: error instanceof ProviderError && error.cancelled ? "aborted" : "error",
    errorMessage: error.message,
    timestamp: source.timestamp,
  };
  output.push({
    type: "error",
    reason: message.stopReason === "aborted" ? "aborted" : "error",
    error: message,
  });
  output.end(message);
}

function emptyAssistantMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "inkos-routing",
    model: "logical-route",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    timestamp: Date.now(),
  };
}

function eventMessage(event: AssistantMessageEvent): AssistantMessage | undefined {
  if ("partial" in event) return event.partial;
  if (event.type === "done") return event.message;
  if (event.type === "error") return event.error;
  return undefined;
}

function isThinkingEvent(event: AssistantMessageEvent): boolean {
  return event.type === "thinking_start"
    || event.type === "thinking_delta"
    || event.type === "thinking_end";
}

function estimateEventBytes(event: AssistantMessageEvent): number {
  if ("delta" in event) return event.type.length + event.delta.length * 2 + 32;
  if ("content" in event) return event.type.length + event.content.length * 2 + 32;
  return 256;
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => cloneValue(entry)) as T;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key, cloneValue(entry)]),
  ) as T;
}

function safeField(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, 80) || "unknown";
}

function routingUsageFromAssistantMessage(message: AssistantMessage) {
  const usage = message.usage;
  const inputTokens = finiteToken(usage?.input);
  const outputTokens = finiteToken(usage?.output);
  const cacheReadTokens = finiteToken(usage?.cacheRead);
  const cacheWriteTokens = finiteToken(usage?.cacheWrite);
  const reasoningTokens = finiteToken(
    (usage as { readonly reasoning?: number } | undefined)?.reasoning,
  );
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    providerObserved: [
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens,
    ].some((value) => value !== null && value > 0),
  };
}

function finiteToken(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}
