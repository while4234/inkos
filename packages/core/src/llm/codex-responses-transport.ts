import { randomUUID } from "node:crypto";
import { fetchWithProxy } from "../utils/proxy-fetch.js";
import {
  classifyProviderError,
  providerErrorFromResponse,
  type ProviderErrorRouteContext,
} from "./provider-error.js";
import {
  CODEX_DEFAULT_BASE_URL,
  type ResolvedCodexCredential,
} from "./credentials/codex-auth.js";

export const CODEX_ORIGINATOR = "codex_vscode";
export const CODEX_USER_AGENT = "InkOS Codex Credential Transport/1";

export interface CodexResponsesMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface CodexResponsesResult {
  readonly content: string;
  readonly usage: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
}

export interface CodexResponsesTransportInput {
  readonly baseUrl?: string;
  readonly model: string;
  readonly messages: ReadonlyArray<CodexResponsesMessage>;
  readonly credential: ResolvedCodexCredential;
  readonly extra?: Readonly<Record<string, unknown>>;
  readonly proxyUrl?: string;
  readonly signal?: AbortSignal;
  readonly onTextDelta?: (text: string) => void;
  readonly errorContext?: ProviderErrorRouteContext;
  readonly fetch?: typeof globalThis.fetch;
  readonly requestId?: () => string;
}

export async function requestCodexResponses(
  input: CodexResponsesTransportInput,
): Promise<CodexResponsesResult> {
  input.signal?.throwIfAborted();
  let credential = input.credential;
  let forcedRefreshUsed = false;

  while (true) {
    const response = await sendCodexRequest(input, credential);
    if (
      (response.status === 401 || response.status === 403)
      && !forcedRefreshUsed
    ) {
      forcedRefreshUsed = true;
      await response.body?.cancel().catch(() => undefined);
      try {
        credential = await credential.refresh(true, { signal: input.signal });
      } catch (error) {
        throw classifyProviderError({
          status: response.status,
          code: "invalid_token",
          providerCause: error,
        }, input.errorContext);
      }
      continue;
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      throw classifyProviderError({
        status: response.status,
        code: "invalid_token",
      }, input.errorContext);
    }
    if (!response.ok) {
      throw await providerErrorFromResponse(response, input.errorContext);
    }
    return collectCodexResponsesStream(response, input);
  }
}

export function normalizeCodexResponsesUrl(baseUrl = CODEX_DEFAULT_BASE_URL): string {
  const normalized = baseUrl.trim().replace(/\/+$/u, "");
  if (normalized.endsWith("/v1/responses")) {
    return `${normalized.slice(0, -"/v1/responses".length)}/responses`;
  }
  if (normalized.endsWith("/responses")) return normalized;
  if (normalized.endsWith("/v1")) {
    return `${normalized.slice(0, -3)}/responses`;
  }
  return `${normalized}/responses`;
}

export function buildCodexResponsesPayload(
  input: Pick<CodexResponsesTransportInput, "model" | "messages" | "extra">,
): Record<string, unknown> {
  const instructions = input.messages
    .filter((message) => message.role === "system" && message.content.trim())
    .map((message) => message.content.trim())
    .join("\n\n");
  const payload: Record<string, unknown> = {
    ...stripUnsupportedCodexFields(input.extra ?? {}),
    model: input.model,
    input: input.messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        type: "message",
        role: message.role,
        content: [{ type: "input_text", text: message.content }],
      })),
    store: false,
    stream: true,
  };
  if (instructions) payload.instructions = instructions;
  return payload;
}

async function sendCodexRequest(
  input: CodexResponsesTransportInput,
  credential: ResolvedCodexCredential,
): Promise<Response> {
  const request = input.fetch ?? ((url: string | URL, init?: RequestInit) =>
    fetchWithProxy(url.toString(), init, input.proxyUrl));
  try {
    return await request(normalizeCodexResponsesUrl(input.baseUrl), {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${credential.accessToken}`,
        "Content-Type": "application/json",
        originator: CODEX_ORIGINATOR,
        "User-Agent": CODEX_USER_AGENT,
        "x-client-request-id": (input.requestId ?? randomUUID)(),
        ...(credential.accountId
          ? { "chatgpt-account-id": credential.accountId }
          : {}),
      },
      body: JSON.stringify(buildCodexResponsesPayload(input)),
      signal: input.signal,
    });
  } catch (error) {
    throw classifyProviderError(error, {
      ...input.errorContext,
      signal: input.signal,
    });
  }
}

async function collectCodexResponsesStream(
  response: Response,
  input: CodexResponsesTransportInput,
): Promise<CodexResponsesResult> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw classifyProviderError(
      new Error("Codex Responses stream body is unavailable."),
      input.errorContext,
    );
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let terminal = false;
  let incomplete = false;
  let usage = emptyUsage();

  const consumeEvents = (
    events: ReadonlyArray<{ readonly data: string }>,
  ): void => {
    for (const event of events) {
      if (!event.data || event.data === "[DONE]") continue;
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        throw classifyProviderError(
          new Error("Codex Responses stream returned malformed JSON."),
          input.errorContext,
        );
      }
      const type = stringValue(payload.type);
      if (type === "response.output_text.delta") {
        const delta = stringValue(payload.delta);
        if (delta) {
          content += delta;
          input.onTextDelta?.(delta);
        }
      }
      if (type === "response.failed" || type === "error") {
        throw classifyProviderError({
          status: numberValue(objectValue(payload.response)?.status),
          error: payload.error ?? objectValue(payload.response)?.error,
          message: "Codex Responses stream reported a provider error.",
        }, input.errorContext);
      }
      if (type === "response.completed" || type === "response.incomplete") {
        terminal = true;
        incomplete = type === "response.incomplete";
        const completed = objectValue(payload.response);
        if (!content) content = extractOutputText(completed);
        usage = extractUsage(objectValue(completed?.usage));
      }
    }
  };

  while (true) {
    input.signal?.throwIfAborted();
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parsed = parseSse(buffer);
    buffer = parsed.rest;
    consumeEvents(parsed.events);
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    consumeEvents(parseSse(`${buffer}\n\n`).events);
  }

  if (!terminal) {
    throw new CodexPartialResponseError(
      "Codex Responses stream closed before a terminal event.",
      Boolean(content && input.onTextDelta),
    );
  }
  if (incomplete) {
    throw new CodexPartialResponseError(
      "Codex Responses stream reported an incomplete response.",
      Boolean(content && input.onTextDelta),
    );
  }
  if (!content) {
    throw classifyProviderError(
      new Error("Codex Responses stream returned no output text."),
      input.errorContext,
    );
  }
  return { content, usage };
}

class CodexPartialResponseError extends Error {
  public readonly visibleOutput: boolean;

  public constructor(message: string, visibleOutput: boolean) {
    super(message);
    this.name = "PartialResponseError";
    this.visibleOutput = visibleOutput;
  }
}

function stripUnsupportedCodexFields(
  extra: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const blocked = new Set([
    "input",
    "instructions",
    "max_output_tokens",
    "messages",
    "model",
    "store",
    "stream",
    "temperature",
  ]);
  return Object.fromEntries(
    Object.entries(extra).filter(([key]) => !blocked.has(key)),
  );
}

function parseSse(buffer: string): {
  readonly events: ReadonlyArray<{ readonly data: string }>;
  readonly rest: string;
} {
  const normalized = buffer.replace(/\r\n/gu, "\n");
  const chunks = normalized.split("\n\n");
  const rest = chunks.pop() ?? "";
  return {
    events: chunks.map((chunk) => ({
      data: chunk
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n"),
    })),
    rest,
  };
}

function extractOutputText(response: Record<string, unknown> | undefined): string {
  if (!Array.isArray(response?.output)) return "";
  const parts: string[] = [];
  for (const item of response.output) {
    const output = objectValue(item);
    if (!Array.isArray(output?.content)) continue;
    for (const raw of output.content) {
      const content = objectValue(raw);
      if (content?.type === "output_text" && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }
  return parts.join("");
}

function extractUsage(raw: Record<string, unknown> | undefined) {
  const promptTokens = numberValue(raw?.input_tokens) ?? 0;
  const completionTokens = numberValue(raw?.output_tokens) ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: numberValue(raw?.total_tokens) ?? promptTokens + completionTokens,
  };
}

function emptyUsage() {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
