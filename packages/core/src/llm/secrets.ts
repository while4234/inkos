import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { writeJsonAtomically } from "./atomic-json.js";

export interface SecretsFile {
  services: Record<string, { apiKey: string }>;
  credentials?: Record<string, {
    kind: "api_key";
    apiKey: string;
    legacyServiceId?: string;
  }>;
}

const SECRETS_DIR = ".inkos";
const SECRETS_FILE = "secrets.json";

const SecretsFileSchema = z.object({
  services: z.record(z.object({
    apiKey: z.string(),
  }).strict()),
  credentials: z.record(z.object({
    kind: z.literal("api_key"),
    apiKey: z.string(),
    legacyServiceId: z.string().min(1).optional(),
  }).strict()).optional(),
}).passthrough();

const LEGACY_SERVICE_ID_REMAP: Record<string, string> = {
  siliconflow: "siliconcloud",
};

function migrateLegacyServiceIds(secrets: SecretsFile): { data: SecretsFile; changed: boolean } {
  let changed = false;
  for (const [oldId, newId] of Object.entries(LEGACY_SERVICE_ID_REMAP)) {
    if (secrets.services[oldId] && !secrets.services[newId]) {
      secrets.services[newId] = secrets.services[oldId];
      delete secrets.services[oldId];
      changed = true;
    }
  }
  return { data: secrets, changed };
}

async function readSecretsRaw(
  projectRoot: string,
  options: { readonly strict?: boolean } = {},
): Promise<SecretsFile> {
  try {
    const raw = await readFile(
      join(projectRoot, SECRETS_DIR, SECRETS_FILE),
      "utf-8",
    );
    return SecretsFileSchema.parse(JSON.parse(raw));
  } catch (error) {
    if (isMissingFile(error)) return { services: {} };
    if (options.strict) {
      throw new Error("Project secrets file is invalid and was not modified.", { cause: error });
    }
    return { services: {} };
  }
}

export async function loadSecrets(
  projectRoot: string,
  options: { readonly strict?: boolean } = {},
): Promise<SecretsFile> {
  const raw = await readSecretsRaw(projectRoot, options);
  const { data, changed } = migrateLegacyServiceIds(raw);
  if (changed) await saveSecrets(projectRoot, data);
  return data;
}

export async function saveSecrets(
  projectRoot: string,
  secrets: SecretsFile,
): Promise<void> {
  const validated = SecretsFileSchema.parse(synchronizeLegacyCredentialSecrets(secrets));
  await writeJsonAtomically(
    join(projectRoot, SECRETS_DIR, SECRETS_FILE),
    validated,
    { directoryMode: 0o700, fileMode: 0o600 },
  );
}

export async function getServiceApiKey(
  projectRoot: string,
  service: string,
): Promise<string | null> {
  // 1. secrets.json
  const secrets = await loadSecrets(projectRoot);
  const entry = secrets.services[service];
  if (entry?.apiKey) return entry.apiKey;

  // 2. Environment variable: MOONSHOT_API_KEY, DEEPSEEK_API_KEY, etc.
  const envKey = `${service.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}_API_KEY`;
  if (process.env[envKey]) return process.env[envKey]!;

  return null;
}

export async function getCredentialApiKey(
  projectRoot: string,
  credentialId: string,
): Promise<string | null> {
  const secrets = await loadSecrets(projectRoot);
  return secrets.credentials?.[credentialId]?.apiKey ?? null;
}

function synchronizeLegacyCredentialSecrets(secrets: SecretsFile): SecretsFile {
  if (!secrets.credentials) return secrets;

  const credentials = { ...secrets.credentials };
  for (const [credentialId, credential] of Object.entries(credentials)) {
    if (!credential.legacyServiceId) continue;
    const serviceSecret = secrets.services[credential.legacyServiceId];
    if (!serviceSecret) {
      delete credentials[credentialId];
      continue;
    }
    credentials[credentialId] = {
      ...credential,
      apiKey: serviceSecret.apiKey,
    };
  }

  return {
    ...secrets,
    credentials,
  };
}

function isMissingFile(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && error.code === "ENOENT",
  );
}
