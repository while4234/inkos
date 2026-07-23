import {
  BackendInstanceSchema,
  CredentialMetadataSchema,
} from "@actalk/inkos-core";
import type { Hono } from "hono";
import { ApiError } from "../errors.js";
import { backendInstanceDTO } from "./model-dto.js";
import { isHeaderSafeCredential } from "./model-auth.js";
import { ModelManagementStore } from "./model-management-store.js";
import {
  optionalString,
  parseCoreSchema,
  requestRecord,
  revisionFromRequest,
} from "./model-route-errors.js";

export function registerModelBackendRoutes(app: Hono, store: ModelManagementStore): void {
  app.get("/api/v1/model-backends", async (c) => {
    const [{ routing, revision }, secrets] = await Promise.all([store.read(), store.readSecrets()]);
    return c.json({
      revision,
      backends: routing.backends.map((backend) => {
        const credential = routing.credentials.find((item) => item.id === backend.credentialRef.id);
        if (!credential) throw new ApiError(500, "MODEL_CREDENTIAL_NOT_FOUND", "Routing credential metadata is inconsistent.");
        return backendInstanceDTO(backend, credential, secrets);
      }),
    }, 200, { ETag: `"${revision}"` });
  });

  app.post("/api/v1/model-backends", async (c) => {
    const raw = requestRecord(await c.req.json());
    const body = {
      revision: optionalString(raw.revision, "revision"),
      backend: parseCoreSchema(BackendInstanceSchema, raw.backend),
      credential: parseCoreSchema(CredentialMetadataSchema, raw.credential),
      apiKey: optionalString(raw.apiKey, "apiKey"),
    };
    const apiKey = body.apiKey?.trim();
    if (apiKey && apiKey.length > 16_384) {
      throw new ApiError(400, "MODEL_CREDENTIAL_INVALID", "API Key is too long.");
    }
    if (apiKey && !isHeaderSafeCredential(apiKey)) {
      throw new ApiError(400, "MODEL_CREDENTIAL_INVALID", "API Key must contain only non-whitespace printable ASCII characters.");
    }
    const result = await store.createBackend(
      revisionFromRequest(body, c.req.header("If-Match")),
      body.backend,
      body.credential,
      apiKey,
    );
    return c.json({ ok: true, revision: result.revision }, 201, { ETag: `"${result.revision}"` });
  });

  app.put("/api/v1/model-backends/:backendId", async (c) => {
    const raw = requestRecord(await c.req.json());
    const body = {
      revision: optionalString(raw.revision, "revision"),
      backend: parseCoreSchema(BackendInstanceSchema, raw.backend),
    };
    const backendId = c.req.param("backendId");
    if (body.backend.id !== backendId) {
      throw new ApiError(400, "MODEL_BACKEND_ID_MISMATCH", "Backend path and payload IDs must match.");
    }
    const result = await store.updateRouting(
      revisionFromRequest(body, c.req.header("If-Match")),
      (routing) => {
        const index = routing.backends.findIndex((item) => item.id === backendId);
        if (index < 0) throw new ApiError(404, "MODEL_BACKEND_NOT_FOUND", `Backend "${backendId}" was not found.`);
        const previous = routing.backends[index]!;
        if (
          body.backend.credentialRef.id !== previous.credentialRef.id
          || body.backend.credentialRef.kind !== previous.credentialRef.kind
        ) {
          throw new ApiError(409, "MODEL_BACKEND_CREDENTIAL_IMMUTABLE", "Create a new backend to change credential identity.");
        }
        routing.backends[index] = body.backend;
      },
    );
    return c.json({ ok: true, revision: result.revision }, 200, { ETag: `"${result.revision}"` });
  });

  app.delete("/api/v1/model-backends/:backendId", async (c) => {
    const raw = requestRecord(await c.req.json().catch(() => ({})));
    const body = { revision: optionalString(raw.revision, "revision") };
    const backendId = c.req.param("backendId");
    const result = await store.deleteBackend(
      revisionFromRequest(body, c.req.header("If-Match")),
      backendId,
    );
    return c.json({ ok: true, revision: result.revision }, 200, { ETag: `"${result.revision}"` });
  });
}
