import type {
  BackendHealthFile,
  BackendInstance,
  CodexCredentialStatus,
  GrokCredentialStatus,
  CredentialMetadata,
  LogicalModelRoute,
  ModelRoutingConfig,
  RoutingEvent,
  SecretsFile,
} from "@actalk/inkos-core";
import type {
  BackendHealthDTO,
  BackendInstanceDTO,
  CredentialStatusDTO,
  LogicalModelRouteDTO,
  RoutingActivityContextDTO,
  RoutingActivityEventDTO,
} from "../../shared/contracts.js";

export function maskCredential(apiKey: string): string {
  if (apiKey.length <= 8) return "••••••••";
  return `${apiKey.slice(0, 3)}••••${apiKey.slice(-4)}`;
}

export function credentialStatusDTO(
  credential: CredentialMetadata,
  secrets: SecretsFile,
  codexStatus?: CodexCredentialStatus,
  grokStatus?: GrokCredentialStatus,
): CredentialStatusDTO {
  const apiKey = credential.kind === "api_key"
    ? secrets.credentials?.[credential.id]?.apiKey
    : undefined;
  return {
    id: credential.id,
    kind: credential.kind,
    label: credential.label,
    scope: credential.scope,
    configured: Boolean(apiKey || codexStatus || grokStatus),
    maskedHint: apiKey
      ? maskCredential(apiKey)
      : codexStatus?.accountHint ?? grokStatus?.accountHint ?? null,
    source: apiKey
      ? "project_secret"
      : credential.kind === "api_key"
        ? "not_configured"
        : codexStatus || grokStatus ? "user_credential" : "not_configured",
    ...(codexStatus
      ? {
          codex: {
            source: codexStatus.source,
            safeFileName: codexStatus.safeFileName,
            accountHint: codexStatus.accountHint,
            expiresAt: codexStatus.expiresAt,
            nearExpiry: codexStatus.nearExpiry,
            needsReimport: codexStatus.needsReimport,
            lastRefresh: codexStatus.lastRefresh,
          },
        }
      : {}),
    ...(grokStatus
      ? {
          grok: {
            issuer: grokStatus.issuer,
            accountHint: grokStatus.accountHint,
            expiresAt: grokStatus.expiresAt,
            nearExpiry: grokStatus.nearExpiry,
            active: grokStatus.active,
            authRequired: grokStatus.authRequired,
            lastRefresh: grokStatus.lastRefresh,
          },
        }
      : {}),
  };
}

export function backendInstanceDTO(
  backend: BackendInstance,
  credential: CredentialMetadata,
  secrets: SecretsFile,
  codexStatus?: CodexCredentialStatus,
  grokStatus?: GrokCredentialStatus,
): BackendInstanceDTO {
  return {
    id: backend.id,
    displayName: backend.displayName,
    service: backend.service,
    provider: backend.provider,
    baseUrl: backend.baseUrl,
    credential: credentialStatusDTO(credential, secrets, codexStatus, grokStatus),
    enabled: backend.enabled,
    transport: backend.transport,
  };
}

export function logicalModelRouteDTO(
  route: LogicalModelRoute,
  defaultRouteId: string,
): LogicalModelRouteDTO {
  return {
    ...route,
    isDefault: route.id === defaultRouteId,
  };
}

export function backendHealthDTO(
  backend: BackendInstance,
  health: BackendHealthFile,
): BackendHealthDTO {
  const record = health.backends[backend.id];
  return {
    backendId: backend.id,
    status: backend.enabled ? (record?.status ?? "unknown") : "disabled",
    enabled: backend.enabled,
    consecutiveFailures: record?.consecutiveFailures ?? 0,
    lastSuccessAt: record?.lastSuccessAt ?? null,
    lastFailureAt: record?.lastFailureAt ?? null,
    cooldownReason: record?.cooldownReason ?? null,
    cooldownUntil: record?.cooldownUntil ?? null,
    recoveryCondition: record?.recoveryCondition ?? null,
    lastProbe: record?.lastProbe
      ? {
          at: record.lastProbe.at,
          outcome: record.lastProbe.outcome,
          reason: record.lastProbe.reason ?? null,
        }
      : null,
  };
}

export function routingActivityEventDTO(
  event: RoutingEvent,
  routing: ModelRoutingConfig,
  context?: RoutingActivityContextDTO,
): RoutingActivityEventDTO {
  const route = routing.routes.find((candidate) => candidate.id === event.logicalModelId);
  return {
    eventId: event.eventId,
    requestId: event.requestId,
    type: event.type,
    timestamp: event.timestamp,
    logicalModelId: event.logicalModelId,
    logicalModelDisplayName: route?.displayName ?? event.logicalModelId,
    phase: event.phase,
    ...(event.backendId ? { backendId: event.backendId } : {}),
    ...(event.upstreamModelId ? { upstreamModelId: event.upstreamModelId } : {}),
    ...(event.fromBackendId ? { fromBackendId: event.fromBackendId } : {}),
    ...(event.toBackendId ? { toBackendId: event.toBackendId } : {}),
    ...(event.reason ? { reason: event.reason } : {}),
    retryCount: event.retryCount,
    visibleOutput: event.visibleOutput,
    ...(context && Object.keys(context).length > 0 ? { context } : {}),
  };
}
