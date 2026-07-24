import type { LLMMessage } from "./provider.js";
import type {
  ModelGlobalPromptFamily,
  ModelGlobalPrompts,
  PromptFamily,
} from "./model-routing.js";
import { DEEPSEEK_MODEL_GLOBAL_PROMPT_TEXT } from "./model-global-prompts/deepseek.js";
import { GENERIC_MODEL_GLOBAL_PROMPT_TEXT } from "./model-global-prompts/generic.js";
import { GPT_MODEL_GLOBAL_PROMPT_TEXT } from "./model-global-prompts/gpt.js";
import { GROK_MODEL_GLOBAL_PROMPT_TEXT } from "./model-global-prompts/grok.js";

export type ResolvedPromptFamily = PromptFamily;
export type ModelGlobalPromptMode = "auto" | "disabled";
export type PromptFamilySource =
  | "explicit"
  | "endpoint"
  | "service"
  | "model"
  | "unknown"
  | "disabled";

export interface ModelGlobalPromptAsset {
  readonly id: string;
  readonly family: Exclude<ResolvedPromptFamily, "none">;
  readonly revision: number;
  readonly text: string;
  readonly renderedText: string;
}

export interface ModelGlobalPromptResolution {
  readonly family: ResolvedPromptFamily;
  readonly enabled: boolean;
  readonly source: PromptFamilySource;
  readonly assetId?: string;
  readonly revision?: number;
  readonly renderedText?: string;
  readonly warning?: string;
}

export interface ModelGlobalPromptOverride {
  readonly id: string;
  readonly revision: number;
  readonly text: string;
}

export interface ResolveModelGlobalPromptInput {
  readonly configuredFamily?: PromptFamily;
  readonly endpoint?: string;
  readonly service?: string;
  readonly model?: string;
  readonly mode?: ModelGlobalPromptMode;
  readonly customPrompt?: ModelGlobalPromptOverride;
  readonly customPrompts?: Readonly<Partial<
    Record<ModelGlobalPromptFamily, ModelGlobalPromptOverride>
  >>;
}

export interface ModelGlobalPromptTraceMetadata {
  readonly family: ResolvedPromptFamily;
  readonly assetId?: string;
  readonly revision?: number;
  readonly enabled: boolean;
  readonly source: PromptFamilySource;
}

export interface PromptCompatibleMessage {
  readonly role: string;
  readonly content: unknown;
}

export interface ModelGlobalPromptApplication<TMessage extends PromptCompatibleMessage> {
  readonly messages: ReadonlyArray<TMessage>;
  readonly trace: ModelGlobalPromptTraceMetadata;
}

export type ModelGlobalPromptOverrides = Readonly<Partial<
  Record<ModelGlobalPromptFamily, ModelGlobalPromptOverride>
>>;

const PROMPT_MARKER_ID = "inkos:model-global-prompt";
const PROMPT_END_MARKER = `<!-- /${PROMPT_MARKER_ID} -->`;
const MARKED_PROMPT_PREFIX = new RegExp(
  `^\\s*<!-- ${PROMPT_MARKER_ID.replaceAll(":", "\\:")}\\s+` +
  `id="[a-z0-9:._-]+"\\s+` +
  `family="(?:gpt|grok|deepseek|generic)"\\s+revision="[0-9]+"\\s*-->` +
  `[\\s\\S]*?${PROMPT_END_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`,
);

function createAsset(
  family: ModelGlobalPromptAsset["family"],
  revision: number,
  text: string,
): ModelGlobalPromptAsset {
  const id = `${PROMPT_MARKER_ID}:${family}`;
  const startMarker = `<!-- ${PROMPT_MARKER_ID} id="${id}" family="${family}" revision="${revision}" -->`;
  return Object.freeze({
    id,
    family,
    revision,
    text,
    renderedText: `${startMarker}\n${text}\n${PROMPT_END_MARKER}`,
  });
}

const ASSETS = [
  createAsset("gpt", 1, GPT_MODEL_GLOBAL_PROMPT_TEXT),
  createAsset("grok", 1, GROK_MODEL_GLOBAL_PROMPT_TEXT),
  createAsset("deepseek", 1, DEEPSEEK_MODEL_GLOBAL_PROMPT_TEXT),
  createAsset("generic", 1, GENERIC_MODEL_GLOBAL_PROMPT_TEXT),
] as const;

export const MODEL_GLOBAL_PROMPT_ASSETS: Readonly<Record<
  ModelGlobalPromptAsset["family"],
  ModelGlobalPromptAsset
>> = Object.freeze(Object.fromEntries(
  ASSETS.map((asset) => [asset.family, asset]),
) as Record<ModelGlobalPromptAsset["family"], ModelGlobalPromptAsset>);

const LEGACY_UNMARKED_PREFIXES = [...ASSETS]
  .map((asset) => asset.text)
  .sort((left, right) => right.length - left.length);

const SERVICE_FAMILIES: Readonly<Record<string, Exclude<ResolvedPromptFamily, "none">>> = {
  openai: "gpt",
  codex: "gpt",
  xai: "grok",
  grok: "grok",
  deepseek: "deepseek",
};

export function resolveModelGlobalPrompt(
  input: ResolveModelGlobalPromptInput,
): ModelGlobalPromptResolution {
  if (input.mode === "disabled") {
    return { family: "none", enabled: false, source: "disabled" };
  }

  const configured = input.configuredFamily ?? "generic";
  if (configured !== "generic") {
    return resolutionForFamily(
      configured,
      "explicit",
      configured === "none"
        ? undefined
        : customPromptForFamily(input, configured),
    );
  }

  const endpointFamily = familyForEndpoint(input.endpoint);
  if (endpointFamily) {
    return resolutionForFamily(
      endpointFamily,
      "endpoint",
      customPromptForFamily(input, endpointFamily),
    );
  }

  const serviceFamily = SERVICE_FAMILIES[normalizeIdentifier(input.service)];
  if (serviceFamily) {
    return resolutionForFamily(
      serviceFamily,
      "service",
      customPromptForFamily(input, serviceFamily),
    );
  }

  const modelFamily = familyForNormalizedModel(input.model);
  if (modelFamily) {
    return resolutionForFamily(
      modelFamily,
      "model",
      customPromptForFamily(input, modelFamily),
    );
  }

  return resolutionForFamily(
    "generic",
    "unknown",
    customPromptForFamily(input, "generic"),
  );
}

export function modelGlobalPromptOverridesFromConfig(
  prompts: ModelGlobalPrompts,
): ModelGlobalPromptOverrides {
  return Object.fromEntries(
    Object.entries(prompts).map(([family, prompt]) => [
      family,
      {
        id: `project:${family}`,
        revision: prompt.revision,
        text: prompt.text,
      },
    ]),
  ) as ModelGlobalPromptOverrides;
}

export function applyModelGlobalPrompt<TMessage extends PromptCompatibleMessage>(
  messages: ReadonlyArray<TMessage>,
  resolution: ModelGlobalPromptResolution,
): ModelGlobalPromptApplication<TMessage> {
  const stripped = messages.map((message) => stripPromptFromMessage(message));
  const builtInAsset = resolution.enabled && resolution.family !== "none"
    ? MODEL_GLOBAL_PROMPT_ASSETS[resolution.family]
    : undefined;
  const renderedPrompt = resolution.renderedText ?? builtInAsset?.renderedText;

  if (!renderedPrompt) {
    return {
      messages: stripped,
      trace: toModelGlobalPromptTrace(resolution),
    };
  }

  const firstSystemIndex = stripped.findIndex((message) => message.role === "system");
  if (firstSystemIndex < 0) {
    const inserted = {
      role: "system",
      content: renderedPrompt,
    } as TMessage;
    return {
      messages: [inserted, ...stripped],
      trace: toModelGlobalPromptTrace(resolution),
    };
  }

  const firstSystemMessage = stripped[firstSystemIndex]!;
  if (!canPrependToContent(firstSystemMessage.content)) {
    const inserted = {
      role: "system",
      content: renderedPrompt,
    } as TMessage;
    return {
      messages: [
        ...stripped.slice(0, firstSystemIndex),
        inserted,
        ...stripped.slice(firstSystemIndex),
      ],
      trace: toModelGlobalPromptTrace(resolution),
    };
  }

  return {
    messages: stripped.map((message, index) => index === firstSystemIndex
      ? {
          ...message,
          content: prependPromptToContent(message.content, renderedPrompt),
        } as TMessage
      : message),
    trace: toModelGlobalPromptTrace(resolution),
  };
}

export function applyModelGlobalPromptToLLMMessages(
  messages: ReadonlyArray<LLMMessage>,
  resolution: ModelGlobalPromptResolution,
): ModelGlobalPromptApplication<LLMMessage> {
  return applyModelGlobalPrompt(messages, resolution);
}

export function stripKnownModelGlobalPromptPrefixes(text: string): string {
  let body = text;
  let previous: string | undefined;
  while (body !== previous) {
    previous = body;
    body = body.replace(MARKED_PROMPT_PREFIX, "");
    for (const prefix of LEGACY_UNMARKED_PREFIXES) {
      const normalized = body.trimStart();
      if (normalized === prefix) {
        body = "";
        break;
      }
      if (normalized.startsWith(`${prefix}\n`)) {
        body = normalized.slice(prefix.length).trimStart();
        break;
      }
    }
  }
  return body;
}

export function countModelGlobalPromptMarkers(value: string): number {
  return value.match(/<!-- inkos:model-global-prompt\s/g)?.length ?? 0;
}

export function transformGrokHistory<TMessage extends PromptCompatibleMessage>(
  messages: ReadonlyArray<TMessage>,
): ReadonlyArray<TMessage> {
  return messages.map((message) => {
    const clone = cloneMessage(message);
    if (clone.role !== "assistant") return clone;

    const mutable = clone as Record<string, unknown>;
    delete mutable.reasoning;
    delete mutable.reasoning_content;
    delete mutable.thinking;
    if (Array.isArray(mutable.content)) {
      mutable.content = mutable.content.filter((block) => !isReasoningBlock(block));
    }
    return mutable as TMessage;
  });
}

export function toModelGlobalPromptTrace(
  resolution: ModelGlobalPromptResolution,
): ModelGlobalPromptTraceMetadata {
  return {
    family: resolution.family,
    ...(resolution.assetId ? { assetId: resolution.assetId } : {}),
    ...(resolution.revision !== undefined ? { revision: resolution.revision } : {}),
    enabled: resolution.enabled,
    source: resolution.source,
  };
}

function resolutionForFamily(
  family: ResolvedPromptFamily,
  source: PromptFamilySource,
  customPrompt?: ModelGlobalPromptOverride,
): ModelGlobalPromptResolution {
  if (family === "none") return { family, enabled: false, source };
  if (customPrompt?.text.trim()) {
    const assetId = customPrompt.id.trim().toLowerCase()
      .replace(/[^a-z0-9:._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      || "project:custom";
    const revision = Number.isSafeInteger(customPrompt.revision)
      && customPrompt.revision > 0
      ? customPrompt.revision
      : 1;
    const safeText = customPrompt.text.replaceAll(PROMPT_END_MARKER, "").trim();
    const startMarker = `<!-- ${PROMPT_MARKER_ID} id="${assetId}" family="${family}" revision="${revision}" -->`;
    return {
      family,
      enabled: true,
      source,
      assetId,
      revision,
      renderedText: `${startMarker}\n${safeText}\n${PROMPT_END_MARKER}`,
    };
  }
  const asset = MODEL_GLOBAL_PROMPT_ASSETS[family];
  return {
    family,
    enabled: true,
    source,
    assetId: asset.id,
    revision: asset.revision,
  };
}

function customPromptForFamily(
  input: ResolveModelGlobalPromptInput,
  family: ModelGlobalPromptFamily,
): ModelGlobalPromptOverride | undefined {
  return input.customPrompts?.[family] ?? input.customPrompt;
}

function normalizeIdentifier(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function familyForNormalizedModel(
  value: string | undefined,
): Exclude<ResolvedPromptFamily, "none"> | undefined {
  const normalized = normalizeIdentifier(value)
    .replace(/^models\//, "")
    .split("/")
    .at(-1) ?? "";
  if (/^(?:grok)(?:[-_.]|$)/.test(normalized)) return "grok";
  if (/^(?:gpt|codex|o1|o3|o4)(?:[-_.]|$)/.test(normalized)) return "gpt";
  if (/^(?:deepseek)(?:[-_.]|$)/.test(normalized)) return "deepseek";
  return undefined;
}

function familyForEndpoint(
  value: string | undefined,
): Exclude<ResolvedPromptFamily, "none"> | undefined {
  if (!value) return undefined;
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    if (hostname === "api.openai.com") return "gpt";
    if (hostname === "api.x.ai") return "grok";
    if (hostname === "api.deepseek.com") return "deepseek";
  } catch {
    // Invalid endpoint configuration is validated elsewhere; prompt fallback
    // remains conservative instead of trying fuzzy substring matching.
  }
  return undefined;
}

function stripPromptFromMessage<TMessage extends PromptCompatibleMessage>(
  message: TMessage,
): TMessage {
  const clone = cloneMessage(message);
  if (clone.role !== "system") return clone;
  return {
    ...clone,
    content: stripPromptFromContent(clone.content),
  } as TMessage;
}

function stripPromptFromContent(content: unknown): unknown {
  if (typeof content === "string") return stripKnownModelGlobalPromptPrefixes(content);
  if (!Array.isArray(content)) return cloneValue(content);
  return content.map((block) => {
    const clone = cloneValue(block);
    if (!isRecord(clone) || typeof clone.text !== "string") return clone;
    return {
      ...clone,
      text: stripKnownModelGlobalPromptPrefixes(clone.text),
    };
  });
}

function canPrependToContent(content: unknown): boolean {
  return typeof content === "string" || Array.isArray(content);
}

function prependPromptToContent(content: unknown, prompt: string): unknown {
  if (typeof content === "string") {
    return content.length > 0 ? `${prompt}\n\n${content}` : prompt;
  }
  if (!Array.isArray(content)) return content;

  const blocks = content.map((block) => cloneValue(block));
  const firstBlock = blocks[0];
  if (!isRecord(firstBlock) || typeof firstBlock.text !== "string") {
    return [{ type: "text", text: prompt }, ...blocks];
  }

  const text = firstBlock.text;
  blocks[0] = {
    ...firstBlock,
    text: text.length > 0 ? `${prompt}\n\n${text}` : prompt,
  };
  return blocks;
}

function cloneMessage<TMessage extends PromptCompatibleMessage>(message: TMessage): TMessage {
  return cloneValue(message) as TMessage;
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => cloneValue(entry)) as T;
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)]),
  ) as T;
}

function isReasoningBlock(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  const type = value.type.toLowerCase();
  return type === "thinking" || type === "reasoning" || type === "reasoning_content";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
