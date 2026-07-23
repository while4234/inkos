import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  BackendInstance,
  CredentialMetadata,
  LogicalModelRoute,
  PromptFamily,
} from "./model-routing.js";
import {
  MODEL_ROUTING_SCHEMA_VERSION,
  ModelRoutingConfigSchema,
  stableRoutingId,
} from "./model-routing.js";
import { writeJsonAtomically } from "./atomic-json.js";
import { loadSecrets, saveSecrets, type SecretsFile } from "./secrets.js";
import {
  guessServiceFromBaseUrl,
  resolveServicePreset,
  resolveServiceProviderFamily,
} from "./service-presets.js";

export interface MigrationResult {
  readonly migrated: boolean;
  readonly routingCreated: boolean;
  readonly secretsUpgraded: boolean;
}

export interface ConfigMigrationOptions {
  readonly writeConfig?: (path: string, config: Record<string, unknown>) => Promise<void>;
  readonly writeSecrets?: (projectRoot: string, secrets: SecretsFile) => Promise<void>;
}

interface ServiceEntry {
  readonly service: string;
  readonly name?: string;
  readonly baseUrl?: string;
  readonly apiFormat?: "chat" | "responses";
  readonly stream?: boolean;
}

export async function migrateConfig(
  projectRoot: string,
  options: ConfigMigrationOptions = {},
): Promise<MigrationResult> {
  const configPath = join(projectRoot, "inkos.json");
  let raw: string;
  try {
    raw = await readFile(configPath, "utf-8");
  } catch {
    return { migrated: false, routingCreated: false, secretsUpgraded: false };
  }

  const config = parseConfig(raw, configPath);
  const llm = objectValue(config.llm);
  if (!llm) {
    return { migrated: false, routingCreated: false, secretsUpgraded: false };
  }

  const originalConfig = JSON.stringify(config);
  const secrets = await loadSecrets(projectRoot, { strict: true });
  const originalSecrets = JSON.stringify(secrets);
  const originalSecretsValue = structuredClone(secrets);
  const inlineApiKey = stringValue(llm.apiKey);

  migrateLegacyServiceShape(llm);
  const services = normalizeServices(llm.services);
  if (services.length === 0) {
    return { migrated: false, routingCreated: false, secretsUpgraded: false };
  }

  const routingCreated = !llm.routing && createRoutingConfig(llm, services, secrets, inlineApiKey);
  if (llm.routing) {
    upgradeRoutingSecrets(llm.routing, secrets, routingCreated ? undefined : inlineApiKey);
  }
  delete llm.apiKey;
  config.llm = llm;

  const configChanged = JSON.stringify(config) !== originalConfig;
  const secretsChanged = JSON.stringify(secrets) !== originalSecrets;
  if (!configChanged && !secretsChanged) {
    return { migrated: false, routingCreated: false, secretsUpgraded: false };
  }

  const writeSecrets = options.writeSecrets ?? saveSecrets;
  const writeConfig = options.writeConfig
    ?? ((path, value) => writeJsonAtomically(path, value, { fileMode: 0o600 }));

  // Secrets are prepared first. If the config write fails, the legacy service
  // map remains intact and a retry can safely complete the migration.
  if (secretsChanged) {
    await writeSecrets(projectRoot, secrets);
  }
  try {
    if (configChanged) {
      await writeConfig(configPath, config);
    }
  } catch (error) {
    if (secretsChanged) {
      try {
        await writeSecrets(projectRoot, originalSecretsValue);
      } catch {
        throw new Error(
          "Project config migration failed and secret rollback could not be completed; the legacy service secret remains readable.",
          { cause: error },
        );
      }
    }
    throw error;
  }

  return {
    migrated: true,
    routingCreated,
    secretsUpgraded: secretsChanged,
  };
}

export async function writeProjectConfigWithRouting(
  projectRoot: string,
  config: Record<string, unknown>,
): Promise<void> {
  const configPath = join(projectRoot, "inkos.json");
  const llm = objectValue(config.llm);
  const secrets = await loadSecrets(projectRoot, { strict: true });
  const originalSecrets = structuredClone(secrets);
  const originalSecretsText = JSON.stringify(secrets);

  if (llm) {
    const services = normalizeServices(llm.services);
    if (services.length > 0) {
      reconcileLegacyRouting(llm, services, secrets);
      upgradeRoutingSecrets(llm.routing, secrets, stringValue(llm.apiKey));
      delete llm.apiKey;
      config.llm = llm;
    }
  }

  const secretsChanged = JSON.stringify(secrets) !== originalSecretsText;
  if (secretsChanged) await saveSecrets(projectRoot, secrets);
  try {
    await writeJsonAtomically(configPath, config, { fileMode: 0o600 });
  } catch (error) {
    if (secretsChanged) {
      await saveSecrets(projectRoot, originalSecrets);
    }
    throw error;
  }
}

function migrateLegacyServiceShape(llm: Record<string, unknown>): void {
  if (Array.isArray(llm.services)) return;

  const model = stringValue(llm.model);
  const provider = stringValue(llm.provider);
  if (!model && !provider) return;

  const baseUrl = stringValue(llm.baseUrl);
  const guessedService = baseUrl ? guessServiceFromBaseUrl(baseUrl) : null;
  const service = guessedService ?? stringValue(llm.service) ?? "custom";
  const serviceEntry: Record<string, unknown> = { service };
  if (service === "custom") {
    serviceEntry.name = "Custom";
  }
  if (baseUrl) serviceEntry.baseUrl = baseUrl;
  if (llm.apiFormat === "chat" || llm.apiFormat === "responses") {
    serviceEntry.apiFormat = llm.apiFormat;
  }
  if (typeof llm.stream === "boolean") serviceEntry.stream = llm.stream;

  const preserved = { ...llm };
  delete preserved.provider;
  delete preserved.model;
  delete preserved.baseUrl;
  delete preserved.apiKey;
  llm.services = [serviceEntry];
  llm.defaultModel = model ?? stringValue(llm.defaultModel);
  for (const key of Object.keys(llm)) delete llm[key];
  Object.assign(llm, preserved, {
    services: [serviceEntry],
    ...(model ? { defaultModel: model } : {}),
  });
  delete llm.provider;
  delete llm.model;
  delete llm.baseUrl;
  delete llm.apiKey;
}

function createRoutingConfig(
  llm: Record<string, unknown>,
  services: readonly ServiceEntry[],
  secrets: SecretsFile,
  inlineApiKey: string | undefined,
): boolean {
  const defaultModel = stringValue(llm.defaultModel) ?? stringValue(llm.model);
  if (!defaultModel) return false;

  const selected = selectService(services, stringValue(llm.service));
  if (!selected) return false;

  const credentials: CredentialMetadata[] = [];
  const backends: BackendInstance[] = [];
  for (const service of services) {
    const backend = createBackend(service, llm);
    if (!backend) continue;
    backends.push(backend);
    credentials.push({
      id: backend.credentialRef.id,
      kind: "api_key",
      label: `${backend.displayName} API Key`,
      scope: "project",
    });

    const serviceKey = serviceIdentity(service);
    const legacySecret = secrets.services[serviceKey]?.apiKey
      ?? (service === selected ? inlineApiKey : undefined);
    if (legacySecret) {
      secrets.credentials ??= {};
      secrets.credentials[backend.credentialRef.id] = {
        kind: "api_key",
        apiKey: legacySecret,
        legacyServiceId: serviceKey,
      };
      secrets.services[serviceKey] ??= { apiKey: legacySecret };
    }
  }

  const selectedBackendId = stableRoutingId("backend", serviceIdentity(selected));
  if (!backends.some((backend) => backend.id === selectedBackendId)) return false;

  const routeId = stableRoutingId("route", `${serviceIdentity(selected)}\0${defaultModel}`);
  const routes: LogicalModelRoute[] = [{
    id: routeId,
    displayName: defaultModel,
    promptFamily: inferPromptFamily(defaultModel),
    enabled: true,
    candidates: [{
      backendId: selectedBackendId,
      upstreamModelId: defaultModel,
    }],
  }];
  const routing = ModelRoutingConfigSchema.parse({
    version: MODEL_ROUTING_SCHEMA_VERSION,
    credentials,
    backends,
    routes,
    defaultRouteId: routeId,
  });
  llm.routing = routing;
  return true;
}

function reconcileLegacyRouting(
  llm: Record<string, unknown>,
  services: readonly ServiceEntry[],
  secrets: SecretsFile,
): void {
  if (!llm.routing) {
    createRoutingConfig(llm, services, secrets, stringValue(llm.apiKey));
    return;
  }

  const desiredLlm = { ...llm };
  delete desiredLlm.routing;
  if (!createRoutingConfig(desiredLlm, services, secrets, stringValue(llm.apiKey))) {
    return;
  }

  const existing = ModelRoutingConfigSchema.parse(llm.routing);
  const desired = ModelRoutingConfigSchema.parse(desiredLlm.routing);
  llm.routing = ModelRoutingConfigSchema.parse({
    ...existing,
    credentials: mergeById(existing.credentials, desired.credentials),
    backends: mergeById(existing.backends, desired.backends),
    routes: mergeById(existing.routes, desired.routes),
    defaultRouteId: desired.defaultRouteId,
  });
}

function mergeById<T extends { readonly id: string }>(
  existing: readonly T[],
  desired: readonly T[],
): T[] {
  const merged = new Map(existing.map((entry) => [entry.id, entry]));
  desired.forEach((entry) => merged.set(entry.id, entry));
  return [...merged.values()];
}

function upgradeRoutingSecrets(
  rawRouting: unknown,
  secrets: SecretsFile,
  inlineApiKey: string | undefined,
): void {
  const routing = ModelRoutingConfigSchema.parse(rawRouting);
  const defaultRoute = routing.routes.find((route) => route.id === routing.defaultRouteId);
  const defaultBackendId = defaultRoute?.candidates[0]?.backendId;

  for (const backend of routing.backends) {
    if (backend.credentialRef.kind !== "api_key") continue;
    const serviceKey = backend.service;
    const legacySecret = (backend.id === defaultBackendId ? inlineApiKey : undefined)
      ?? secrets.services[serviceKey]?.apiKey;
    if (!legacySecret) continue;

    if (backend.id === defaultBackendId && inlineApiKey) {
      secrets.services[serviceKey] = { apiKey: inlineApiKey };
    } else {
      secrets.services[serviceKey] ??= { apiKey: legacySecret };
    }
    secrets.credentials ??= {};
    secrets.credentials[backend.credentialRef.id] = {
      kind: "api_key",
      apiKey: legacySecret,
      legacyServiceId: serviceKey,
    };
  }
}

function createBackend(
  service: ServiceEntry,
  llm: Record<string, unknown>,
): BackendInstance | undefined {
  const identity = serviceIdentity(service);
  const preset = resolveServicePreset(service.service);
  const baseUrl = service.baseUrl
    ?? preset?.baseUrl
    ?? (identity === stringValue(llm.service) ? stringValue(llm.baseUrl) : undefined);
  if (!baseUrl) return undefined;

  const provider = resolveServiceProviderFamily(service.service)
    ?? (identity === stringValue(llm.service) ? providerValue(llm.provider) : undefined)
    ?? "custom";
  const apiFormat = service.apiFormat
    ?? (llm.apiFormat === "responses" ? "responses" : undefined)
    ?? (preset?.api.startsWith("openai-responses") ? "responses" : "chat");

  return {
    id: stableRoutingId("backend", identity),
    displayName: service.name ?? service.service,
    service: identity,
    provider,
    baseUrl,
    credentialRef: {
      id: stableRoutingId("credential", identity),
      kind: "api_key",
    },
    enabled: true,
    transport: {
      apiFormat,
      stream: service.stream ?? (typeof llm.stream === "boolean" ? llm.stream : true),
    },
  };
}

function normalizeServices(raw: unknown): ServiceEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .map((entry) => ({
      service: stringValue(entry.service) ?? "custom",
      ...(stringValue(entry.name) ? { name: stringValue(entry.name) } : {}),
      ...(stringValue(entry.baseUrl) ? { baseUrl: stringValue(entry.baseUrl) } : {}),
      ...(entry.apiFormat === "chat" || entry.apiFormat === "responses"
        ? { apiFormat: entry.apiFormat }
        : {}),
      ...(typeof entry.stream === "boolean" ? { stream: entry.stream } : {}),
    }));
}

function selectService(
  services: readonly ServiceEntry[],
  configuredService: string | undefined,
): ServiceEntry | undefined {
  if (!configuredService) return services[0];
  return services.find((service) => (
    serviceIdentity(service) === configuredService
    || service.service === configuredService
  )) ?? services[0];
}

function serviceIdentity(service: ServiceEntry): string {
  return service.service === "custom"
    ? `custom:${service.name ?? "Custom"}`
    : service.service;
}

function inferPromptFamily(model: string): PromptFamily {
  const normalized = model.toLowerCase();
  if (normalized.includes("grok")) return "grok";
  if (normalized.includes("gpt") || normalized.includes("codex")) return "gpt";
  if (normalized.includes("deepseek")) return "deepseek";
  return "generic";
}

function parseConfig(raw: string, path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("root value must be an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Cannot migrate invalid project config at ${path}.`, { cause: error });
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function providerValue(value: unknown): "anthropic" | "openai" | "custom" | undefined {
  return value === "anthropic" || value === "openai" || value === "custom"
    ? value
    : undefined;
}
