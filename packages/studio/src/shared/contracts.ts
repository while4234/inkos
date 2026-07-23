/**
 * Shared TypeScript contracts for Studio API/UI communication.
 * Ported from PR #96 (Te9ui1a) — prevents client/server type drift.
 */
import type { RoutingTrace } from "@actalk/inkos-core";

// --- Health ---

export interface HealthStatus {
  readonly status: "ok";
  readonly projectRoot: string;
  readonly projectConfigFound: boolean;
  readonly envFound: boolean;
  readonly projectEnvFound: boolean;
  readonly globalConfigFound: boolean;
  readonly bookCount: number;
  readonly provider: string | null;
  readonly model: string | null;
}

// --- Books ---

export interface BookSummary {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly platform: string;
  readonly genre: string;
  readonly targetChapters: number;
  readonly chapters: number;
  readonly chapterCount: number;
  readonly lastChapterNumber: number;
  readonly totalWords: number;
  readonly approvedChapters: number;
  readonly pendingReview: number;
  readonly pendingReviewChapters: number;
  readonly failedReview: number;
  readonly failedChapters: number;
  readonly recentRunStatus?: string | null;
  readonly updatedAt: string;
}

export interface BookDetail extends BookSummary {
  readonly createdAt: string;
  readonly chapterWordCount: number;
  readonly language: "zh" | "en" | null;
}

// --- Chapters ---

export interface ChapterSummary {
  readonly number: number;
  readonly title: string;
  readonly status: string;
  readonly wordCount: number;
  readonly auditIssueCount: number;
  readonly updatedAt: string;
  readonly fileName: string | null;
}

export interface ChapterDetail extends ChapterSummary {
  readonly auditIssues: ReadonlyArray<string>;
  readonly reviewNote?: string;
  readonly content: string;
}

export interface SaveChapterPayload {
  readonly content: string;
}

// --- Truth Files ---

export interface TruthFileSummary {
  readonly name: string;
  readonly label: string;
  readonly exists: boolean;
  readonly path: string;
  readonly optional: boolean;
  readonly available: boolean;
}

export interface TruthFileDetail extends TruthFileSummary {
  readonly content: string | null;
}

// --- Review ---

export interface ReviewActionPayload {
  readonly chapterNumber: number;
  readonly reason?: string;
}

// --- Runs ---

export type RunAction = "draft" | "audit" | "revise" | "write-next";

export type RunStatus = "queued" | "running" | "succeeded" | "failed";

export interface RunLogEntry {
  readonly timestamp: string;
  readonly level: "info" | "warn" | "error";
  readonly message: string;
}

export interface RunActionPayload {
  readonly chapterNumber?: number;
}

export interface StudioRun {
  readonly id: string;
  readonly bookId: string;
  readonly chapter: number | null;
  readonly chapterNumber: number | null;
  readonly action: RunAction;
  readonly status: RunStatus;
  readonly stage: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly logs: ReadonlyArray<RunLogEntry>;
  readonly result?: unknown;
  readonly error?: string;
}

export interface RunStreamEvent {
  readonly type: "snapshot" | "status" | "stage" | "log";
  readonly runId: string;
  readonly run?: StudioRun;
  readonly status?: RunStatus;
  readonly stage?: string;
  readonly log?: RunLogEntry;
  readonly result?: unknown;
  readonly error?: string;
}

// --- API Error Response ---

export interface ApiErrorResponse {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

// --- Model routing management ---

export type StudioCredentialKind = "api_key" | "codex" | "grok_oauth";
export type StudioPromptFamily = "gpt" | "grok" | "deepseek" | "none" | "generic";

export interface CredentialStatusDTO {
  readonly id: string;
  readonly kind: StudioCredentialKind;
  readonly label: string;
  readonly scope: "project" | "user";
  readonly configured: boolean;
  readonly maskedHint: string | null;
  readonly source: "project_secret" | "user_credential" | "not_configured";
  readonly codex?: CodexCredentialStatusDTO;
  readonly grok?: GrokCredentialStatusDTO;
}

export interface CodexCredentialStatusDTO {
  readonly source: "managed_copy" | "external_reference";
  readonly safeFileName: string;
  readonly accountHint: string | null;
  readonly expiresAt: string | null;
  readonly nearExpiry: boolean;
  readonly needsReimport: boolean;
  readonly lastRefresh: "never" | "succeeded" | "failed";
}

export interface CodexDiscoveryCandidateDTO {
  readonly candidateId: string;
  readonly sources: ReadonlyArray<
    "CODEX_AUTH_FILE" | "CODEX_HOME" | "project" | "user_home"
  >;
  readonly safeFileName: string;
  readonly state: "available" | "missing" | "unreadable" | "invalid" | "permission_denied";
  readonly accountHint: string | null;
  readonly expiresAt: string | null;
  readonly nearExpiry: boolean;
  readonly message: string;
}

export interface GrokCredentialStatusDTO {
  readonly issuer: string;
  readonly accountHint: string | null;
  readonly expiresAt: string;
  readonly nearExpiry: boolean;
  readonly active: boolean;
  readonly authRequired: boolean;
  readonly lastRefresh: "never" | "succeeded" | "failed";
}

export interface GrokOAuthConfigurationStatusDTO {
  readonly configured: boolean;
  readonly missing: ReadonlyArray<"issuer" | "clientId" | "redirectUri">;
  readonly issuer: string | null;
  readonly redirectUri: string | null;
}

export interface GrokOAuthLoginStartDTO {
  readonly sessionId: string;
  readonly authorizationUrl: string;
  readonly expiresAt: string;
  readonly callback: {
    readonly scheme: "http";
    readonly host: "127.0.0.1";
    readonly port: number;
    readonly path: string;
  };
}

export interface BackendInstanceDTO {
  readonly id: string;
  readonly displayName: string;
  readonly service: string;
  readonly provider: "anthropic" | "openai" | "custom";
  readonly baseUrl: string;
  readonly credential: CredentialStatusDTO;
  readonly enabled: boolean;
  readonly transport: {
    readonly apiFormat: "chat" | "responses";
    readonly stream: boolean;
  };
}

export interface LogicalModelCandidateDTO {
  readonly backendId: string;
  readonly upstreamModelId: string;
  readonly pricing?: {
    readonly currency: string;
    readonly inputPerMillion: number;
    readonly outputPerMillion: number;
    readonly cacheReadPerMillion?: number;
    readonly cacheWritePerMillion?: number;
    readonly reasoningPerMillion?: number;
    readonly source: string;
    readonly revision: string;
  };
}

export interface LogicalModelRouteDTO {
  readonly id: string;
  readonly displayName: string;
  readonly promptFamily: StudioPromptFamily;
  readonly enabled: boolean;
  readonly candidates: ReadonlyArray<LogicalModelCandidateDTO>;
  readonly isDefault: boolean;
}

export type BackendHealthStatusDTO =
  | "healthy"
  | "temporary_cooldown"
  | "quota_exhausted"
  | "auth_required"
  | "disabled"
  | "unknown";

export interface BackendHealthDTO {
  readonly backendId: string;
  readonly status: BackendHealthStatusDTO;
  readonly enabled: boolean;
  readonly consecutiveFailures: number;
  readonly lastSuccessAt: string | null;
  readonly lastFailureAt: string | null;
  readonly cooldownReason: string | null;
  readonly cooldownUntil: string | null;
  readonly recoveryCondition: "cooldown_elapsed" | "manual_reset_or_probe" | null;
  readonly lastProbe: {
    readonly at: string;
    readonly outcome: "success" | "failure";
    readonly reason: string | null;
  } | null;
}

export type RoutingActivityType =
  | "attempt_started"
  | "local_retry"
  | "backend_switched"
  | "succeeded"
  | "failed"
  | "exhausted";

export interface RoutingActivityContextDTO {
  readonly sessionId?: string;
  /** Distinguishes the surface Agent stream from nested chat tools/pipelines. */
  readonly scope?: "agent";
  readonly taskId?: string;
  readonly bookId?: string;
  readonly chapter?: number;
  readonly agent?: string;
}

export interface RoutingActivityEventDTO {
  readonly eventId: string;
  readonly requestId: string;
  readonly type: RoutingActivityType;
  readonly timestamp: string;
  readonly logicalModelId: string;
  readonly logicalModelDisplayName: string;
  readonly phase: "selection" | "request" | "retry" | "complete";
  readonly backendId?: string;
  readonly upstreamModelId?: string;
  readonly fromBackendId?: string;
  readonly toBackendId?: string;
  readonly reason?: string;
  readonly retryCount: number;
  /** Present on current routing events; absent on pre-PR-08 persisted snapshots. */
  readonly visibleOutput?: boolean;
  readonly context?: RoutingActivityContextDTO;
  /** Bounded canonical trace snapshot at this event. */
  readonly trace?: RoutingTrace;
}

export interface SafeAggregateFailureSummaryDTO {
  readonly logicalModelId: string;
  readonly attempts: ReadonlyArray<{
    readonly backendId: string;
    readonly category: string;
    readonly safeMessage: string;
  }>;
  readonly finalCategory: string;
  readonly safeMessage: string;
}

export interface StudioRoutingSummary {
  readonly logicalModelId: string | null;
  readonly logicalModelDisplayName: string | null;
  readonly activeBackendId: string | null;
  readonly activeModelId?: string | null;
  readonly retryCount: number;
  readonly switches: ReadonlyArray<RoutingActivityEventDTO>;
  /** Bounded replay guard for SSE reconnects and task snapshot restores. */
  readonly recentEventIds?: ReadonlyArray<string>;
  readonly lastEventAt: string | null;
  readonly terminalState?: "succeeded" | "failed" | "interrupted" | "cancelled" | "exhausted";
  readonly trace?: RoutingTrace;
}

export interface ModelRoutingValidationIssueDTO {
  readonly path: string;
  readonly message: string;
}

export interface ModelRoutingValidationErrorDTO {
  readonly error: {
    readonly code: "MODEL_ROUTING_VALIDATION_ERROR" | "MODEL_ROUTING_REVISION_CONFLICT";
    readonly message: string;
    readonly issues?: ReadonlyArray<ModelRoutingValidationIssueDTO>;
    readonly currentRevision?: string;
  };
}
