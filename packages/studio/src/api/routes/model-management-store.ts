import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BackendInstanceSchema,
  CredentialMetadataSchema,
  LogicalModelRouteSchema,
  ModelRoutingConfigSchema,
  loadSecrets,
  saveSecrets,
  writeJsonAtomically,
  type BackendInstance,
  type CredentialMetadata,
  type LogicalModelRoute,
  type ModelRoutingConfig,
  type SecretsFile,
} from "@actalk/inkos-core";
import { ApiError } from "../errors.js";

interface ProjectRoutingDocument {
  readonly config: Record<string, unknown>;
  readonly routing: ModelRoutingConfig;
  readonly revision: string;
}

type RoutingMutation = (routing: ModelRoutingConfig) => void;

const projectMutationQueues = new Map<string, Promise<void>>();

export class ModelManagementStore {
  public constructor(public readonly projectRoot: string) {}

  public async read(): Promise<ProjectRoutingDocument> {
    await projectMutationQueues.get(this.projectRoot)?.catch(() => undefined);
    return this.readUnlocked();
  }

  public async readSecrets(): Promise<SecretsFile> {
    await projectMutationQueues.get(this.projectRoot)?.catch(() => undefined);
    return this.readSecretsUnlocked();
  }

  public async updateRouting(
    expectedRevision: string | undefined,
    mutate: RoutingMutation,
  ): Promise<ProjectRoutingDocument> {
    return this.serialize(async () => {
      const current = await this.readUnlocked();
      assertRevision(expectedRevision, current.revision);
      const routing = structuredClone(current.routing);
      mutate(routing);
      const parsed = parseRouting(routing);
      const config = structuredClone(current.config);
      const llm = objectValue(config.llm);
      if (!llm) throw new ApiError(409, "MODEL_ROUTING_MISSING", "Project LLM configuration is missing.");
      llm.routing = parsed;
      synchronizeLegacySelection(llm, parsed);
      config.llm = llm;
      await writeJsonAtomically(join(this.projectRoot, "inkos.json"), config, { fileMode: 0o600 });
      return { config, routing: parsed, revision: routingRevision(parsed) };
    });
  }

  public async createBackend(
    expectedRevision: string | undefined,
    backendValue: unknown,
    credentialValue: unknown,
    apiKey?: string,
  ): Promise<ProjectRoutingDocument> {
    const backend = BackendInstanceSchema.parse(backendValue);
    const credential = CredentialMetadataSchema.parse(credentialValue);
    return this.serialize(async () => {
      const current = await this.readUnlocked();
      assertRevision(expectedRevision, current.revision);
      const routing = structuredClone(current.routing);
      if (routing.backends.some((item) => item.id === backend.id)) {
        throw new ApiError(409, "MODEL_BACKEND_DUPLICATE_ID", `Backend "${backend.id}" already exists.`);
      }
      if (routing.credentials.some((item) => item.id === credential.id)) {
        throw new ApiError(409, "MODEL_CREDENTIAL_DUPLICATE_ID", `Credential "${credential.id}" already exists.`);
      }
      if (backend.credentialRef.id !== credential.id || backend.credentialRef.kind !== credential.kind) {
        throw new ApiError(400, "MODEL_BACKEND_CREDENTIAL_MISMATCH", "Backend credential reference does not match its credential metadata.");
      }
      routing.credentials.push(credential);
      routing.backends.push(backend);
      const parsed = parseRouting(routing);
      const config = structuredClone(current.config);
      const llm = objectValue(config.llm)!;
      llm.routing = parsed;
      config.llm = llm;

      const secrets = await this.readSecretsUnlocked();
      const originalSecrets = structuredClone(secrets);
      if (apiKey) {
        secrets.credentials ??= {};
        secrets.credentials[credential.id] = { kind: "api_key", apiKey };
      }
      if (apiKey) await saveSecrets(this.projectRoot, secrets);
      try {
        await writeJsonAtomically(join(this.projectRoot, "inkos.json"), config, { fileMode: 0o600 });
      } catch (error) {
        if (apiKey) await saveSecrets(this.projectRoot, originalSecrets);
        throw error;
      }
      return { config, routing: parsed, revision: routingRevision(parsed) };
    });
  }

  public async deleteBackend(
    expectedRevision: string | undefined,
    backendId: string,
  ): Promise<ProjectRoutingDocument> {
    return this.serialize(async () => {
      const current = await this.readUnlocked();
      assertRevision(expectedRevision, current.revision);
      const routing = structuredClone(current.routing);
      const index = routing.backends.findIndex((item) => item.id === backendId);
      if (index < 0) {
        throw new ApiError(404, "MODEL_BACKEND_NOT_FOUND", `Backend "${backendId}" was not found.`);
      }
      const referencedBy = routing.routes.filter((route) =>
        route.candidates.some((candidate) => candidate.backendId === backendId),
      );
      if (referencedBy.length > 0) {
        throw new ApiError(
          409,
          "MODEL_BACKEND_IN_USE",
          `Backend "${backendId}" is referenced by route(s): ${referencedBy.map((route) => route.id).join(", ")}.`,
        );
      }

      const [removed] = routing.backends.splice(index, 1);
      const credentialId = removed?.credentialRef.id;
      const removeCredential = Boolean(
        credentialId
        && !routing.backends.some((backend) => backend.credentialRef.id === credentialId),
      );
      if (removeCredential) {
        routing.credentials = routing.credentials.filter((credential) => credential.id !== credentialId);
      }

      const parsed = parseRouting(routing);
      const config = structuredClone(current.config);
      const llm = objectValue(config.llm);
      if (!llm) {
        throw new ApiError(409, "MODEL_ROUTING_MISSING", "Project LLM configuration is missing.");
      }
      llm.routing = parsed;
      synchronizeLegacySelection(llm, parsed);
      config.llm = llm;

      const secrets = removeCredential ? await this.readSecretsUnlocked() : undefined;
      const originalSecrets = secrets ? structuredClone(secrets) : undefined;
      if (secrets && credentialId) {
        const legacyServiceId = secrets.credentials?.[credentialId]?.legacyServiceId;
        if (secrets.credentials) delete secrets.credentials[credentialId];
        if (legacyServiceId) delete secrets.services[legacyServiceId];
        await saveSecrets(this.projectRoot, secrets);
      }
      try {
        await writeJsonAtomically(join(this.projectRoot, "inkos.json"), config, { fileMode: 0o600 });
      } catch (error) {
        if (originalSecrets) await saveSecrets(this.projectRoot, originalSecrets);
        throw error;
      }
      return { config, routing: parsed, revision: routingRevision(parsed) };
    });
  }

  public async replaceApiKey(credentialId: string, apiKey: string): Promise<void> {
    await this.serialize(async () => {
      const { routing } = await this.readUnlocked();
      const credential = routing.credentials.find((item) => item.id === credentialId);
      if (!credential) throw new ApiError(404, "MODEL_CREDENTIAL_NOT_FOUND", `Credential "${credentialId}" was not found.`);
      if (credential.kind !== "api_key") {
        throw new ApiError(409, "MODEL_CREDENTIAL_KIND_UNSUPPORTED", "Only API Key credentials can be changed in this release.");
      }
      const secrets = await this.readSecretsUnlocked();
      secrets.credentials ??= {};
      const legacyServiceId = secrets.credentials[credentialId]?.legacyServiceId;
      secrets.credentials[credentialId] = {
        kind: "api_key",
        apiKey,
        ...(legacyServiceId ? { legacyServiceId } : {}),
      };
      if (legacyServiceId) secrets.services[legacyServiceId] = { apiKey };
      await saveSecrets(this.projectRoot, secrets);
    });
  }

  public async clearApiKey(credentialId: string): Promise<void> {
    await this.serialize(async () => {
      const { routing } = await this.readUnlocked();
      const credential = routing.credentials.find((item) => item.id === credentialId);
      if (!credential) throw new ApiError(404, "MODEL_CREDENTIAL_NOT_FOUND", `Credential "${credentialId}" was not found.`);
      const secrets = await this.readSecretsUnlocked();
      const legacyServiceId = secrets.credentials?.[credentialId]?.legacyServiceId;
      if (secrets.credentials) delete secrets.credentials[credentialId];
      if (legacyServiceId) delete secrets.services[legacyServiceId];
      await saveSecrets(this.projectRoot, secrets);
    });
  }

  private async readUnlocked(): Promise<ProjectRoutingDocument> {
    const raw = JSON.parse(await readFile(join(this.projectRoot, "inkos.json"), "utf-8")) as Record<string, unknown>;
    const llm = objectValue(raw.llm);
    if (!llm?.routing) {
      throw new ApiError(409, "MODEL_ROUTING_MISSING", "Normalized model routing has not been configured.");
    }
    const routing = parseRouting(llm.routing);
    return { config: raw, routing, revision: routingRevision(routing) };
  }

  private readSecretsUnlocked(): Promise<SecretsFile> {
    return loadSecrets(this.projectRoot, { strict: true });
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = projectMutationQueues.get(this.projectRoot) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    const settled = run.then(() => undefined, () => undefined);
    projectMutationQueues.set(this.projectRoot, settled);
    return run.finally(() => {
      if (projectMutationQueues.get(this.projectRoot) === settled) {
        projectMutationQueues.delete(this.projectRoot);
      }
    });
  }
}

export function addBackend(routing: ModelRoutingConfig, backend: BackendInstance): void {
  routing.backends.push(backend);
}

export function addRoute(routing: ModelRoutingConfig, route: LogicalModelRoute): void {
  routing.routes.push(route);
}

export function parseRoute(value: unknown): LogicalModelRoute {
  return LogicalModelRouteSchema.parse(value);
}

export function routingRevision(routing: ModelRoutingConfig): string {
  return createHash("sha256").update(JSON.stringify(routing)).digest("hex").slice(0, 16);
}

function parseRouting(value: unknown): ModelRoutingConfig {
  const parsed = ModelRoutingConfigSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
  throw new ApiError(400, "MODEL_ROUTING_VALIDATION_ERROR", issues);
}

function assertRevision(expected: string | undefined, current: string): void {
  if (!expected) {
    throw new ApiError(428, "MODEL_ROUTING_REVISION_REQUIRED", "The current routing revision is required.");
  }
  if (expected !== current) {
    throw new ApiError(409, "MODEL_ROUTING_REVISION_CONFLICT", `Routing changed since it was loaded. Current revision: ${current}`);
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function synchronizeLegacySelection(llm: Record<string, unknown>, routing: ModelRoutingConfig): void {
  const route = routing.routes.find((item) => item.id === routing.defaultRouteId);
  const candidate = route?.candidates[0];
  const backend = candidate
    ? routing.backends.find((item) => item.id === candidate.backendId)
    : undefined;
  if (!route || !candidate || !backend) return;
  llm.service = backend.service;
  llm.defaultModel = candidate.upstreamModelId;
  llm.model = candidate.upstreamModelId;
  llm.provider = backend.provider;
  llm.baseUrl = backend.baseUrl;
  llm.apiFormat = backend.transport.apiFormat;
  llm.stream = backend.transport.stream;
}
