import {
  CodexCredentialError,
  CodexCredentialStore,
  GrokCredentialStore,
  GrokOAuthError,
  GrokOAuthLoginManager,
  type GrokOAuthConfigurationStatus,
  discoverCodexAuthCandidates,
  importDiscoveredCodexAuth,
} from "@actalk/inkos-core";
import type { Hono } from "hono";
import { ApiError } from "../errors.js";
import { credentialStatusDTO } from "./model-dto.js";
import { ModelManagementStore } from "./model-management-store.js";
import {
  optionalString,
  requestRecord,
  requiredString,
} from "./model-route-errors.js";

export function isHeaderSafeCredential(value: string): boolean {
  return /^[\x21-\x7e]+$/u.test(value);
}

export function registerModelAuthRoutes(
  app: Hono,
  store: ModelManagementStore,
  codexStore: CodexCredentialStore,
  grok: {
    readonly store: GrokCredentialStore;
    readonly config: GrokOAuthConfigurationStatus;
    readonly loginManager?: GrokOAuthLoginManager;
  },
): void {
  const pendingGrokLogins = new Map<string, {
    readonly credentialId: string;
    readonly label: string;
    readonly revision?: string;
    readonly wasConnected: boolean;
  }>();
  app.get("/api/v1/model-auth", async (c) => {
    const [{ routing }, secrets, codexStatuses, grokStatuses] = await Promise.all([
      store.read(),
      store.readSecrets(),
      codexStore.list(),
      grok.store.list(),
    ]);
    const codexById = new Map(codexStatuses.map((status) => [status.id, status]));
    const grokById = new Map(grokStatuses.map((status) => [status.id, status]));
    return c.json({
      credentials: routing.credentials.map((credential) =>
        credentialStatusDTO(
          credential,
          secrets,
          codexById.get(credential.id),
          grokById.get(credential.id),
        )),
    });
  });

  app.get("/api/v1/model-auth/grok/config", (c) => c.json(grok.config));

  app.get("/api/v1/model-auth/grok/accounts", async (c) => c.json({
    accounts: (await grok.store.list()).map((account) => ({
      id: account.id,
      issuer: account.issuer,
      accountHint: account.accountHint,
      expiresAt: account.expiresAt,
      nearExpiry: account.nearExpiry,
      active: account.active,
      authRequired: account.authRequired,
      lastRefresh: account.lastRefresh,
    })),
  }));

  app.post("/api/v1/model-auth/grok/login", async (c) => {
    if (!grok.loginManager) {
      throw new ApiError(
        409,
        "GROK_OAUTH_CONFIG_MISSING",
        `Grok OAuth configuration is missing: ${grok.config.missing.join(", ")}.`,
      );
    }
    const body = requestRecord(await c.req.json());
    const credentialId = requiredString(body.credentialId, "credentialId");
    const label = requiredString(body.label, "label");
    const revision = optionalString(body.revision, "revision");
    const existing = (await store.read()).routing.credentials.find(
      (credential) => credential.id === credentialId,
    );
    if (existing && existing.kind !== "grok_oauth") {
      throw new ApiError(
        409,
        "MODEL_CREDENTIAL_KIND_CONFLICT",
        `Credential "${credentialId}" already uses another credential kind.`,
      );
    }
    const start = await grok.loginManager.begin(credentialId, c.req.raw.signal)
      .catch((error) => { throw toGrokApiError(error); });
    pendingGrokLogins.set(start.sessionId, {
      credentialId,
      label,
      wasConnected: Boolean(await grok.store.getStatus(credentialId)),
      ...(revision ? { revision } : {}),
    });
    return c.json(start, 201);
  });

  app.get("/api/v1/model-auth/grok/login/:sessionId", (c) => {
    if (!grok.loginManager) {
      return c.json({ status: "missing", message: "Start the Grok connection again." });
    }
    const sessionId = c.req.param("sessionId");
    const status = grok.loginManager.status(sessionId);
    if (status !== "pending") pendingGrokLogins.delete(sessionId);
    return c.json({
      status,
      ...(status === "missing" || status === "expired"
        ? { message: "Start the Grok connection again." }
        : {}),
    });
  });

  app.post("/api/v1/model-auth/grok/login/:sessionId/complete", async (c) => {
    if (!grok.loginManager) {
      throw new ApiError(
        409,
        "GROK_LOGIN_SESSION_MISSING",
        "Grok login session is unavailable; start the connection again.",
      );
    }
    const sessionId = c.req.param("sessionId");
    const pending = pendingGrokLogins.get(sessionId);
    if (!pending) {
      throw new ApiError(
        410,
        "GROK_LOGIN_SESSION_MISSING",
        "Grok login session is unavailable; start the connection again.",
      );
    }
    const body = requestRecord(await c.req.json());
    const callback = requiredString(body.callback, "callback");
    try {
      const credential = await grok.loginManager.complete(
        sessionId,
        callback,
        c.req.raw.signal,
      );
      const revision = await ensureGrokMetadata(store, pending);
      grok.loginManager.cancel(sessionId);
      return c.json({ ok: true, revision, credential });
    } catch (error) {
      grok.loginManager.cancel(sessionId);
      if (!pending.wasConnected) {
        await grok.store.delete(pending.credentialId).catch(() => undefined);
      }
      throw toGrokApiError(error);
    } finally {
      pendingGrokLogins.delete(sessionId);
    }
  });

  app.delete("/api/v1/model-auth/grok/login/:sessionId", (c) => {
    const sessionId = c.req.param("sessionId");
    pendingGrokLogins.delete(sessionId);
    grok.loginManager?.cancel(sessionId);
    return c.json({ ok: true });
  });

  app.get("/api/v1/model-auth/grok/callback", async (c) => {
    if (!grok.loginManager) {
      return c.text("Grok login session is unavailable. Return to Studio and start again.", 410);
    }
    let completed: Awaited<ReturnType<GrokOAuthLoginManager["completeCallback"]>> | undefined;
    try {
      completed = await grok.loginManager.completeCallback(
        c.req.url,
        c.req.raw.signal,
      );
      const pending = pendingGrokLogins.get(completed.sessionId);
      if (!pending) {
        grok.loginManager.cancel(completed.sessionId);
        await grok.store.delete(completed.credential.id).catch(() => undefined);
        return c.text("Grok login session is unavailable. Return to Studio and start again.", 410);
      }
      await ensureGrokMetadata(store, pending);
      return c.text(
        `Grok account ${completed.credential.accountHint ?? "connected"} connected. Return to Studio.`,
      );
    } catch {
      if (completed) {
        grok.loginManager.cancel(completed.sessionId);
        const pending = pendingGrokLogins.get(completed.sessionId);
        if (!pending?.wasConnected) {
          await grok.store.delete(completed.credential.id).catch(() => undefined);
        }
      }
      return c.text("Grok connection failed. Return to Studio and start again.", 400);
    } finally {
      if (completed) pendingGrokLogins.delete(completed.sessionId);
    }
  });

  app.post("/api/v1/model-auth/grok/:credentialId/active", async (c) => {
    try {
      return c.json({
        ok: true,
        credential: await grok.store.setActive(c.req.param("credentialId")),
      });
    } catch (error) {
      throw toGrokApiError(error);
    }
  });

  app.delete("/api/v1/model-auth/grok/:credentialId", async (c) => {
    const body = requestRecord(await c.req.json().catch(() => ({})));
    const credentialId = c.req.param("credentialId");
    const updated = await store.removeUserCredential(
      optionalString(body.revision, "revision"),
      credentialId,
    );
    await grok.store.delete(credentialId);
    return c.json({ ok: true, revision: updated.revision });
  });

  app.get("/api/v1/model-auth/codex/discovery", async (c) => {
    return c.json({
      candidates: await discoverCodexAuthCandidates({
        projectRoot: store.projectRoot,
      }),
    });
  });

  app.post("/api/v1/model-auth/codex/import", async (c) => {
    const body = requestRecord(await c.req.json());
    const credentialId = requiredString(body.credentialId, "credentialId");
    const label = requiredString(body.label, "label");
    const content = requiredString(body.content, "content");
    const revision = optionalString(body.revision, "revision");
    const safeFileName = optionalString(body.fileName, "fileName") ?? "auth.json";
    let imported = false;
    try {
      const status = await codexStore.importBytes({
        id: credentialId,
        bytes: new TextEncoder().encode(content),
        safeFileName,
      });
      imported = true;
      const updated = await store.addUserCredential(revision, {
        id: credentialId,
        kind: "codex",
        label,
        scope: "user",
      });
      return c.json({
        revision: updated.revision,
        credential: status,
      }, 201);
    } catch (error) {
      if (imported) await codexStore.delete(credentialId).catch(() => undefined);
      throw toCodexApiError(error);
    }
  });

  app.post("/api/v1/model-auth/codex/import-discovered", async (c) => {
    const body = requestRecord(await c.req.json());
    const credentialId = requiredString(body.credentialId, "credentialId");
    const label = requiredString(body.label, "label");
    const candidateId = requiredString(body.candidateId, "candidateId");
    const revision = optionalString(body.revision, "revision");
    const mode = body.mode === "reference" ? "reference" : "copy";
    let imported = false;
    try {
      const status = await importDiscoveredCodexAuth(codexStore, {
        projectRoot: store.projectRoot,
        candidateId,
        credentialId,
        mode,
      });
      imported = true;
      const updated = await store.addUserCredential(revision, {
        id: credentialId,
        kind: "codex",
        label,
        scope: "user",
      });
      return c.json({
        revision: updated.revision,
        credential: status,
      }, 201);
    } catch (error) {
      if (imported) await codexStore.delete(credentialId).catch(() => undefined);
      throw toCodexApiError(error);
    }
  });

  app.put("/api/v1/model-auth/codex/:credentialId", async (c) => {
    const body = requestRecord(await c.req.json());
    const content = requiredString(body.content, "content");
    try {
      const status = await codexStore.replaceBytes({
        id: c.req.param("credentialId"),
        bytes: new TextEncoder().encode(content),
        safeFileName: optionalString(body.fileName, "fileName"),
      });
      return c.json({ ok: true, credential: status });
    } catch (error) {
      throw toCodexApiError(error);
    }
  });

  app.delete("/api/v1/model-auth/codex/:credentialId", async (c) => {
    const body = requestRecord(await c.req.json());
    const credentialId = c.req.param("credentialId");
    const updated = await store.removeUserCredential(
      optionalString(body.revision, "revision"),
      credentialId,
    );
    await codexStore.delete(credentialId);
    return c.json({ ok: true, revision: updated.revision });
  });

  app.put("/api/v1/model-auth/:credentialId", async (c) => {
    const body = requestRecord(await c.req.json());
    const trimmed = requiredString(body.apiKey, "apiKey");
    if (trimmed.length > 16_384) {
      return c.json({ error: { code: "MODEL_CREDENTIAL_INVALID", message: "API Key is too long." } }, 400);
    }
    if (!isHeaderSafeCredential(trimmed)) {
      return c.json({
        error: {
          code: "MODEL_CREDENTIAL_INVALID",
          message: "API Key must contain only non-whitespace printable ASCII characters.",
        },
      }, 400);
    }
    await store.replaceApiKey(c.req.param("credentialId"), trimmed);
    return c.json({ ok: true });
  });

  app.delete("/api/v1/model-auth/:credentialId", async (c) => {
    await store.clearApiKey(c.req.param("credentialId"));
    return c.json({ ok: true });
  });
}

function toCodexApiError(error: unknown): unknown {
  if (!(error instanceof CodexCredentialError)) return error;
  return new ApiError(
    error.code === "codex_credential_exists" ? 409 : 400,
    error.code.toUpperCase(),
    error.message,
  );
}

async function ensureGrokMetadata(
  store: ModelManagementStore,
  pending: {
    readonly credentialId: string;
    readonly label: string;
    readonly revision?: string;
    readonly wasConnected: boolean;
  },
): Promise<string> {
  const current = await store.read();
  const existing = current.routing.credentials.find(
    (credential) => credential.id === pending.credentialId,
  );
  if (existing) {
    if (existing.kind !== "grok_oauth") {
      throw new ApiError(
        409,
        "MODEL_CREDENTIAL_KIND_CONFLICT",
        `Credential "${pending.credentialId}" already uses another credential kind.`,
      );
    }
    return current.revision;
  }
  const updated = await store.addUserCredential(pending.revision, {
    id: pending.credentialId,
    kind: "grok_oauth",
    label: pending.label,
    scope: "user",
  });
  return updated.revision;
}

function toGrokApiError(error: unknown): unknown {
  if (!(error instanceof GrokOAuthError)) return error;
  const status = error.code.includes("session") ? 410 : 400;
  return new ApiError(status, error.code.toUpperCase(), error.message);
}
