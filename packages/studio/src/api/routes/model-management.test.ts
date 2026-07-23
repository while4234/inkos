import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { CodexCredentialStore } from "@actalk/inkos-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../errors.js";
import { registerModelManagementRoutes } from "./model-management.js";

const SECRET = "fixture-model-routing-key-12345";

function routingFixture() {
  return {
    version: 1,
    credentials: [
      { id: "credential-a", kind: "api_key", label: "Backend A key", scope: "project" },
    ],
    backends: [
      {
        id: "backend-a",
        displayName: "Backend A",
        service: "custom:a",
        provider: "custom",
        baseUrl: "http://127.0.0.1:41001/v1",
        credentialRef: { id: "credential-a", kind: "api_key" },
        enabled: true,
        transport: { apiFormat: "chat", stream: true },
      },
    ],
    routes: [
      {
        id: "route-a",
        displayName: "Writer",
        promptFamily: "gpt",
        enabled: true,
        candidates: [{ backendId: "backend-a", upstreamModelId: "gpt-fixture" }],
      },
    ],
    defaultRouteId: "route-a",
  };
}

describe("model management API", () => {
  let root: string;
  let codexRoot: string;
  let app: Hono;
  const probe = vi.fn(async () => ({ ok: true, modelCount: 2 }));

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-model-management-"));
    codexRoot = join(root, "user-credentials");
    await writeFile(join(root, "inkos.json"), JSON.stringify({
      name: "model-management",
      version: "0.1.0",
      llm: {
        provider: "custom",
        service: "custom:a",
        baseUrl: "http://127.0.0.1:41001/v1",
        apiKey: "",
        model: "gpt-fixture",
        routing: routingFixture(),
      },
    }), "utf-8");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, ".inkos"), { recursive: true });
    await writeFile(join(root, ".inkos", "secrets.json"), JSON.stringify({
      services: {},
      credentials: {
        "credential-a": { kind: "api_key", apiKey: SECRET },
      },
    }), "utf-8");

    app = new Hono();
    app.onError((error, c) => {
      if (error instanceof ApiError) {
        return c.json({ error: { code: error.code, message: error.message } }, error.status as 400);
      }
      throw error;
    });
    registerModelManagementRoutes(app, root, {
      probe,
      codexStore: new CodexCredentialStore(codexRoot),
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    probe.mockClear();
  });

  it("returns only credential status and a non-reversible mask", async () => {
    const response = await app.request("http://localhost/api/v1/model-auth");
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("Authorization");
    expect(JSON.parse(text).credentials[0]).toMatchObject({
      id: "credential-a",
      configured: true,
      source: "project_secret",
    });
  });

  it("does not let existingCredential bypass the Codex credential boundary", async () => {
    const initial = await json<{ revision: string }>(app, "/api/v1/model-backends");
    const response = await app.request("http://localhost/api/v1/model-backends", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        revision: initial.revision,
        existingCredential: true,
        backend: {
          id: "backend-bypass",
          displayName: "Bypass",
          service: "custom:bypass",
          provider: "custom",
          baseUrl: "http://127.0.0.1:41002/v1",
          credentialRef: { id: "credential-a", kind: "api_key" },
          enabled: true,
          transport: { apiFormat: "chat", stream: true },
        },
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "MODEL_CREDENTIAL_KIND_UNSUPPORTED" },
    });
  });

  it("imports, re-imports, binds, and safely protects a Codex CLI credential", async () => {
    const initial = await json<{ revision: string }>(app, "/api/v1/model-backends");
    const imported = await app.request("http://localhost/api/v1/model-auth/codex/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        revision: initial.revision,
        credentialId: "credential-codex",
        label: "Codex CLI",
        fileName: "auth.json",
        content: codexAuthJson("first"),
      }),
    });
    expect(imported.status).toBe(201);
    const importedBody = await imported.text();
    expect(importedBody).not.toContain(codexToken("first"));
    expect(importedBody).not.toContain(codexToken("refresh-first"));
    expect(importedBody).not.toContain(codexRoot);

    const auth = await app.request("http://localhost/api/v1/model-auth");
    const authText = await auth.text();
    expect(authText).not.toContain(codexToken("first"));
    expect(authText).not.toContain("Authorization");
    expect(JSON.parse(authText).credentials).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "credential-codex",
        kind: "codex",
        configured: true,
        source: "user_credential",
        codex: expect.objectContaining({
          source: "managed_copy",
          safeFileName: "auth.json",
          accountHint: "acco••••5678",
        }),
      }),
    ]));

    const afterImport = await json<{ revision: string }>(app, "/api/v1/model-backends");
    const backend = await app.request("http://localhost/api/v1/model-backends", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        revision: afterImport.revision,
        existingCredential: true,
        backend: {
          id: "backend-codex",
          displayName: "Codex",
          service: "codex",
          provider: "openai",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          credentialRef: { id: "credential-codex", kind: "codex" },
          enabled: true,
          transport: { apiFormat: "responses", stream: true },
        },
      }),
    });
    expect(backend.status).toBe(201);
    const backendList = await json<{ backends: Array<{ id: string; credential: { configured: boolean; codex?: { accountHint: string } } }> }>(
      app,
      "/api/v1/model-backends",
    );
    expect(backendList.backends).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "backend-codex",
        credential: expect.objectContaining({
          configured: true,
          codex: expect.objectContaining({ accountHint: "acco••••5678" }),
        }),
      }),
    ]));

    const reimported = await app.request("http://localhost/api/v1/model-auth/codex/credential-codex", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "new-auth.json", content: codexAuthJson("second") }),
    });
    expect(reimported.status).toBe(200);
    expect(await readFile(join(codexRoot, "auth", "credential-codex.json"), "utf8"))
      .toContain(codexToken("second"));

    const blocked = await app.request("http://localhost/api/v1/model-auth/codex/credential-codex", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        revision: (await json<{ revision: string }>(app, "/api/v1/model-backends")).revision,
      }),
    });
    expect(blocked.status).toBe(409);
    expect(await readFile(join(codexRoot, "auth", "credential-codex.json"), "utf8"))
      .toContain(codexToken("second"));
  });

  it("creates a second backend and an ordered two-candidate route with CAS protection", async () => {
    const initial = await json<{ revision: string }>(app, "/api/v1/model-backends");
    const createBackend = await app.request("http://localhost/api/v1/model-backends", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        revision: initial.revision,
        credential: { id: "credential-b", kind: "api_key", label: "Backend B key", scope: "project" },
        backend: {
          id: "backend-b",
          displayName: "Backend B",
          service: "custom:b",
          provider: "custom",
          baseUrl: "http://127.0.0.1:41002/v1",
          credentialRef: { id: "credential-b", kind: "api_key" },
          enabled: true,
          transport: { apiFormat: "chat", stream: true },
        },
        apiKey: "fixture-backend-b-key-67890",
      }),
    });
    expect(createBackend.status).toBe(201);
    const nextRevision = (await createBackend.json() as { revision: string }).revision;

    const stale = await app.request("http://localhost/api/v1/model-routes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        revision: initial.revision,
        route: {
          id: "route-stale",
          displayName: "Stale",
          promptFamily: "none",
          enabled: true,
          candidates: [{ backendId: "backend-a", upstreamModelId: "fixture" }],
        },
      }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.text()).toContain("MODEL_ROUTING_REVISION_CONFLICT");

    const createRoute = await app.request("http://localhost/api/v1/model-routes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        revision: nextRevision,
        route: {
          id: "route-ab",
          displayName: "Writer A/B",
          promptFamily: "gpt",
          enabled: true,
          candidates: [
            { backendId: "backend-a", upstreamModelId: "gpt-fixture" },
            { backendId: "backend-b", upstreamModelId: "gpt-fixture" },
          ],
        },
      }),
    });
    expect(createRoute.status).toBe(201);

    const routes = await json<{ routes: Array<{ id: string; candidates: Array<{ backendId: string }> }> }>(
      app,
      "/api/v1/model-routes",
    );
    expect(routes.routes.find((route) => route.id === "route-ab")?.candidates.map((candidate) => candidate.backendId))
      .toEqual(["backend-a", "backend-b"]);
    const persisted = await readFile(join(root, "inkos.json"), "utf-8");
    expect(persisted).not.toContain(SECRET);
    expect(persisted).not.toContain("fixture-backend-b-key-67890");
  });

  it("rejects dangling backend deletion and empty or duplicate routes", async () => {
    const { revision } = await json<{ revision: string }>(app, "/api/v1/model-backends");
    const inUse = await app.request("http://localhost/api/v1/model-backends/backend-a", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision }),
    });
    expect(inUse.status).toBe(409);
    expect(await inUse.text()).toContain("MODEL_BACKEND_IN_USE");

    const empty = await app.request("http://localhost/api/v1/model-routes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        revision,
        route: { id: "route-empty", displayName: "Empty", promptFamily: "none", enabled: true, candidates: [] },
      }),
    });
    expect(empty.status).toBe(400);
    expect(await empty.text()).toContain("MODEL_ROUTING_VALIDATION_ERROR");
  });

  it("deletes an unreferenced backend together with its orphaned credential secret", async () => {
    const initial = await json<{ revision: string }>(app, "/api/v1/model-backends");
    const create = await app.request("http://localhost/api/v1/model-backends", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        revision: initial.revision,
        credential: { id: "credential-unused", kind: "api_key", label: "Unused key", scope: "project" },
        backend: {
          id: "backend-unused",
          displayName: "Unused",
          service: "custom:unused",
          provider: "custom",
          baseUrl: "http://127.0.0.1:41999/v1",
          credentialRef: { id: "credential-unused", kind: "api_key" },
          enabled: true,
          transport: { apiFormat: "chat", stream: true },
        },
        apiKey: "fixture-unused-backend-key-12345",
      }),
    });
    expect(create.status).toBe(201);
    const { revision } = await create.json() as { revision: string };

    const deleted = await app.request("http://localhost/api/v1/model-backends/backend-unused", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision }),
    });
    expect(deleted.status).toBe(200);

    const [configText, secretText] = await Promise.all([
      readFile(join(root, "inkos.json"), "utf-8"),
      readFile(join(root, ".inkos", "secrets.json"), "utf-8"),
    ]);
    expect(configText).not.toContain("backend-unused");
    expect(configText).not.toContain("credential-unused");
    expect(secretText).not.toContain("credential-unused");
    expect(secretText).not.toContain("fixture-unused-backend-key-12345");
  });

  it("replaces, keeps out of GET, and explicitly clears an API Key", async () => {
    const replacement = "fixture-replacement-key-99999";
    expect((await app.request("http://localhost/api/v1/model-auth/credential-a", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: replacement }),
    })).status).toBe(200);

    const statusText = await (await app.request("http://localhost/api/v1/model-auth")).text();
    expect(statusText).not.toContain(replacement);
    expect(statusText).not.toContain(SECRET);

    expect((await app.request("http://localhost/api/v1/model-auth/credential-a", {
      method: "DELETE",
    })).status).toBe(200);
    const after = await json<{ credentials: Array<{ configured: boolean }> }>(app, "/api/v1/model-auth");
    expect(after.credentials[0]?.configured).toBe(false);
  });

  it("uses the injected controlled /models probe and persists reset/probe health", async () => {
    const probeResponse = await app.request("http://localhost/api/v1/model-health/backend-a/probe", {
      method: "POST",
    });
    expect(probeResponse.status).toBe(200);
    expect(probe).toHaveBeenCalledWith(
      expect.objectContaining({ id: "backend-a" }),
      SECRET,
    );
    const probeText = await probeResponse.text();
    expect(probeText).not.toContain(SECRET);

    const health = await json<{ backends: Array<{ backendId: string; status: string; lastProbe: { outcome: string } }> }>(
      app,
      "/api/v1/model-health",
    );
    expect(health.backends[0]).toMatchObject({
      backendId: "backend-a",
      status: "healthy",
      lastProbe: { outcome: "success" },
    });
    expect((await app.request("http://localhost/api/v1/model-health/backend-a/reset", { method: "POST" })).status).toBe(200);
  });
});

async function json<T>(app: Hono, path: string): Promise<T> {
  const response = await app.request(`http://localhost${path}`);
  expect(response.status).toBe(200);
  return await response.json() as T;
}

function codexAuthJson(label: string): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      access_token: codexToken(label),
      refresh_token: codexToken(`refresh-${label}`),
      account_id: "account-studio-12345678",
      expires_at: "2099-01-01T00:00:00.000Z",
    },
  });
}

function codexToken(label: string): string {
  return ["fixture", "codex", label, "credential"].join("-");
}
