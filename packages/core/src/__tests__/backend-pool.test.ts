import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BackendPool } from "../llm/backend-pool.js";
import { FileBackendHealthStore } from "../llm/backend-health-store.js";
import { CredentialResolver } from "../llm/credentials/index.js";
import type { BackendInstance, ModelRoutingConfig } from "../llm/model-routing.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("BackendPool", () => {
  it("preserves route order while skipping every unavailable candidate class", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-backend-pool-"));
    roots.push(root);
    const health = new FileBackendHealthStore(root);
    await health.recordFailure({
      backendId: "backend-health",
      status: "quota_exhausted",
      reason: "quota",
      at: 1_000,
    });
    const credentials = new CredentialResolver([{
      kind: "api_key" as const,
      resolve: async (ref) => {
        if (ref.id === "credential-missing") {
          throw new Error("fixture credential unavailable");
        }
        return { kind: "api_key" as const, apiKey: "fixture-key" };
      },
    }]);
    const routing = createRouting();
    const pool = new BackendPool(routing, credentials, health, {
      now: () => 2_000,
      supportsModel: (_backend, model) => model !== "unsupported-model",
    });

    const resolution = await pool.resolve("route-main");

    expect(resolution.candidates.map(({ backend }) => backend.id)).toEqual(["backend-ready"]);
    expect(resolution.skipped.map(({ backendId, reason }) => ({ backendId, reason }))).toEqual([
      { backendId: "backend-disabled", reason: "disabled" },
      { backendId: "backend-health", reason: "health_unavailable" },
      { backendId: "backend-model", reason: "model_unsupported" },
      { backendId: "backend-codex", reason: "unsupported_credential_kind" },
      { backendId: "backend-missing-credential", reason: "credential_unavailable" },
      { backendId: "backend-ready", reason: "duplicate_backend" },
      { backendId: "backend-not-configured", reason: "missing_backend" },
    ]);

    const attempted = await pool.resolve("route-main", new Set(["backend-ready"]));
    expect(attempted.candidates).toHaveLength(0);
    expect(attempted.skipped.some((entry) => (
      entry.backendId === "backend-ready" && entry.reason === "already_attempted"
    ))).toBe(true);
  });
});

function createRouting(): ModelRoutingConfig {
  const backends: BackendInstance[] = [
    backend("backend-disabled", "credential-ready", false),
    backend("backend-health", "credential-ready"),
    backend("backend-model", "credential-ready"),
    {
      ...backend("backend-codex", "credential-codex"),
      credentialRef: { id: "credential-codex", kind: "codex" },
    },
    backend("backend-missing-credential", "credential-missing"),
    backend("backend-ready", "credential-ready"),
  ];
  return {
    version: 1,
    credentials: [
      { id: "credential-ready", kind: "api_key", label: "Ready", scope: "project" },
      { id: "credential-missing", kind: "api_key", label: "Missing", scope: "project" },
      { id: "credential-codex", kind: "codex", label: "Codex", scope: "user" },
    ],
    backends,
    routes: [{
      id: "route-main",
      displayName: "Main",
      promptFamily: "generic",
      enabled: true,
      candidates: [
        { backendId: "backend-disabled", upstreamModelId: "disabled-model" },
        { backendId: "backend-health", upstreamModelId: "health-model" },
        { backendId: "backend-model", upstreamModelId: "unsupported-model" },
        { backendId: "backend-codex", upstreamModelId: "codex-model" },
        { backendId: "backend-missing-credential", upstreamModelId: "missing-key-model" },
        { backendId: "backend-ready", upstreamModelId: "ready-model" },
        { backendId: "backend-ready", upstreamModelId: "ready-model-duplicate" },
        { backendId: "backend-not-configured", upstreamModelId: "missing-backend-model" },
      ],
    }],
    defaultRouteId: "route-main",
  };
}

function backend(
  id: string,
  credentialId: string,
  enabled = true,
): BackendInstance {
  return {
    id,
    displayName: id,
    service: id,
    provider: "custom",
    baseUrl: "https://fixture.invalid/v1",
    credentialRef: { id: credentialId, kind: "api_key" },
    enabled,
    transport: { apiFormat: "chat", stream: false },
  };
}
