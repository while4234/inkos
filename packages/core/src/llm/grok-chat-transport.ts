import { fetchWithProxy } from "../utils/proxy-fetch.js";
import {
  classifyProviderError,
  providerErrorFromResponse,
  type ProviderErrorRouteContext,
} from "./provider-error.js";
import type { ResolvedGrokOAuthCredential } from "./credentials/grok-oauth.js";

export const GROK_DEFAULT_BASE_URL = "https://api.x.ai/v1";

export interface GrokChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface GrokChatTransportInput {
  readonly baseUrl?: string;
  readonly model: string;
  readonly messages: ReadonlyArray<GrokChatMessage>;
  readonly credential: ResolvedGrokOAuthCredential;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly extra?: Readonly<Record<string, unknown>>;
  readonly proxyUrl?: string;
  readonly signal?: AbortSignal;
  readonly onTextDelta?: (text: string) => void;
  readonly errorContext?: ProviderErrorRouteContext;
  readonly fetch?: typeof globalThis.fetch;
}

export interface GrokChatResult {
  readonly content: string;
  readonly usage: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
}

export async function requestGrokChatCompletion(
  input: GrokChatTransportInput,
): Promise<GrokChatResult> {
  input.signal?.throwIfAborted();
  let credential = input.credential;
  let forcedRefreshUsed = false;
  while (true) {
    const response = await sendRequest(input, credential);
    if (
      (response.status === 401 || response.status === 403)
      && !forcedRefreshUsed
    ) {
      forcedRefreshUsed = true;
      await response.body?.cancel().catch(() => undefined);
      try {
        credential = await credential.refresh(true, { signal: input.signal });
      } catch (error) {
        await credential.markAuthRequired().catch(() => undefined);
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
      await credential.markAuthRequired().catch(() => undefined);
      throw classifyProviderError({
        status: response.status,
        code: "invalid_token",
      }, input.errorContext);
    }
    if (!response.ok) throw await providerErrorFromResponse(response, input.errorContext);
    return collectStream(response, input);
  }
}

export function normalizeGrokChatUrl(baseUrl = GROK_DEFAULT_BASE_URL): string {
  const normalized = baseUrl.trim().replace(/\/+$/u, "");
  if (normalized.endsWith("/chat/completions")) return normalized;
  if (normalized.endsWith("/v1")) return `${normalized}/chat/completions`;
  return `${normalized}/v1/chat/completions`;
}

export function buildGrokChatPayload(
  input: Pick<
    GrokChatTransportInput,
    "model" | "messages" | "temperature" | "maxTokens" | "extra"
  >,
): Record<string, unknown> {
  return {
    ...stripProtectedFields(input.extra ?? {}),
    model: input.model,
    messages: input.messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    ...(input.maxTokens === undefined ? {} : { max_tokens: input.maxTokens }),
  };
}

async function sendRequest(
  input: GrokChatTransportInput,
  credential: ResolvedGrokOAuthCredential,
): Promise<Response> {
  const request = input.fetch ?? ((url: string | URL, init?: RequestInit) =>
    fetchWithProxy(url.toString(), init, input.proxyUrl));
  try {
    return await request(normalizeGrokChatUrl(input.baseUrl), {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${credential.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildGrokChatPayload(input)),
      signal: input.signal,
    });
  } catch (error) {
    throw classifyProviderError(error, {
      ...input.errorContext,
      signal: input.signal,
    });
  }
}

async function collectStream(
  response: Response,
  input: GrokChatTransportInput,
): Promise<GrokChatResult> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw classifyProviderError(
      new Error("Grok stream body is unavailable."),
      input.errorContext,
    );
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let terminal = false;
  let usage = emptyUsage();

  const consume = (events: ReadonlyArray<string>): void => {
    for (const data of events) {
      if (!data) continue;
      if (data === "[DONE]") {
        terminal = true;
        continue;
      }
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(data) as Record<string, unknown>;
      } catch {
        throw classifyProviderError(
          new Error("Grok stream returned malformed JSON."),
          input.errorContext,
        );
      }
      if (payload.error) {
        throw classifyProviderError({
          status: numberValue(payload.status),
          error: payload.error,
          message: "Grok stream reported a provider error.",
        }, input.errorContext);
      }
      const rawUsage = objectValue(payload.usage);
      if (rawUsage) usage = parseUsage(rawUsage);
      const choices = Array.isArray(payload.choices) ? payload.choices : [];
      for (const rawChoice of choices) {
        const choice = objectValue(rawChoice);
        const delta = objectValue(choice?.delta);
        const text = stringValue(delta?.content);
        if (text) {
          content += text;
          input.onTextDelta?.(text);
        }
        if (choice?.finish_reason) terminal = true;
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
    consume(parsed.events);
  }
  buffer += decoder.decode();
  if (buffer.trim()) consume(parseSse(`${buffer}\n\n`).events);
  if (!terminal) {
    throw new GrokPartialResponseError(
      "Grok stream closed before a terminal event.",
      Boolean(content && input.onTextDelta),
    );
  }
  if (!content) {
    throw classifyProviderError(
      new Error("Grok stream returned no output text."),
      input.errorContext,
    );
  }
  return { content, usage };
}

class GrokPartialResponseError extends Error {
  public readonly visibleOutput: boolean;

  public constructor(message: string, visibleOutput: boolean) {
    super(message);
    this.name = "PartialResponseError";
    this.visibleOutput = visibleOutput;
  }
}

function stripProtectedFields(
  extra: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const protectedFields = new Set([
    "messages",
    "model",
    "stream",
    "stream_options",
    "temperature",
    "max_tokens",
  ]);
  return Object.fromEntries(
    Object.entries(extra).filter(([key]) => !protectedFields.has(key)),
  );
}

function parseSse(buffer: string): {
  readonly events: ReadonlyArray<string>;
  readonly rest: string;
} {
  const normalized = buffer.replace(/\r\n/gu, "\n");
  const chunks = normalized.split("\n\n");
  const rest = chunks.pop() ?? "";
  return {
    events: chunks.map((chunk) => chunk
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")),
    rest,
  };
}

function parseUsage(raw: Record<string, unknown>): GrokChatResult["usage"] {
  const promptTokens = numberValue(raw.prompt_tokens) ?? 0;
  const completionTokens = numberValue(raw.completion_tokens) ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: numberValue(raw.total_tokens) ?? promptTokens + completionTokens,
  };
}

function emptyUsage(): GrokChatResult["usage"] {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
