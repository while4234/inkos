import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CredentialKind, ModelPriceMetadata } from "./model-routing.js";
import type { ModelGlobalPromptTraceMetadata } from "./model-global-prompt.js";
import type { ProviderErrorCategory } from "./provider-error.js";

export const ROUTING_TRACE_SCHEMA_VERSION = 1 as const;
export const MAX_ROUTING_TRACE_ATTEMPTS = 100;
export const MAX_ROUTING_TRACE_SWITCHES = 50;

export const ROUTING_EVENT_TYPES = [
  "attempt_started",
  "local_retry",
  "backend_switched",
  "succeeded",
  "failed",
  "exhausted",
] as const;

export type RoutingEventType = typeof ROUTING_EVENT_TYPES[number];
export type RoutingEventPhase = "selection" | "request" | "retry" | "complete";
export type RoutingFinalStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "cancelled"
  | "exhausted";

export interface RoutingTokenUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly reasoningTokens: number | null;
  /**
   * True only when the provider returned usage. A failed or partial response
   * without provider usage remains unknown and is never converted to zero.
   */
  readonly providerObserved: boolean;
}

export interface RoutingCost {
  readonly status: "known" | "unknown";
  readonly amount: number | null;
  readonly currency: string | null;
  readonly priceSource: string | null;
  readonly priceRevision: string | null;
}

export interface RoutingTraceContext {
  readonly stage?: string;
  readonly agent?: string;
  readonly taskId?: string;
  readonly sessionId?: string;
  readonly bookId?: string;
  readonly chapter?: number;
  readonly operationId?: string;
}

export interface RoutingEvent {
  readonly eventId: string;
  readonly requestId: string;
  readonly type: RoutingEventType;
  readonly timestamp: string;
  readonly logicalModelId: string;
  readonly phase: RoutingEventPhase;
  readonly backendId?: string;
  readonly upstreamModelId?: string;
  readonly credentialKind?: CredentialKind;
  readonly fromBackendId?: string;
  readonly toBackendId?: string;
  readonly reason?: ProviderErrorCategory | "candidate_unavailable";
  readonly retryCount: number;
  readonly visibleOutput: boolean;
  /** Present only when this event ends the logical request. */
  readonly finalStatus?: Exclude<RoutingFinalStatus, "running">;
  readonly usage?: RoutingTokenUsage;
  readonly pricing?: ModelPriceMetadata;
  readonly modelGlobalPrompt?: ModelGlobalPromptTraceMetadata;
  readonly context?: RoutingTraceContext;
}

export interface RoutingTraceAttempt {
  readonly sequence: number;
  readonly backendId: string;
  readonly upstreamModelId: string;
  readonly credentialKind: CredentialKind | "unknown";
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly localRetryCount: number;
  readonly terminalCategory: ProviderErrorCategory | "candidate_unavailable" | null;
  readonly visibleOutput: boolean;
  readonly usage: RoutingTokenUsage;
  readonly cost: RoutingCost;
}

export interface RoutingBackendAggregate {
  readonly backendId: string;
  readonly attemptCount: number;
  readonly localRetryCount: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly cost: RoutingCost;
}

export interface RoutingTrace {
  readonly version: typeof ROUTING_TRACE_SCHEMA_VERSION;
  readonly requestId: string;
  readonly operationId: string;
  readonly logicalModelId: string;
  readonly logicalModelDisplayName: string | null;
  readonly prompt: ModelGlobalPromptTraceMetadata | null;
  readonly context: RoutingTraceContext;
  readonly attempts: ReadonlyArray<RoutingTraceAttempt>;
  readonly switches: ReadonlyArray<{
    readonly at: string;
    readonly fromBackendId: string;
    readonly toBackendId: string;
    readonly reason: ProviderErrorCategory | "candidate_unavailable";
  }>;
  readonly backends: ReadonlyArray<RoutingBackendAggregate>;
  readonly visibleOutput: boolean;
  readonly finalBackendId: string | null;
  readonly finalModelId: string | null;
  readonly finalStatus: RoutingFinalStatus;
}

const NullableTokenSchema = z.number().int().nonnegative().nullable();
export const RoutingTokenUsageSchema = z.object({
  inputTokens: NullableTokenSchema,
  outputTokens: NullableTokenSchema,
  cacheReadTokens: NullableTokenSchema,
  cacheWriteTokens: NullableTokenSchema,
  reasoningTokens: NullableTokenSchema,
  providerObserved: z.boolean(),
}).strict();

export const RoutingCostSchema = z.object({
  status: z.enum(["known", "unknown"]),
  amount: z.number().nonnegative().nullable(),
  currency: z.string().min(1).max(8).nullable(),
  priceSource: z.string().min(1).max(120).nullable(),
  priceRevision: z.string().min(1).max(80).nullable(),
}).strict();

const RoutingTraceAttemptSchema = z.object({
  sequence: z.number().int().positive(),
  backendId: z.string().min(1).max(160),
  upstreamModelId: z.string().min(1).max(160),
  credentialKind: z.enum(["api_key", "codex", "grok_oauth", "unknown"]),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  localRetryCount: z.number().int().nonnegative(),
  terminalCategory: z.string().min(1).max(80).nullable(),
  visibleOutput: z.boolean(),
  usage: RoutingTokenUsageSchema,
  cost: RoutingCostSchema,
}).strict();

const RoutingTraceContextSchema = z.object({
  stage: z.string().min(1).max(120).optional(),
  agent: z.string().min(1).max(120).optional(),
  taskId: z.string().min(1).max(160).optional(),
  sessionId: z.string().min(1).max(160).optional(),
  bookId: z.string().min(1).max(160).optional(),
  chapter: z.number().int().positive().optional(),
  operationId: z.string().min(1).max(160).optional(),
}).strict();

const RoutingBackendAggregateSchema = z.object({
  backendId: z.string().min(1).max(160),
  attemptCount: z.number().int().nonnegative(),
  localRetryCount: z.number().int().nonnegative(),
  inputTokens: NullableTokenSchema,
  outputTokens: NullableTokenSchema,
  cacheReadTokens: NullableTokenSchema,
  cacheWriteTokens: NullableTokenSchema,
  reasoningTokens: NullableTokenSchema,
  cost: RoutingCostSchema,
}).strict();

export const RoutingTraceSchema = z.object({
  version: z.literal(ROUTING_TRACE_SCHEMA_VERSION),
  requestId: z.string().min(1).max(200),
  operationId: z.string().min(1).max(200),
  logicalModelId: z.string().min(1).max(160),
  logicalModelDisplayName: z.string().min(1).max(160).nullable(),
  prompt: z.object({
    family: z.string().min(1).max(40),
    assetId: z.string().min(1).max(120).optional(),
    revision: z.number().int().nonnegative().optional(),
    enabled: z.boolean(),
    source: z.string().min(1).max(80),
  }).strict().nullable(),
  context: RoutingTraceContextSchema,
  attempts: z.array(RoutingTraceAttemptSchema).max(MAX_ROUTING_TRACE_ATTEMPTS),
  switches: z.array(z.object({
    at: z.string().datetime(),
    fromBackendId: z.string().min(1).max(160),
    toBackendId: z.string().min(1).max(160),
    reason: z.string().min(1).max(80),
  }).strict()).max(MAX_ROUTING_TRACE_SWITCHES),
  backends: z.array(RoutingBackendAggregateSchema).max(MAX_ROUTING_TRACE_ATTEMPTS),
  visibleOutput: z.boolean(),
  finalBackendId: z.string().min(1).max(160).nullable(),
  finalModelId: z.string().min(1).max(160).nullable(),
  finalStatus: z.enum([
    "running",
    "succeeded",
    "failed",
    "interrupted",
    "cancelled",
    "exhausted",
  ]),
}).strict();

export type RoutingEventObserver = (event: RoutingEvent) => void | Promise<void>;

export class RoutingEventEmitter {
  private sequence = 0;

  public constructor(
    public readonly logicalModelId: string,
    private readonly observer?: RoutingEventObserver,
    private readonly now: () => number = Date.now,
    public readonly requestId = randomUUID(),
    private readonly modelGlobalPrompt?: ModelGlobalPromptTraceMetadata,
    private readonly context?: RoutingTraceContext,
  ) {}

  public async emit(
    event: Omit<
      RoutingEvent,
      "eventId" | "requestId" | "timestamp" | "logicalModelId" | "modelGlobalPrompt" | "context"
    >,
  ): Promise<void> {
    if (!this.observer) return;
    const sequence = ++this.sequence;
    const routedEvent: RoutingEvent = {
      eventId: `${this.requestId}:${sequence}`,
      requestId: this.requestId,
      timestamp: new Date(this.now()).toISOString(),
      logicalModelId: this.logicalModelId,
      ...(this.modelGlobalPrompt ? { modelGlobalPrompt: this.modelGlobalPrompt } : {}),
      ...(this.context ? { context: sanitizeTraceContext(this.context) } : {}),
      ...event,
    };
    try {
      await this.observer(routedEvent);
    } catch {
      // Observability must not change request success or failover behavior.
    }
  }
}

export class RoutingTraceCollector {
  private readonly events: RoutingEvent[] = [];

  public readonly observer: RoutingEventObserver = (event) => {
    this.events.push(event);
    if (this.events.length > MAX_ROUTING_TRACE_ATTEMPTS * 4) this.events.shift();
  };

  public snapshot(options: {
    readonly logicalModelDisplayName?: string;
    readonly finalStatus?: RoutingFinalStatus;
  } = {}): RoutingTrace | null {
    return buildRoutingTrace(this.events, options);
  }
}

export function buildRoutingTrace(
  events: ReadonlyArray<RoutingEvent>,
  options: {
    readonly logicalModelDisplayName?: string;
    readonly finalStatus?: RoutingFinalStatus;
  } = {},
): RoutingTrace | null {
  const first = events[0];
  if (!first) return null;
  const attempts: RoutingTraceAttempt[] = [];
  let attemptSequence = 0;
  for (const event of events) {
    if (event.type === "attempt_started" && event.backendId && event.upstreamModelId) {
      attempts.push({
        sequence: ++attemptSequence,
        backendId: safeField(event.backendId),
        upstreamModelId: safeField(event.upstreamModelId),
        credentialKind: event.credentialKind ?? "unknown",
        startedAt: event.timestamp,
        endedAt: null,
        localRetryCount: event.retryCount,
        terminalCategory: null,
        visibleOutput: false,
        usage: unknownUsage(),
        cost: unknownCost(),
      });
      if (attempts.length > MAX_ROUTING_TRACE_ATTEMPTS) attempts.shift();
      continue;
    }
    if (event.type !== "succeeded" && event.type !== "failed") continue;
    const attempt = [...attempts].reverse().find((candidate) =>
      candidate.backendId === event.backendId && candidate.endedAt === null
    );
    if (!attempt) continue;
    const usage = normalizeRoutingUsage(event.usage);
    Object.assign(attempt, {
      endedAt: event.timestamp,
      localRetryCount: event.retryCount,
      terminalCategory: event.type === "failed" ? event.reason ?? "unknown" : null,
      visibleOutput: event.visibleOutput,
      usage,
      cost: calculateRoutingCost(usage, event.pricing),
    });
  }

  const switches = events
    .filter((event) => event.type === "backend_switched")
    .flatMap((event) => event.fromBackendId && event.toBackendId
      ? [{
          at: event.timestamp,
          fromBackendId: safeField(event.fromBackendId),
          toBackendId: safeField(event.toBackendId),
          reason: event.reason ?? "candidate_unavailable" as const,
        }]
      : [])
    .slice(-MAX_ROUTING_TRACE_SWITCHES);
  const terminal = [...events].reverse().find((event) =>
    event.finalStatus
    || event.type === "succeeded"
    || event.type === "exhausted"
  );
  const latestAttempt = attempts.at(-1);
  const visibleOutput = events.some((event) => event.visibleOutput);
  const inferredStatus: RoutingFinalStatus = terminal?.finalStatus
    ?? (terminal?.type === "succeeded"
      ? "succeeded"
      : terminal?.type === "exhausted"
        ? "exhausted"
        : "running");
  const context = sanitizeTraceContext(first.context ?? {});
  const trace: RoutingTrace = {
    version: ROUTING_TRACE_SCHEMA_VERSION,
    requestId: safeField(first.requestId),
    operationId: safeField(context.operationId ?? first.requestId),
    logicalModelId: safeField(first.logicalModelId),
    logicalModelDisplayName: options.logicalModelDisplayName
      ? safeField(options.logicalModelDisplayName)
      : null,
    prompt: first.modelGlobalPrompt
      ? {
          family: first.modelGlobalPrompt.family,
          ...(first.modelGlobalPrompt.assetId
            ? { assetId: safeField(first.modelGlobalPrompt.assetId) }
            : {}),
          ...(first.modelGlobalPrompt.revision !== undefined
            ? { revision: first.modelGlobalPrompt.revision }
            : {}),
          enabled: first.modelGlobalPrompt.enabled,
          source: first.modelGlobalPrompt.source,
        }
      : null,
    context,
    attempts,
    switches,
    backends: aggregateRoutingAttempts(attempts),
    visibleOutput,
    finalBackendId: latestAttempt?.backendId ?? null,
    finalModelId: latestAttempt?.upstreamModelId ?? null,
    finalStatus: options.finalStatus ?? inferredStatus,
  };
  const parsed = RoutingTraceSchema.safeParse(trace);
  return parsed.success ? parsed.data as RoutingTrace : null;
}

export function normalizeRoutingUsage(
  usage: RoutingTokenUsage | undefined,
): RoutingTokenUsage {
  if (!usage?.providerObserved) return unknownUsage();
  return {
    inputTokens: normalizeToken(usage.inputTokens),
    outputTokens: normalizeToken(usage.outputTokens),
    cacheReadTokens: normalizeToken(usage.cacheReadTokens),
    cacheWriteTokens: normalizeToken(usage.cacheWriteTokens),
    reasoningTokens: normalizeToken(usage.reasoningTokens),
    providerObserved: true,
  };
}

export function calculateRoutingCost(
  usage: RoutingTokenUsage,
  pricing: ModelPriceMetadata | undefined,
): RoutingCost {
  if (!usage.providerObserved || !pricing) return unknownCost();
  const priced = [
    [usage.inputTokens, pricing.inputPerMillion],
    [usage.outputTokens, pricing.outputPerMillion],
    [usage.cacheReadTokens, pricing.cacheReadPerMillion],
    [usage.cacheWriteTokens, pricing.cacheWritePerMillion],
    [usage.reasoningTokens, pricing.reasoningPerMillion],
  ] as const;
  if (priced.some(([tokens, rate]) => tokens !== null && rate === undefined)) return unknownCost();
  const amount = priced.reduce(
    (sum, [tokens, rate]) => sum + (tokens ?? 0) * (rate ?? 0) / 1_000_000,
    0,
  );
  if (!Number.isFinite(amount)) return unknownCost();
  return {
    status: "known",
    amount,
    currency: pricing.currency,
    priceSource: safeField(pricing.source),
    priceRevision: safeField(pricing.revision),
  };
}

function aggregateRoutingAttempts(
  attempts: ReadonlyArray<RoutingTraceAttempt>,
): RoutingBackendAggregate[] {
  const grouped = new Map<string, RoutingTraceAttempt[]>();
  attempts.forEach((attempt) => {
    grouped.set(attempt.backendId, [...(grouped.get(attempt.backendId) ?? []), attempt]);
  });
  return [...grouped.entries()].map(([backendId, backendAttempts]) => {
    const observed = backendAttempts.filter((attempt) => attempt.usage.providerObserved);
    const costs = backendAttempts.map((attempt) => attempt.cost);
    const knownCosts = costs.filter((cost) => cost.status === "known");
    const samePrice = knownCosts.length === costs.length
      && new Set(knownCosts.map((cost) =>
        `${cost.currency}\0${cost.priceSource}\0${cost.priceRevision}`
      )).size === 1;
    const cost = samePrice
      ? {
          ...knownCosts[0]!,
          amount: knownCosts.reduce((sum, item) => sum + (item.amount ?? 0), 0),
        }
      : unknownCost();
    return {
      backendId,
      attemptCount: backendAttempts.length,
      localRetryCount: Math.max(
        0,
        ...backendAttempts.map((attempt) => attempt.localRetryCount),
      ),
      inputTokens: sumObserved(observed, "inputTokens"),
      outputTokens: sumObserved(observed, "outputTokens"),
      cacheReadTokens: sumObserved(observed, "cacheReadTokens"),
      cacheWriteTokens: sumObserved(observed, "cacheWriteTokens"),
      reasoningTokens: sumObserved(observed, "reasoningTokens"),
      cost,
    };
  });
}

function sumObserved(
  attempts: ReadonlyArray<RoutingTraceAttempt>,
  field: keyof Omit<RoutingTokenUsage, "providerObserved">,
): number | null {
  const values = attempts.map((attempt) => attempt.usage[field]).filter(
    (value): value is number => value !== null,
  );
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : null;
}

function unknownUsage(): RoutingTokenUsage {
  return {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    providerObserved: false,
  };
}

function unknownCost(): RoutingCost {
  return {
    status: "unknown",
    amount: null,
    currency: null,
    priceSource: null,
    priceRevision: null,
  };
}

function normalizeToken(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

function sanitizeTraceContext(context: RoutingTraceContext): RoutingTraceContext {
  return {
    ...(context.stage ? { stage: safeField(context.stage) } : {}),
    ...(context.agent ? { agent: safeField(context.agent) } : {}),
    ...(context.taskId ? { taskId: safeField(context.taskId) } : {}),
    ...(context.sessionId ? { sessionId: safeField(context.sessionId) } : {}),
    ...(context.bookId ? { bookId: safeField(context.bookId) } : {}),
    ...(context.chapter && Number.isInteger(context.chapter) && context.chapter > 0
      ? { chapter: context.chapter }
      : {}),
    ...(context.operationId ? { operationId: safeField(context.operationId) } : {}),
  };
}

function safeField(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b(api[_ -]?key|token|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\b(?:sk|key|token|xai)-[A-Za-z0-9._-]{8,}\b/gi, "[REDACTED]")
    .replace(/\b(?:AIza[0-9A-Za-z_-]{20,}|(?:ghp|gsk|sk_live)_[A-Za-z0-9_-]{16,})\b/g, "[REDACTED]")
    .replace(/[\r\n\t]/g, " ")
    .trim()
    .slice(0, 160) || "unknown";
}
