export const PROVIDER_ERROR_CATEGORIES = [
  "quota",
  "rate_limit",
  "auth",
  "network",
  "timeout",
  "overloaded",
  "model_unavailable",
  "invalid_request",
  "context_overflow",
  "content_policy",
  "unknown",
] as const;

export type ProviderErrorCategory = typeof PROVIDER_ERROR_CATEGORIES[number];

export interface ProviderErrorRouteContext {
  readonly backendId?: string;
  readonly logicalModelId?: string;
  readonly upstreamModelId?: string;
}

export interface ProviderErrorAttemptSummary extends Required<ProviderErrorRouteContext> {
  readonly attemptNumber: number;
  readonly category: ProviderErrorCategory;
  readonly safeReason: string;
  readonly visibleOutput: boolean;
}

export interface RetryAfter {
  readonly source: "retry-after" | "x-ratelimit-reset";
  readonly raw: string;
  readonly delayMs?: number;
  readonly retryAt?: string;
}

export interface ProviderErrorDetails extends ProviderErrorRouteContext {
  readonly category: ProviderErrorCategory;
  readonly message: string;
  readonly status?: number;
  readonly upstreamCode?: string;
  readonly upstreamType?: string;
  readonly retryAfter?: RetryAfter;
  readonly requestId?: string;
  readonly visibleOutput: boolean;
  readonly retryable: boolean;
  readonly onCurrentBackend: boolean;
  readonly failoverEligible: boolean;
  readonly cancelled: boolean;
  readonly attempts?: ReadonlyArray<ProviderErrorAttemptSummary>;
}

interface ProviderErrorPolicy {
  readonly retryable: boolean;
  readonly onCurrentBackend: boolean;
  readonly failoverEligible: boolean;
}

export interface ClassifyProviderErrorOptions extends ProviderErrorRouteContext {
  readonly visibleOutput?: boolean;
  readonly signal?: AbortSignal;
  readonly now?: number;
}

interface ProviderErrorInit extends ProviderErrorRouteContext {
  readonly category: ProviderErrorCategory;
  readonly safeMessage?: string;
  readonly status?: number;
  readonly upstreamCode?: string;
  readonly upstreamType?: string;
  readonly retryAfter?: RetryAfter;
  readonly requestId?: string;
  readonly visibleOutput?: boolean;
  readonly cancelled?: boolean;
  readonly cause?: unknown;
  readonly attempts?: ReadonlyArray<ProviderErrorAttemptSummary>;
}

interface ErrorEvidence {
  readonly status?: number;
  readonly code?: string;
  readonly type?: string;
  readonly name?: string;
  readonly message: string;
  readonly headers?: Headers;
  readonly retryAfter?: RetryAfter;
  readonly requestId?: string;
}

const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_SAFE_FIELD_LENGTH = 160;

const QUOTA_CODES = new Set([
  "billing_hard_limit_reached",
  "credit_balance_too_low",
  "insufficient_quota",
  "insufficient_user_quota",
  "monthly_usage_limit_reached",
  "quota_exceeded",
  "quota_exhausted",
]);
const RATE_LIMIT_CODES = new Set([
  "rate_limit",
  "rate_limited",
  "rate_limit_error",
  "rate_limit_exceeded",
  "too_many_requests",
]);
const AUTH_CODES = new Set([
  "authentication_error",
  "authorization_error",
  "credential_invalid",
  "invalid_api_key",
  "invalid_authentication",
  "invalid_token",
  "token_expired",
  "unauthorized",
]);
const NETWORK_CODES = new Set([
  "eai_again",
  "econnrefused",
  "econnreset",
  "enetwork",
  "enotfound",
  "enotreachable",
  "epipe",
  "und_err_connect_timeout",
  "und_err_socket",
]);
const TIMEOUT_CODES = new Set([
  "abort_err_timeout",
  "econnaborted",
  "esockettimedout",
  "etimedout",
  "request_timeout",
  "timeout",
  "timeout_error",
]);
const OVERLOADED_CODES = new Set([
  "engine_overloaded",
  "overloaded",
  "overloaded_error",
  "server_overloaded",
  "service_unavailable",
]);
const MODEL_UNAVAILABLE_CODES = new Set([
  "deployment_not_found",
  "model_not_available",
  "model_not_deployed",
  "model_not_found",
]);
const CONTEXT_OVERFLOW_CODES = new Set([
  "context_length_exceeded",
  "context_window_exceeded",
  "max_tokens_exceeded",
  "prompt_too_long",
  "token_limit_exceeded",
]);
const CONTENT_POLICY_CODES = new Set([
  "content_filter",
  "content_policy",
  "content_policy_violation",
  "content_violation",
  "safety_error",
  "safety_violation",
]);
const INVALID_REQUEST_CODES = new Set([
  "bad_request",
  "invalid_argument",
  "invalid_parameter",
  "invalid_request",
  "invalid_request_error",
  "validation_error",
]);
const CANCELLATION_CODES = new Set([
  "abort_err",
  "aborted",
  "cancelled",
  "canceled",
  "err_canceled",
]);

const POLICIES: Record<ProviderErrorCategory, ProviderErrorPolicy> = {
  quota: { retryable: false, onCurrentBackend: false, failoverEligible: true },
  rate_limit: { retryable: true, onCurrentBackend: true, failoverEligible: true },
  auth: { retryable: false, onCurrentBackend: false, failoverEligible: true },
  network: { retryable: true, onCurrentBackend: true, failoverEligible: true },
  timeout: { retryable: true, onCurrentBackend: true, failoverEligible: true },
  overloaded: { retryable: true, onCurrentBackend: true, failoverEligible: true },
  model_unavailable: { retryable: false, onCurrentBackend: false, failoverEligible: true },
  invalid_request: { retryable: false, onCurrentBackend: false, failoverEligible: false },
  context_overflow: { retryable: false, onCurrentBackend: false, failoverEligible: false },
  content_policy: { retryable: false, onCurrentBackend: false, failoverEligible: false },
  unknown: { retryable: false, onCurrentBackend: false, failoverEligible: false },
};

export class ProviderError extends Error {
  readonly category: ProviderErrorCategory;
  readonly safeMessage: string;
  readonly status?: number;
  readonly upstreamCode?: string;
  readonly upstreamType?: string;
  readonly retryAfter?: RetryAfter;
  readonly backendId?: string;
  readonly logicalModelId?: string;
  readonly upstreamModelId?: string;
  readonly requestId?: string;
  readonly visibleOutput: boolean;
  readonly retryable: boolean;
  readonly onCurrentBackend: boolean;
  readonly failoverEligible: boolean;
  readonly cancelled: boolean;
  readonly attempts?: ReadonlyArray<ProviderErrorAttemptSummary>;
  override readonly cause?: unknown;

  constructor(init: ProviderErrorInit) {
    const cancelled = init.cancelled ?? false;
    const policy = cancelled
      ? { retryable: false, onCurrentBackend: false, failoverEligible: false }
      : POLICIES[init.category];
    const safeMessage = init.safeMessage ?? providerErrorDisplayMessage(init.category, init.status, cancelled);
    super(safeMessage);
    this.name = cancelled ? "ProviderCancellationError" : "ProviderError";
    this.category = init.category;
    this.safeMessage = safeMessage;
    this.status = init.status;
    this.upstreamCode = sanitizeMetadata(init.upstreamCode);
    this.upstreamType = sanitizeMetadata(init.upstreamType);
    this.retryAfter = init.retryAfter;
    this.backendId = sanitizeMetadata(init.backendId);
    this.logicalModelId = sanitizeMetadata(init.logicalModelId);
    this.upstreamModelId = sanitizeMetadata(init.upstreamModelId);
    this.requestId = sanitizeMetadata(init.requestId);
    this.visibleOutput = init.visibleOutput ?? false;
    this.retryable = policy.retryable;
    this.onCurrentBackend = policy.onCurrentBackend;
    this.failoverEligible = policy.failoverEligible;
    this.cancelled = cancelled;
    this.attempts = init.attempts?.map(sanitizeAttemptSummary);
    this.cause = init.cause;
  }

  toJSON(): ProviderErrorDetails {
    return toSafeProviderErrorDetails(this);
  }

  withVisibleOutput(visibleOutput = true): ProviderError {
    if (visibleOutput === this.visibleOutput) return this;
    return new ProviderError({
      category: this.category,
      safeMessage: this.safeMessage,
      status: this.status,
      upstreamCode: this.upstreamCode,
      upstreamType: this.upstreamType,
      retryAfter: this.retryAfter,
      backendId: this.backendId,
      logicalModelId: this.logicalModelId,
      upstreamModelId: this.upstreamModelId,
      requestId: this.requestId,
      visibleOutput,
      cancelled: this.cancelled,
      cause: this.cause,
      attempts: this.attempts,
    });
  }

  withAttempts(attempts: ReadonlyArray<ProviderErrorAttemptSummary>): ProviderError {
    return new ProviderError({
      category: this.category,
      safeMessage: this.safeMessage,
      status: this.status,
      upstreamCode: this.upstreamCode,
      upstreamType: this.upstreamType,
      retryAfter: this.retryAfter,
      backendId: this.backendId,
      logicalModelId: this.logicalModelId,
      upstreamModelId: this.upstreamModelId,
      requestId: this.requestId,
      visibleOutput: this.visibleOutput,
      cancelled: this.cancelled,
      cause: this.cause,
      attempts,
    });
  }
}

export class ProviderCancellationError extends ProviderError {
  constructor(cause: unknown, context: ClassifyProviderErrorOptions = {}) {
    super({
      category: "unknown",
      cancelled: true,
      safeMessage: "LLM 请求已取消。",
      backendId: context.backendId,
      logicalModelId: context.logicalModelId,
      upstreamModelId: context.upstreamModelId,
      visibleOutput: context.visibleOutput,
      cause,
    });
  }
}

export async function providerErrorFromResponse(
  response: Response,
  options: ClassifyProviderErrorOptions = {},
): Promise<ProviderError> {
  const bodyText = typeof response.text === "function"
    ? await response.text().catch(() => "")
    : "";
  return providerErrorFromResponseBody(response, bodyText, options);
}

export function providerErrorFromResponseBody(
  response: Pick<Response, "status" | "statusText" | "headers">,
  bodyText: string,
  options: ClassifyProviderErrorOptions = {},
): ProviderError {
  const body = parseJsonObject(bodyText);
  const cause = new Error(`Provider HTTP request failed with status ${response.status}.`);
  const source = {
    status: response.status,
    headers: response.headers,
    error: body?.error,
    body,
    message: extractBodyMessage(body) ?? bodyText.slice(0, 8_192),
    providerCause: cause,
  };
  return classifyProviderError(source, options);
}

export function classifyProviderError(
  error: unknown,
  options: ClassifyProviderErrorOptions = {},
): ProviderError {
  if (error instanceof ProviderError) return error;
  if (isCancellationError(error, options.signal)) {
    return new ProviderCancellationError(error, options);
  }

  const evidence = collectEvidence(error, options.now ?? Date.now());
  const category = classifyEvidence(error, evidence);
  const partialVisibleOutput = readBoolean(error, "visibleOutput");
  return new ProviderError({
    category,
    safeMessage: safeMessageForKnownError(error, category, evidence.status),
    status: evidence.status,
    upstreamCode: evidence.code,
    upstreamType: evidence.type,
    retryAfter: evidence.retryAfter,
    requestId: evidence.requestId,
    backendId: options.backendId,
    logicalModelId: options.logicalModelId,
    upstreamModelId: options.upstreamModelId,
    visibleOutput: options.visibleOutput ?? partialVisibleOutput ?? false,
    cause: error && typeof error === "object"
      ? readUnknown(error as object, "providerCause") ?? error
      : error,
  });
}

export function toSafeProviderErrorDetails(error: ProviderError): ProviderErrorDetails {
  return {
    category: error.category,
    message: error.safeMessage,
    ...(error.status !== undefined ? { status: error.status } : {}),
    ...(error.upstreamCode ? { upstreamCode: error.upstreamCode } : {}),
    ...(error.upstreamType ? { upstreamType: error.upstreamType } : {}),
    ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}),
    ...(error.backendId ? { backendId: error.backendId } : {}),
    ...(error.logicalModelId ? { logicalModelId: error.logicalModelId } : {}),
    ...(error.upstreamModelId ? { upstreamModelId: error.upstreamModelId } : {}),
    ...(error.requestId ? { requestId: error.requestId } : {}),
    visibleOutput: error.visibleOutput,
    retryable: error.retryable,
    onCurrentBackend: error.onCurrentBackend,
    failoverEligible: error.failoverEligible,
    cancelled: error.cancelled,
    ...(error.attempts && error.attempts.length > 0
      ? { attempts: error.attempts }
      : {}),
  };
}

export function toProviderDisplayError(
  error: unknown,
  options: ClassifyProviderErrorOptions = {},
): Error {
  const providerError = classifyProviderError(error, options);
  const displayError = new Error(providerError.safeMessage);
  displayError.name = providerError.cancelled ? "AbortError" : "ProviderDisplayError";
  (displayError as Error & { cause?: unknown }).cause = providerError;
  return displayError;
}

export function parseRetryAfter(
  rawValue: string | null | undefined,
  now = Date.now(),
  source: RetryAfter["source"] = "retry-after",
): RetryAfter | undefined {
  const raw = sanitizeMetadata(rawValue);
  if (!raw) return undefined;

  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const seconds = Number(raw);
    const delayMs = Number.isFinite(seconds)
      ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, Math.round(seconds * 1000)))
      : undefined;
    return {
      source,
      raw,
      ...(delayMs !== undefined ? { delayMs, retryAt: new Date(now + delayMs).toISOString() } : {}),
    };
  }

  const parsedAt = Date.parse(raw);
  if (!Number.isFinite(parsedAt)) return { source, raw };
  const delayMs = Math.min(MAX_RETRY_AFTER_MS, Math.max(0, parsedAt - now));
  return {
    source,
    raw,
    delayMs,
    retryAt: new Date(now + delayMs).toISOString(),
  };
}

function collectEvidence(error: unknown, now: number): ErrorEvidence {
  const objects = collectErrorObjects(error);
  const message = collectControlledMessage(objects);
  const status = firstStatus(objects) ?? statusFromMessage(message);
  const bodyObjects = objects.flatMap((entry) => nestedErrorObjects(entry));
  const allObjects = [...bodyObjects, ...objects];
  const code = firstString(allObjects, ["code", "error_code", "errorCode", "reason"]);
  const type = firstString(allObjects, ["type", "error_type", "errorType"]);
  const name = firstString(objects, ["name"]);
  const headers = firstHeaders(objects);
  const retryAfter = parseRetryAfter(headers?.get("retry-after"), now)
    ?? parseRetryAfter(headers?.get("x-ratelimit-reset"), now, "x-ratelimit-reset")
    ?? parseRetryAfter(firstString(allObjects, ["retry-after", "retryAfter"]), now);
  const requestId = headers?.get("x-request-id")
    ?? headers?.get("request-id")
    ?? firstString(allObjects, ["request_id", "requestId"]);
  return { status, code, type, name, message, headers, retryAfter, requestId: requestId ?? undefined };
}

function classifyEvidence(error: unknown, evidence: ErrorEvidence): ProviderErrorCategory {
  const directName = error && typeof error === "object"
    ? readString(error as object, "name")
    : undefined;
  if (directName === "ContextWindowExceededError") return "context_overflow";
  if (directName === "PartialResponseError") return "network";

  const code = normalizeTag(evidence.code);
  const type = normalizeTag(evidence.type);
  const name = normalizeTag(evidence.name);
  const tags = [code, type, name].filter(Boolean);

  if (tags.some((tag) => QUOTA_CODES.has(tag))) return "quota";
  if (tags.some((tag) => RATE_LIMIT_CODES.has(tag))) return "rate_limit";
  if (tags.some((tag) => AUTH_CODES.has(tag))) return "auth";
  if (tags.some((tag) => TIMEOUT_CODES.has(tag))) return "timeout";
  if (tags.some((tag) => NETWORK_CODES.has(tag))) return "network";
  if (tags.some((tag) => OVERLOADED_CODES.has(tag))) return "overloaded";
  if (tags.some((tag) => MODEL_UNAVAILABLE_CODES.has(tag))) return "model_unavailable";
  if (tags.some((tag) => CONTEXT_OVERFLOW_CODES.has(tag))) return "context_overflow";
  if (tags.some((tag) => CONTENT_POLICY_CODES.has(tag))) return "content_policy";
  if (tags.some((tag) => INVALID_REQUEST_CODES.has(tag))) return "invalid_request";
  if (name === "timeouterror") return "timeout";

  if (evidence.status === 402) return "quota";
  if (evidence.status === 429) return "rate_limit";
  if (evidence.status === 401) return "auth";
  if (evidence.status === 502 || evidence.status === 503 || evidence.status === 504) return "overloaded";

  const message = evidence.message.toLowerCase();
  if (matchesAny(message, [
    /\binsufficient[_ -](?:user[_ -])?quota\b/,
    /\bquota (?:exhausted|exceeded)\b/,
    /\b(?:monthly|weekly|daily) (?:usage )?limit (?:has been )?reached\b/,
    /(?:周期|月度|每月|本月).*(?:额度|配额).*(?:耗尽|用完|已达)/,
  ])) return "quota";
  if (matchesAny(message, [/\brate[_ -]?limit(?:ed| exceeded)?\b/, /\btoo many requests\b/])) return "rate_limit";
  if (matchesAny(message, [
    /\b(?:invalid|expired|missing) (?:api[ _-]?key|credential|token)\b/,
    /\b(?:authentication|authorization) (?:failed|error|required)\b/,
    /\bunauthorized\b/,
  ])) return "auth";
  if (matchesAny(message, [
    /\b(?:econnreset|econnrefused|enotfound|eai_again|epipe|und_err_socket)\b/,
    /\b(?:connection reset|connection refused|dns lookup failed|fetch failed|network offline|socket hang up)\b/,
  ])) return "network";
  if (matchesAny(message, [/\b(?:request |connect |read )?timed? ?out\b/, /\btimeout(?: error)?\b/])) return "timeout";
  if (matchesAny(message, [
    /\b(?:service (?:temporarily )?unavailable|temporarily unavailable|server overloaded|engine overloaded)\b/,
    /\b(?:model|provider|service) (?:is )?(?:currently )?overloaded\b/,
    /\b(?:bad gateway|gateway timeout)\b/,
  ])) return "overloaded";
  if (matchesAny(message, [
    /\bmodel (?:is )?(?:not found|not deployed|not available|unavailable)\b/,
    /\bmodel[_ -]not[_ -](?:available|deployed|found)\b/,
    /\bdeployment (?:is )?not found\b/,
  ])) return "model_unavailable";
  if (matchesAny(message, [
    /\b(?:context length|context window|token limit).*(?:exceed|too (?:large|long))\b/,
    /\bprompt (?:is )?too long\b/,
  ])) return "context_overflow";
  if (matchesAny(message, [
    /\b(?:content|safety) (?:filter|policy|violation|refusal)\b/,
    /\bblocked by (?:the )?(?:content|safety) policy\b/,
  ])) return "content_policy";

  if (evidence.status === 400) return "invalid_request";
  return "unknown";
}

function providerErrorDisplayMessage(
  category: ProviderErrorCategory,
  status: number | undefined,
  cancelled: boolean,
): string {
  if (cancelled) return "LLM 请求已取消。";
  switch (category) {
    case "quota":
      return "API 配额或周期额度已耗尽，请检查账户用量与计费状态。";
    case "rate_limit":
      return "API 返回 429（请求过多），请稍后重试。";
    case "auth":
      return `API 返回 ${status ?? 401}（认证失败），请检查所选凭证是否有效。`;
    case "network":
      return "无法连接到 API 服务，请检查服务地址与网络连接。";
    case "timeout":
      return "LLM 请求超时，请稍后重试。";
    case "overloaded":
      return `API 返回 ${status ?? "5xx"}（上游服务暂时不可用），请稍后重试。`;
    case "model_unavailable":
      return "所选上游模型不存在、未部署或暂不可用。";
    case "invalid_request":
      return `API 返回 ${status ?? 400}（请求参数或格式不兼容），请检查 temperature / max_tokens、模型名称与消息格式。`;
    case "context_overflow":
      return "请求内容超过模型上下文窗口，请压缩当前上下文后重试。";
    case "content_policy":
      return "请求被上游内容或安全策略拒绝。";
    case "unknown":
      return status
        ? `API 请求失败（HTTP ${status}），未获得足够证据判断原因。`
        : "LLM 请求失败，未获得足够证据判断原因。";
  }
}

function safeMessageForKnownError(
  error: unknown,
  category: ProviderErrorCategory,
  status: number | undefined,
): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const name = readString(error as object, "name");
  const message = readString(error as object, "message") ?? "";
  if (name === "PartialResponseError") {
    return "Stream interrupted before a completion signal was received.";
  }
  if (name === "ContextWindowExceededError") {
    return "InkOS context window guard: request exceeds the context window. Please compress the active context before retrying.";
  }
  if (message.startsWith("LLM returned empty response")) {
    return "LLM returned empty response.";
  }
  if (message.startsWith("API Key contains non-ASCII characters")) {
    return "API Key contains non-ASCII characters; please remove pasted notes or unsupported whitespace.";
  }
  if (category === "network") {
    const transportCode = message.match(/\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR_SOCKET)\b/i)?.[0];
    if (transportCode) {
      return `无法连接到 API 服务（${transportCode.toUpperCase()}），请检查服务地址与网络连接。`;
    }
  }
  return providerErrorDisplayMessage(category, status, false);
}

function isCancellationError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted && signal.reason === error) return true;
  const objects = collectErrorObjects(error);
  return objects.some((entry) => {
    const name = normalizeTag(readString(entry, "name"));
    const code = normalizeTag(readString(entry, "code"));
    return name === "aborterror"
      || name === "cancelederror"
      || name === "cancellederror"
      || CANCELLATION_CODES.has(code);
  });
}

function collectErrorObjects(error: unknown): object[] {
  const result: object[] = [];
  const seen = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth++) {
    const entry = current as object;
    if (seen.has(entry)) break;
    seen.add(entry);
    result.push(entry);
    current = readUnknown(entry, "cause");
  }
  return result;
}

function collectControlledMessage(objects: readonly object[]): string {
  const messages: string[] = [];
  for (const entry of objects) {
    const direct = readString(entry, "message");
    if (direct) messages.push(direct);
    for (const nested of nestedErrorObjects(entry)) {
      const message = readString(nested, "message") ?? readString(nested, "detail");
      if (message) messages.push(message);
    }
  }
  return messages.join("\n");
}

function nestedErrorObjects(entry: object): object[] {
  const result: object[] = [];
  for (const key of ["error", "body", "data", "response"]) {
    const value = readUnknown(entry, key);
    const parsed = typeof value === "string" ? parseJsonObject(value) : value;
    if (parsed && typeof parsed === "object") {
      result.push(parsed as object);
      const nestedError = readUnknown(parsed as object, "error");
      if (nestedError && typeof nestedError === "object") result.push(nestedError as object);
    }
  }
  return result;
}

function firstStatus(objects: readonly object[]): number | undefined {
  for (const entry of objects) {
    for (const key of ["status", "statusCode", "status_code"]) {
      const value = readUnknown(entry, key);
      const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
      if (Number.isInteger(parsed) && parsed >= 100 && parsed <= 599) return parsed;
    }
    const response = readUnknown(entry, "response");
    if (response && typeof response === "object") {
      const status = firstStatus([response as object]);
      if (status !== undefined) return status;
    }
  }
  return undefined;
}

function statusFromMessage(message: string): number | undefined {
  const match = message.match(/(?:^|\bHTTP\s+|\bstatus(?:\s+code)?\s*[:=(]?\s*)([1-5]\d{2})\b/i);
  return match?.[1] ? Number(match[1]) : undefined;
}

function firstString(objects: readonly object[], keys: readonly string[]): string | undefined {
  for (const entry of objects) {
    for (const key of keys) {
      const value = readUnknown(entry, key);
      if (typeof value === "string" || typeof value === "number") {
        const normalized = String(value).trim();
        if (normalized) return normalized;
      }
    }
  }
  return undefined;
}

function firstHeaders(objects: readonly object[]): Headers | undefined {
  for (const entry of objects) {
    const headers = readUnknown(entry, "headers");
    if (headers instanceof Headers) return headers;
    if (headers && typeof headers === "object") {
      try {
        return new Headers(headers as Record<string, string>);
      } catch {
        // Ignore malformed third-party header bags.
      }
    }
    const response = readUnknown(entry, "response");
    if (response instanceof Response) return response.headers;
    if (response && typeof response === "object") {
      const nested = firstHeaders([response as object]);
      if (nested) return nested;
    }
  }
  return undefined;
}

function extractBodyMessage(body: Record<string, unknown> | undefined): string | undefined {
  if (!body) return undefined;
  const error = body.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    return readString(error as object, "message") ?? readString(error as object, "detail");
  }
  return readString(body, "message") ?? readString(body, "detail");
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  if (!value.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function matchesAny(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function normalizeTag(value: string | undefined): string {
  return value?.trim().toLowerCase().replace(/[\s-]+/g, "_") ?? "";
}

function sanitizeMetadata(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const sanitized = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b(api[_ -]?key|token|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\b(?:sk|key|token|xai)-[A-Za-z0-9._-]{8,}\b/gi, "[REDACTED]")
    .replace(/\b(?:AIza[0-9A-Za-z_-]{20,}|(?:ghp|gsk|sk_live)_[A-Za-z0-9_-]{16,})\b/g, "[REDACTED]")
    .replace(/[\r\n\t]/g, " ")
    .trim()
    .slice(0, MAX_SAFE_FIELD_LENGTH);
  return sanitized || undefined;
}

function sanitizeAttemptSummary(
  attempt: ProviderErrorAttemptSummary,
): ProviderErrorAttemptSummary {
  return {
    backendId: sanitizeMetadata(attempt.backendId) ?? "unknown",
    logicalModelId: sanitizeMetadata(attempt.logicalModelId) ?? "unknown",
    upstreamModelId: sanitizeMetadata(attempt.upstreamModelId) ?? "unknown",
    attemptNumber: Number.isInteger(attempt.attemptNumber)
      ? Math.max(0, attempt.attemptNumber)
      : 0,
    category: attempt.category,
    safeReason: sanitizeMetadata(attempt.safeReason) ?? "Provider request failed.",
    visibleOutput: attempt.visibleOutput,
  };
}

function readUnknown(value: object, key: string): unknown {
  return (value as Record<string, unknown>)[key];
}

function readString(value: object, key: string): string | undefined {
  const field = readUnknown(value, key);
  return typeof field === "string" ? field : undefined;
}

function readBoolean(value: unknown, key: string): boolean | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = readUnknown(value as object, key);
  return typeof field === "boolean" ? field : undefined;
}
