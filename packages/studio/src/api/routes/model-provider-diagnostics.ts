import {
  CODEX_DEFAULT_BASE_URL,
  GROK_DEFAULT_BASE_URL,
  CodexCredentialStore,
  GrokCredentialStore,
  classifyProviderError,
  getEndpoint,
  probeModelsFromUpstream,
  requestCodexResponses,
  requestGrokChatCompletion,
} from "@actalk/inkos-core";
import type { Hono } from "hono";
import { ApiError } from "../errors.js";

export interface ProviderModelOption {
  readonly id: string;
  readonly name: string;
}

export interface ModelProviderDiagnosticsOptions {
  readonly discoverCodexModels?: (
    credentialId: string,
    signal?: AbortSignal,
  ) => Promise<ReadonlyArray<ProviderModelOption>>;
  readonly discoverGrokModels?: (
    credentialId: string,
    signal?: AbortSignal,
  ) => Promise<ReadonlyArray<ProviderModelOption>>;
  readonly testCodexModel?: (
    credentialId: string,
    model: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly testGrokModel?: (
    credentialId: string,
    model: string,
    signal?: AbortSignal,
  ) => Promise<void>;
}

export function registerModelProviderDiagnosticRoutes(
  app: Hono,
  codexStore: CodexCredentialStore,
  grokStore: GrokCredentialStore,
  options: ModelProviderDiagnosticsOptions = {},
): void {
  const discoverCodexModels = options.discoverCodexModels
    ?? (() => Promise.resolve(catalogModels("openai", (id) =>
      id.includes("codex") || /^gpt-5(?:\.|$)/u.test(id))));
  const discoverGrokModels = options.discoverGrokModels
    ?? (async (credentialId, signal) => {
      const credential = await grokStore.resolve(credentialId, { signal });
      try {
        const models = await probeModelsFromUpstream(
          GROK_DEFAULT_BASE_URL,
          credential.accessToken,
          10_000,
          signal,
        );
        if (models.length > 0) {
          return models.map((model) => ({ id: model.id, name: model.name ?? model.id }));
        }
      } catch {
        // Some OAuth deployments do not expose /models. The checked provider
        // catalogue remains useful, and the selected model is verified below.
      }
      return catalogModels("xai");
    });
  const testCodexModel = options.testCodexModel
    ?? (async (credentialId, model, signal) => {
      const credential = await codexStore.resolve(credentialId, { signal });
      await requestCodexResponses({
        baseUrl: CODEX_DEFAULT_BASE_URL,
        model,
        credential,
        messages: [{ role: "user", content: "Reply with OK only." }],
        signal,
      });
    });
  const testGrokModel = options.testGrokModel
    ?? (async (credentialId, model, signal) => {
      const credential = await grokStore.resolve(credentialId, { signal });
      await requestGrokChatCompletion({
        baseUrl: GROK_DEFAULT_BASE_URL,
        model,
        credential,
        messages: [{ role: "user", content: "Reply with OK only." }],
        maxTokens: 16,
        signal,
      });
    });

  app.post("/api/v1/model-auth/codex/:credentialId/models", async (c) => {
    const credentialId = c.req.param("credentialId");
    await requireCredential(codexStore.getStatus(credentialId), credentialId);
    const models = await discoverCodexModels(credentialId, diagnosticSignal(c.req.raw.signal));
    return c.json({ models: normalizeModels(models), source: "credential_catalog" });
  });

  app.post("/api/v1/model-auth/grok/:credentialId/models", async (c) => {
    const credentialId = c.req.param("credentialId");
    await requireCredential(grokStore.getStatus(credentialId), credentialId);
    const models = await discoverGrokModels(credentialId, diagnosticSignal(c.req.raw.signal));
    return c.json({ models: normalizeModels(models), source: "credential_catalog" });
  });

  app.post("/api/v1/model-auth/codex/:credentialId/test", async (c) => {
    const credentialId = c.req.param("credentialId");
    const model = await modelFromRequest(c.req.json());
    const startedAt = Date.now();
    try {
      await testCodexModel(credentialId, model, diagnosticSignal(c.req.raw.signal));
      return c.json({ ok: true, model, latencyMs: Date.now() - startedAt });
    } catch (error) {
      throw safeDiagnosticError(error);
    }
  });

  app.post("/api/v1/model-auth/grok/:credentialId/test", async (c) => {
    const credentialId = c.req.param("credentialId");
    const model = await modelFromRequest(c.req.json());
    const startedAt = Date.now();
    try {
      await testGrokModel(credentialId, model, diagnosticSignal(c.req.raw.signal));
      return c.json({ ok: true, model, latencyMs: Date.now() - startedAt });
    } catch (error) {
      throw safeDiagnosticError(error);
    }
  });
}

function catalogModels(
  service: string,
  include: (id: string) => boolean = () => true,
): ProviderModelOption[] {
  return (getEndpoint(service)?.models ?? [])
    .filter((model) => model.enabled !== false && include(model.id))
    .map((model) => ({ id: model.id, name: model.id }));
}

function normalizeModels(
  models: ReadonlyArray<ProviderModelOption>,
): ProviderModelOption[] {
  const unique = new Map<string, ProviderModelOption>();
  for (const model of models) {
    const id = model.id.trim();
    if (id && !unique.has(id)) unique.set(id, { id, name: model.name.trim() || id });
  }
  return [...unique.values()];
}

async function requireCredential<T>(
  status: Promise<T | undefined>,
  credentialId: string,
): Promise<T> {
  const resolved = await status;
  if (!resolved) {
    throw new ApiError(
      404,
      "MODEL_CREDENTIAL_NOT_FOUND",
      `Credential "${credentialId}" is not connected.`,
    );
  }
  return resolved;
}

async function modelFromRequest(
  request: Promise<unknown>,
): Promise<string> {
  const body = await request;
  const model = body && typeof body === "object" && typeof (body as { model?: unknown }).model === "string"
    ? (body as { model: string }).model.trim()
    : "";
  if (!model) {
    throw new ApiError(400, "MODEL_REQUIRED", "Choose a model before testing the connection.");
  }
  return model;
}

function diagnosticSignal(requestSignal: AbortSignal): AbortSignal {
  return AbortSignal.any([requestSignal, AbortSignal.timeout(20_000)]);
}

function safeDiagnosticError(error: unknown): ApiError {
  const classified = classifyProviderError(error);
  return new ApiError(502, "MODEL_CONNECTION_TEST_FAILED", classified.safeMessage);
}
