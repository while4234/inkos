import type { Hono } from "hono";
import { credentialStatusDTO } from "./model-dto.js";
import { ModelManagementStore } from "./model-management-store.js";
import { requestRecord, requiredString } from "./model-route-errors.js";

export function isHeaderSafeCredential(value: string): boolean {
  return /^[\x21-\x7e]+$/u.test(value);
}

export function registerModelAuthRoutes(app: Hono, store: ModelManagementStore): void {
  app.get("/api/v1/model-auth", async (c) => {
    const [{ routing }, secrets] = await Promise.all([store.read(), store.readSecrets()]);
    return c.json({
      credentials: routing.credentials.map((credential) => credentialStatusDTO(credential, secrets)),
    });
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
