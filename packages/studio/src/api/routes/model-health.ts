import {
  FileBackendHealthStore,
  classifyProviderError,
  probeModelsFromUpstream,
  runBackendProbeSingleFlight,
  withProbeTimeout,
  type BackendInstance,
} from "@actalk/inkos-core";
import type { Hono } from "hono";
import { ApiError } from "../errors.js";
import { backendHealthDTO } from "./model-dto.js";
import { ModelManagementStore } from "./model-management-store.js";
import { StudioRoutingActivity } from "./model-routing-activity.js";

export interface StudioBackendProbeResult {
  readonly ok: boolean;
  readonly modelCount: number;
  readonly reason?: string;
}

export type StudioBackendProbe = (
  backend: BackendInstance,
  apiKey: string,
  options?: { readonly signal?: AbortSignal },
) => Promise<StudioBackendProbeResult>;

export interface ModelHealthRouteOptions {
  readonly healthStore?: FileBackendHealthStore;
  readonly probe?: StudioBackendProbe;
  readonly activity: StudioRoutingActivity;
}

export function registerModelHealthRoutes(
  app: Hono,
  store: ModelManagementStore,
  options: ModelHealthRouteOptions,
): void {
  let healthStore = options.healthStore;
  const getHealthStore = () => {
    healthStore ??= new FileBackendHealthStore(store.projectRoot);
    return healthStore;
  };
  const probe = options.probe ?? defaultBackendProbe;
  const runProbe = (
    backend: BackendInstance,
    apiKey: string,
    signal?: AbortSignal,
  ) => runBackendProbeSingleFlight(
    getHealthStore(),
    backend.id,
    () => withProbeTimeout(
      (probeSignal) => probe(backend, apiKey, { signal: probeSignal }),
      { timeoutMs: 10_000, signal },
    ),
  );

  app.get("/api/v1/model-health", async (c) => {
    const [{ routing }, health] = await Promise.all([store.read(), getHealthStore().read()]);
    return c.json({
      healthRevision: health.revision,
      backends: routing.backends.map((backend) => backendHealthDTO(backend, health)),
      activeRoutes: Object.values(health.routes),
      recentActivity: options.activity.recent(),
    });
  });

  app.post("/api/v1/model-health/:backendId/reset", async (c) => {
    const backendId = c.req.param("backendId");
    const { routing } = await store.read();
    if (!routing.backends.some((backend) => backend.id === backendId)) {
      throw new ApiError(404, "MODEL_BACKEND_NOT_FOUND", `Backend "${backendId}" was not found.`);
    }
    const record = await getHealthStore().reset(backendId);
    return c.json({ ok: true, health: backendHealthDTO(
      routing.backends.find((backend) => backend.id === backendId)!,
      {
        version: 1,
        revision: 0,
        backends: { [backendId]: record },
        routes: {},
      },
    ) });
  });

  app.post("/api/v1/model-health/:backendId/probe", async (c) => {
    const backendId = c.req.param("backendId");
    const [{ routing }, secrets] = await Promise.all([store.read(), store.readSecrets()]);
    const backend = routing.backends.find((item) => item.id === backendId);
    if (!backend) throw new ApiError(404, "MODEL_BACKEND_NOT_FOUND", `Backend "${backendId}" was not found.`);
    if (!backend.enabled) throw new ApiError(409, "MODEL_BACKEND_DISABLED", "Enable the backend before probing it.");
    if (backend.credentialRef.kind !== "api_key") {
      throw new ApiError(409, "MODEL_CREDENTIAL_KIND_UNSUPPORTED", "This release can probe only API Key backends.");
    }
    const apiKey = secrets.credentials?.[backend.credentialRef.id]?.apiKey;
    if (!apiKey) throw new ApiError(409, "MODEL_CREDENTIAL_NOT_CONFIGURED", "Configure the backend API Key before probing it.");

    const result = await runProbe(backend, apiKey, c.req.raw.signal);
    const record = await getHealthStore().recordProbe({
      backendId,
      outcome: result.ok ? "success" : "failure",
      ...(result.reason ? { reason: result.reason } : {}),
    });
    return c.json({
      ok: result.ok,
      modelCount: result.modelCount,
      health: backendHealthDTO(backend, {
        version: 1,
        revision: 0,
        backends: { [backendId]: record },
        routes: {},
      }),
    }, result.ok ? 200 : 502);
  });

  app.post("/api/v1/model-backends/:backendId/test", async (c) => {
    const backendId = c.req.param("backendId");
    const [{ routing }, secrets] = await Promise.all([store.read(), store.readSecrets()]);
    const backend = routing.backends.find((item) => item.id === backendId);
    if (!backend) throw new ApiError(404, "MODEL_BACKEND_NOT_FOUND", `Backend "${backendId}" was not found.`);
    const apiKey = secrets.credentials?.[backend.credentialRef.id]?.apiKey;
    if (!apiKey) throw new ApiError(409, "MODEL_CREDENTIAL_NOT_CONFIGURED", "Configure the backend API Key before testing it.");
    const result = await runProbe(backend, apiKey, c.req.raw.signal);
    return c.json(result, result.ok ? 200 : 502);
  });

  app.post("/api/v1/model-routes/:routeId/test", async (c) => {
    const routeId = c.req.param("routeId");
    const [{ routing }, secrets] = await Promise.all([store.read(), store.readSecrets()]);
    const route = routing.routes.find((item) => item.id === routeId);
    if (!route) throw new ApiError(404, "MODEL_ROUTE_NOT_FOUND", `Route "${routeId}" was not found.`);
    const attempts: Array<{ backendId: string; ok: boolean; modelCount: number; reason?: string }> = [];
    for (const candidate of route.candidates) {
      const backend = routing.backends.find((item) => item.id === candidate.backendId);
      if (!backend?.enabled) continue;
      const apiKey = secrets.credentials?.[backend.credentialRef.id]?.apiKey;
      if (!apiKey) {
        attempts.push({ backendId: backend.id, ok: false, modelCount: 0, reason: "credential_not_configured" });
        continue;
      }
      const result = await runProbe(backend, apiKey, c.req.raw.signal);
      attempts.push({ backendId: backend.id, ...result });
      if (result.ok) break;
    }
    return c.json({ ok: attempts.some((attempt) => attempt.ok), attempts });
  });
}

async function defaultBackendProbe(
  backend: BackendInstance,
  apiKey: string,
  options?: { readonly signal?: AbortSignal },
): Promise<StudioBackendProbeResult> {
  try {
    // /models has no chat payload, so no model-global prompt can be injected.
    const models = await probeModelsFromUpstream(
      backend.baseUrl,
      apiKey,
      10_000,
      options?.signal,
    );
    if (models.length === 0) {
      return {
        ok: false,
        modelCount: 0,
        reason: "The backend probe returned no usable models.",
      };
    }
    return { ok: true, modelCount: models.length };
  } catch (error) {
    const providerError = classifyProviderError(error);
    return { ok: false, modelCount: 0, reason: providerError.safeMessage };
  }
}
