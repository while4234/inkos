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

export interface CustomServiceBackendUpsert {
  readonly expectedRevision: string;
  readonly service: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  readonly backendId: string;
  readonly credentialId: string;
  readonly routeId: string;
  readonly apiFormat: "chat" | "responses";
  readonly stream: boolean;
  readonly enabled: boolean;
  readonly includeInFailover: boolean;
}

type RoutingMutation = (routing: ModelRoutingConfig) => void;

const projectMutationQueues = new Map<string, Promise<void>>();
const EMPTY_ROUTING: ModelRoutingConfig = {
  version: 1,
  credentials: [],
  backends: [],
  routes: [],
  defaultRouteId: null,
};

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

  public async repairDuplicateCustomServices(): Promise<ProjectRoutingDocument> {
    return this.serialize(async () => {
      const current = await this.readUnlocked();
      const routing = structuredClone(current.routing);
      const groups = new Map<string, BackendInstance[]>();
      for (const backend of routing.backends) {
        if (
          backend.credentialRef.kind !== "api_key"
          || !backend.service.startsWith("custom:")
        ) {
          continue;
        }
        const key = `${backend.service}\0${backend.baseUrl.trim().replace(/\/+$/u, "").toLowerCase()}`;
        const group = groups.get(key) ?? [];
        group.push(backend);
        groups.set(key, group);
      }

      let changed = false;
      for (const backends of groups.values()) {
        if (backends.length < 2) continue;
        const backendIds = new Set(backends.map((backend) => backend.id));
        const defaultRoute = routing.routes.find(
          (route) => route.id === routing.defaultRouteId,
        );
        const defaultBackendId = defaultRoute?.candidates.find((candidate) =>
          backendIds.has(candidate.backendId)
        )?.backendId;
        const preferred = backends.find((backend) => backend.id === defaultBackendId)
          ?? backends[0]!;
        const routeOrigins = new Map<string, string | undefined>(
          routing.routes.map((route) => [
            route.id,
            route.candidates.find((candidate) =>
              backendIds.has(candidate.backendId)
            )?.backendId,
          ]),
        );

        routing.backends = routing.backends.filter(
          (backend) => !backendIds.has(backend.id) || backend.id === preferred.id,
        );
        routing.routes = routing.routes.map((route) => ({
          ...route,
          candidates: deduplicateCandidates(route.candidates.map((candidate) =>
            backendIds.has(candidate.backendId)
              ? { ...candidate, backendId: preferred.id }
              : candidate
          )),
        }));

        const duplicateRouteIds = new Set<string>();
        const routesByCandidate = new Map<string, LogicalModelRoute[]>();
        for (const route of routing.routes) {
          if (
            route.candidates.length !== 1
            || route.candidates[0]?.backendId !== preferred.id
            || !routeOrigins.get(route.id)
          ) {
            continue;
          }
          const model = route.candidates[0].upstreamModelId;
          const routes = routesByCandidate.get(model) ?? [];
          routes.push(route);
          routesByCandidate.set(model, routes);
        }
        for (const routes of routesByCandidate.values()) {
          if (routes.length < 2) continue;
          const keep = routes.find((route) => route.id === routing.defaultRouteId)
            ?? routes.find((route) => routeOrigins.get(route.id) === preferred.id)
            ?? routes[0]!;
          for (const route of routes) {
            if (route.id !== keep.id) duplicateRouteIds.add(route.id);
          }
        }
        routing.routes = routing.routes.filter(
          (route) => !duplicateRouteIds.has(route.id),
        );
        changed = true;
      }

      if (!changed) return current;

      if (
        routing.defaultRouteId
        && !routing.routes.some((route) => route.id === routing.defaultRouteId)
      ) {
        routing.defaultRouteId = routing.routes.find((route) => route.enabled)?.id ?? null;
      }
      const referencedCredentialIds = new Set(
        routing.backends.map((backend) => backend.credentialRef.id),
      );
      const removedCredentialIds = routing.credentials
        .filter((credential) =>
          credential.kind === "api_key"
          && !referencedCredentialIds.has(credential.id)
        )
        .map((credential) => credential.id);
      routing.credentials = routing.credentials.filter((credential) =>
        credential.kind !== "api_key"
        || referencedCredentialIds.has(credential.id)
      );

      const parsed = parseRouting(routing);
      const config = structuredClone(current.config);
      const llm = objectValue(config.llm) ?? {};
      llm.routing = parsed;
      synchronizeLegacySelection(llm, parsed);
      config.llm = llm;

      const secrets = await this.readSecretsUnlocked();
      const originalSecrets = structuredClone(secrets);
      for (const credentialId of removedCredentialIds) {
        delete secrets.credentials?.[credentialId];
      }
      await saveSecrets(this.projectRoot, secrets);
      try {
        await writeJsonAtomically(
          join(this.projectRoot, "inkos.json"),
          config,
          { fileMode: 0o600 },
        );
      } catch (error) {
        await saveSecrets(this.projectRoot, originalSecrets);
        throw error;
      }
      return {
        config,
        routing: parsed,
        revision: routingRevision(parsed),
      };
    });
  }

  public async setApiKey(
    expectedRevision: string | undefined,
    credentialId: string,
    apiKey: string,
  ): Promise<ProjectRoutingDocument> {
    return this.serialize(async () => {
      const current = await this.readUnlocked();
      assertRevision(expectedRevision, current.revision);
      const credential = current.routing.credentials.find((item) => item.id === credentialId);
      if (!credential || credential.kind !== "api_key") {
        throw new ApiError(
          404,
          "MODEL_CREDENTIAL_NOT_FOUND",
          `API Key credential "${credentialId}" was not found.`,
        );
      }
      const secrets = await this.readSecretsUnlocked();
      secrets.credentials ??= {};
      secrets.credentials[credentialId] = { kind: "api_key", apiKey };
      await saveSecrets(this.projectRoot, secrets);
      return current;
    });
  }

  public async upsertCustomServiceBackend(
    input: CustomServiceBackendUpsert,
  ): Promise<ProjectRoutingDocument> {
    return this.serialize(async () => {
      const current = await this.readUnlocked();
      assertRevision(input.expectedRevision, current.revision);
      const routing = structuredClone(current.routing);
      const matchingBackends = routing.backends.filter((backend) =>
        backend.service === input.service && backend.credentialRef.kind === "api_key"
      );
      const defaultRoute = routing.routes.find(
        (route) => route.id === routing.defaultRouteId,
      );
      const defaultBackendId = defaultRoute?.candidates.find((candidate) =>
        matchingBackends.some((backend) => backend.id === candidate.backendId)
      )?.backendId;
      const selectedBackend = matchingBackends.find(
        (backend) => backend.id === defaultBackendId,
      ) ?? matchingBackends.find(
        (backend) => backend.id === input.backendId,
      ) ?? matchingBackends[0];
      const backendId = selectedBackend?.id ?? input.backendId;
      const credentialId = selectedBackend?.credentialRef.id ?? input.credentialId;
      const equivalentBackendIds = new Set([
        backendId,
        ...matchingBackends.map((backend) => backend.id),
      ]);

      const backend = BackendInstanceSchema.parse({
        id: backendId,
        displayName: input.displayName,
        service: input.service,
        provider: selectedBackend?.provider ?? "custom",
        baseUrl: input.baseUrl,
        credentialRef: { id: credentialId, kind: "api_key" },
        enabled: input.enabled,
        transport: {
          apiFormat: input.apiFormat,
          stream: input.stream,
        },
      });
      routing.backends = [
        ...routing.backends.filter((candidate) =>
          !equivalentBackendIds.has(candidate.id)
        ),
        backend,
      ];

      const credential = routing.credentials.find(
        (candidate) => candidate.id === credentialId,
      );
      if (!credential) {
        routing.credentials.push(CredentialMetadataSchema.parse({
          id: credentialId,
          kind: "api_key",
          label: `${input.displayName} API Key`,
          scope: "project",
        }));
      }

      const relatedRoutes = routing.routes.filter((route) =>
        route.candidates.some((candidate) =>
          equivalentBackendIds.has(candidate.backendId)
        )
      );
      const selectedRoute = relatedRoutes.find(
        (route) => route.id === routing.defaultRouteId
          && route.candidates.some((candidate) =>
            equivalentBackendIds.has(candidate.backendId)
            && candidate.upstreamModelId === input.model
          ),
      ) ?? relatedRoutes.find((route) =>
        route.candidates.some((candidate) =>
          equivalentBackendIds.has(candidate.backendId)
          && candidate.upstreamModelId === input.model
        )
      ) ?? routing.routes.find((route) => route.id === input.routeId);
      const routeId = selectedRoute?.id ?? input.routeId;
      const desiredCandidate = {
        backendId,
        upstreamModelId: input.model,
      };

      routing.routes = routing.routes.flatMap((route) => {
        if (route.id === routeId) return [];
        const candidates = deduplicateCandidates(route.candidates.map((candidate) =>
          equivalentBackendIds.has(candidate.backendId)
            ? { ...candidate, backendId }
            : candidate
        ));
        const duplicatesDesiredRoute = candidates.length === 1
          && candidates[0]?.backendId === backendId
          && candidates[0]?.upstreamModelId === input.model
          && route.candidates.every((candidate) =>
            equivalentBackendIds.has(candidate.backendId)
          );
        if (duplicatesDesiredRoute) return [];
        return [{ ...route, candidates }];
      });

      if (input.includeInFailover) {
        routing.routes.push(LogicalModelRouteSchema.parse({
          id: routeId,
          displayName: selectedRoute?.displayName ?? `${input.displayName} route`,
          promptFamily: selectedRoute?.promptFamily ?? inferPromptFamily(input.model),
          enabled: true,
          candidates: [desiredCandidate],
          ...(selectedRoute?.globalPrompt
            ? { globalPrompt: selectedRoute.globalPrompt }
            : {}),
        }));
        if (
          routing.defaultRouteId === null
          || !routing.routes.some((route) => route.id === routing.defaultRouteId)
        ) {
          routing.defaultRouteId = routeId;
        }
      } else if (
        routing.defaultRouteId === routeId
        || !routing.routes.some((route) => route.id === routing.defaultRouteId)
      ) {
        routing.defaultRouteId = routing.routes.find((route) => route.enabled)?.id ?? null;
      }

      const referencedCredentialIds = new Set(
        routing.backends.map((candidate) => candidate.credentialRef.id),
      );
      const removedCredentialIds = routing.credentials
        .filter((candidate) =>
          candidate.kind === "api_key"
          && !referencedCredentialIds.has(candidate.id)
        )
        .map((candidate) => candidate.id);
      routing.credentials = routing.credentials.filter((candidate) =>
        candidate.kind !== "api_key"
        || referencedCredentialIds.has(candidate.id)
      );

      const parsed = parseRouting(routing);
      const config = structuredClone(current.config);
      const llm = objectValue(config.llm) ?? {};
      llm.routing = parsed;
      synchronizeLegacySelection(llm, parsed);
      config.llm = llm;

      const secrets = await this.readSecretsUnlocked();
      const originalSecrets = structuredClone(secrets);
      secrets.credentials ??= {};
      secrets.credentials[credentialId] = {
        kind: "api_key",
        apiKey: input.apiKey,
        legacyServiceId: input.service,
      };
      for (const removedCredentialId of removedCredentialIds) {
        delete secrets.credentials[removedCredentialId];
      }
      await saveSecrets(this.projectRoot, secrets);
      try {
        await writeJsonAtomically(
          join(this.projectRoot, "inkos.json"),
          config,
          { fileMode: 0o600 },
        );
      } catch (error) {
        await saveSecrets(this.projectRoot, originalSecrets);
        throw error;
      }
      return {
        config,
        routing: parsed,
        revision: routingRevision(parsed),
      };
    });
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
      const llm = objectValue(config.llm) ?? {};
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
      const llm = objectValue(config.llm) ?? {};
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

  public async createBackendWithExistingCredential(
    expectedRevision: string | undefined,
    backendValue: unknown,
  ): Promise<ProjectRoutingDocument> {
    const backend = BackendInstanceSchema.parse(backendValue);
    return this.updateRouting(expectedRevision, (routing) => {
      if (routing.backends.some((item) => item.id === backend.id)) {
        throw new ApiError(409, "MODEL_BACKEND_DUPLICATE_ID", `Backend "${backend.id}" already exists.`);
      }
      const credential = routing.credentials.find((item) => item.id === backend.credentialRef.id);
      if (!credential || credential.kind !== backend.credentialRef.kind) {
        throw new ApiError(
          404,
          "MODEL_CREDENTIAL_NOT_FOUND",
          `Credential "${backend.credentialRef.id}" was not found.`,
        );
      }
      routing.backends.push(backend);
    });
  }

  public async addUserCredential(
    expectedRevision: string | undefined,
    credentialValue: unknown,
  ): Promise<ProjectRoutingDocument> {
    const credential = CredentialMetadataSchema.parse(credentialValue);
    if (credential.scope !== "user" || credential.kind === "api_key") {
      throw new ApiError(
        400,
        "MODEL_CREDENTIAL_SCOPE_INVALID",
        "Imported login credentials must use a user scope and a non-API-key kind.",
      );
    }
    return this.updateRouting(expectedRevision, (routing) => {
      if (routing.credentials.some((item) => item.id === credential.id)) {
        throw new ApiError(409, "MODEL_CREDENTIAL_DUPLICATE_ID", `Credential "${credential.id}" already exists.`);
      }
      routing.credentials.push(credential);
    });
  }

  public async removeUserCredential(
    expectedRevision: string | undefined,
    credentialId: string,
  ): Promise<ProjectRoutingDocument> {
    return this.updateRouting(expectedRevision, (routing) => {
      const credential = routing.credentials.find((item) => item.id === credentialId);
      if (!credential) {
        throw new ApiError(404, "MODEL_CREDENTIAL_NOT_FOUND", `Credential "${credentialId}" was not found.`);
      }
      const referencedBy = routing.backends.filter((backend) =>
        backend.credentialRef.id === credentialId);
      if (referencedBy.length > 0) {
        throw new ApiError(
          409,
          "MODEL_CREDENTIAL_IN_USE",
          `Credential "${credentialId}" is used by backend(s): ${referencedBy.map((backend) => backend.id).join(", ")}.`,
        );
      }
      routing.credentials = routing.credentials.filter((item) => item.id !== credentialId);
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
      const removedCredential = credentialId
        ? routing.credentials.find((credential) => credential.id === credentialId)
        : undefined;
      const removeCredential = Boolean(
        credentialId
        && removedCredential?.kind === "api_key"
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
      if (credential.kind !== "api_key") {
        throw new ApiError(409, "MODEL_CREDENTIAL_KIND_UNSUPPORTED", "Only API Key credentials can be cleared with this endpoint.");
      }
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
      const routing = structuredClone(EMPTY_ROUTING);
      return { config: raw, routing, revision: routingRevision(routing) };
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
  if (!routing.defaultRouteId) return;
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

function deduplicateCandidates(
  candidates: LogicalModelRoute["candidates"],
): LogicalModelRoute["candidates"] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.backendId}\0${candidate.upstreamModelId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function inferPromptFamily(model: string): "gpt" | "grok" | "deepseek" | "generic" {
  const normalized = model.trim().toLowerCase();
  if (/^(?:gpt|codex|o1|o3|o4)(?:[-_.]|$)/u.test(normalized)) return "gpt";
  if (/^grok(?:[-_.]|$)/u.test(normalized)) return "grok";
  if (/^deepseek(?:[-_.]|$)/u.test(normalized)) return "deepseek";
  return "generic";
}
