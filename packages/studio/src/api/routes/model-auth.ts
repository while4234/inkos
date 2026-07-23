import {
  CodexCredentialError,
  CodexCredentialStore,
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
): void {
  app.get("/api/v1/model-auth", async (c) => {
    const [{ routing }, secrets, codexStatuses] = await Promise.all([
      store.read(),
      store.readSecrets(),
      codexStore.list(),
    ]);
    const codexById = new Map(codexStatuses.map((status) => [status.id, status]));
    return c.json({
      credentials: routing.credentials.map((credential) =>
        credentialStatusDTO(credential, secrets, codexById.get(credential.id))),
    });
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
