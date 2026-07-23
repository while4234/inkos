import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { writeJsonAtomically } from "../atomic-json.js";
import type { CredentialProvider, CredentialResolveOptions } from "./index.js";
import type { CredentialRef } from "../model-routing.js";

export const CODEX_AUTH_MAX_BYTES = 1 << 20;
export const CODEX_DEFAULT_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const CODEX_DEFAULT_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CODEX_DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_REFRESH_SKEW_MS = 60_000;

const REGISTRY_VERSION = 1 as const;
const STABLE_CREDENTIAL_ID = /^[a-z0-9][a-z0-9._:-]*$/u;

export type CodexCredentialSource = "managed_copy" | "external_reference";
export type CodexDiscoverySource =
  | "CODEX_AUTH_FILE"
  | "CODEX_HOME"
  | "project"
  | "user_home";
export type CodexDiscoveryState =
  | "available"
  | "missing"
  | "unreadable"
  | "invalid"
  | "permission_denied";

export interface ParsedCodexAuth {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly accountId?: string;
  readonly expiresAt?: string;
  readonly payload: Record<string, unknown>;
}

export interface CodexDiscoveryCandidate {
  readonly candidateId: string;
  readonly sources: ReadonlyArray<CodexDiscoverySource>;
  readonly safeFileName: string;
  readonly state: CodexDiscoveryState;
  readonly accountHint: string | null;
  readonly expiresAt: string | null;
  readonly nearExpiry: boolean;
  readonly message: string;
}

export interface CodexCredentialStatus {
  readonly id: string;
  readonly source: CodexCredentialSource;
  readonly safeFileName: string;
  readonly accountHint: string | null;
  readonly expiresAt: string | null;
  readonly nearExpiry: boolean;
  readonly needsReimport: boolean;
  readonly lastRefresh: "never" | "succeeded" | "failed";
}

export interface ResolvedCodexCredential {
  readonly kind: "codex";
  readonly accessToken: string;
  readonly accountId?: string;
  readonly refresh: (
    force?: boolean,
    options?: CredentialResolveOptions,
  ) => Promise<ResolvedCodexCredential>;
}

interface CodexRegistryEntry {
  readonly id: string;
  readonly source: CodexCredentialSource;
  readonly safeFileName: string;
  readonly filePath: string;
  readonly lastRefresh?: "succeeded" | "failed";
}

interface CodexRegistry {
  readonly version: typeof REGISTRY_VERSION;
  readonly credentials: ReadonlyArray<CodexRegistryEntry>;
}

interface CodexDiscoveryInput {
  readonly projectRoot: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
}

export interface CodexTokenRefreshResult {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: string;
  readonly accountId?: string;
}

export interface CodexTokenRefresher {
  refresh(
    refreshToken: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<CodexTokenRefreshResult>;
}

export class CodexCredentialError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly authRequired = false,
  ) {
    super(message);
    this.name = "CodexCredentialError";
  }
}

export class FetchCodexTokenRefresher implements CodexTokenRefresher {
  public constructor(
    private readonly options: {
      readonly tokenUrl?: string;
      readonly clientId?: string;
      readonly fetch?: typeof globalThis.fetch;
    } = {},
  ) {}

  public async refresh(
    refreshToken: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<CodexTokenRefreshResult> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: this.options.clientId ?? CODEX_DEFAULT_CLIENT_ID,
      refresh_token: refreshToken,
    });
    let response: Response;
    try {
      response = await (this.options.fetch ?? globalThis.fetch)(
        this.options.tokenUrl ?? CODEX_DEFAULT_TOKEN_URL,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
          signal: options.signal,
        },
      );
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason ?? error;
      throw new CodexCredentialError(
        "codex_refresh_network",
        "Codex credential refresh could not reach the token endpoint.",
      );
    }
    if (!response.ok) {
      throw new CodexCredentialError(
        "codex_refresh_rejected",
        `Codex credential refresh was rejected (HTTP ${response.status}).`,
        response.status === 400 || response.status === 401 || response.status === 403,
      );
    }
    const raw = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
    const accessToken = stringValue(raw?.access_token);
    if (!accessToken) {
      throw new CodexCredentialError(
        "codex_refresh_invalid",
        "Codex credential refresh returned no access token.",
      );
    }
    const expiresAt = timestampValue(raw?.expires_at)
      ?? (numberValue(raw?.expires_in) !== undefined
        ? new Date(Date.now() + numberValue(raw?.expires_in)! * 1_000).toISOString()
        : undefined);
    return {
      accessToken,
      ...(stringValue(raw?.refresh_token) ? { refreshToken: stringValue(raw?.refresh_token)! } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(stringValue(raw?.account_id) ? { accountId: stringValue(raw?.account_id)! } : {}),
    };
  }
}

export class CodexCredentialStore {
  private readonly refreshFlights = new Map<string, Promise<ResolvedCodexCredential>>();

  public constructor(
    public readonly root: string = defaultCodexCredentialRoot(),
    private readonly refresher: CodexTokenRefresher = new FetchCodexTokenRefresher(),
    private readonly now: () => number = Date.now,
  ) {}

  public async list(): Promise<ReadonlyArray<CodexCredentialStatus>> {
    const registry = await this.readRegistry();
    return Promise.all(registry.credentials.map((entry) => this.statusForEntry(entry)));
  }

  public async getStatus(id: string): Promise<CodexCredentialStatus | undefined> {
    assertCodexCredentialId(id);
    const entry = (await this.readRegistry()).credentials.find((candidate) => candidate.id === id);
    return entry ? this.statusForEntry(entry) : undefined;
  }

  public async importBytes(input: {
    readonly id: string;
    readonly bytes: Uint8Array;
    readonly safeFileName?: string;
  }): Promise<CodexCredentialStatus> {
    assertCodexCredentialId(input.id);
    const parsed = parseCodexAuthBytes(input.bytes);
    return this.mutateRegistry(async (registry) => {
      if (registry.credentials.some((entry) => entry.id === input.id)) {
        throw new CodexCredentialError(
          "codex_credential_exists",
          `Codex credential "${safeIdentifier(input.id)}" already exists.`,
        );
      }
      const filePath = join(this.root, "auth", `${input.id}.json`);
      await writeJsonAtomically(filePath, parsed.payload, {
        directoryMode: 0o700,
        fileMode: 0o600,
      });
      const entry: CodexRegistryEntry = {
        id: input.id,
        source: "managed_copy",
        safeFileName: sanitizeFileName(input.safeFileName ?? "auth.json"),
        filePath,
      };
      try {
        await this.writeRegistry({
          version: REGISTRY_VERSION,
          credentials: [...registry.credentials, entry],
        });
      } catch (error) {
        await rm(filePath, { force: true });
        throw error;
      }
      return this.statusForEntry(entry);
    });
  }

  public async replaceBytes(input: {
    readonly id: string;
    readonly bytes: Uint8Array;
    readonly safeFileName?: string;
  }): Promise<CodexCredentialStatus> {
    assertCodexCredentialId(input.id);
    const parsed = parseCodexAuthBytes(input.bytes);
    return this.mutateRegistry(async (registry) => {
      const current = registry.credentials.find((entry) => entry.id === input.id);
      if (!current) {
        throw new CodexCredentialError(
          "codex_credential_missing",
          `Codex credential "${safeIdentifier(input.id)}" is not imported.`,
          true,
        );
      }
      const filePath = join(this.root, "auth", `${input.id}.json`);
      await writeJsonAtomically(filePath, parsed.payload, {
        directoryMode: 0o700,
        fileMode: 0o600,
      });
      const replacement: CodexRegistryEntry = {
        id: current.id,
        source: "managed_copy",
        safeFileName: sanitizeFileName(input.safeFileName ?? current.safeFileName),
        filePath,
      };
      await this.writeRegistry({
        version: REGISTRY_VERSION,
        credentials: registry.credentials.map((entry) =>
          entry.id === input.id ? replacement : entry),
      });
      return this.statusForEntry(replacement);
    });
  }

  public async importExternal(input: {
    readonly id: string;
    readonly filePath: string;
    readonly mode?: "copy" | "reference";
  }): Promise<CodexCredentialStatus> {
    assertCodexCredentialId(input.id);
    const bytes = await readBoundedFile(input.filePath);
    if (input.mode !== "reference") {
      return this.importBytes({
        id: input.id,
        bytes,
        safeFileName: basename(input.filePath),
      });
    }
    parseCodexAuthBytes(bytes);
    return this.mutateRegistry(async (registry) => {
      if (registry.credentials.some((entry) => entry.id === input.id)) {
        throw new CodexCredentialError(
          "codex_credential_exists",
          `Codex credential "${safeIdentifier(input.id)}" already exists.`,
        );
      }
      const entry: CodexRegistryEntry = {
        id: input.id,
        source: "external_reference",
        safeFileName: sanitizeFileName(basename(input.filePath)),
        filePath: resolve(input.filePath),
      };
      await this.writeRegistry({
        version: REGISTRY_VERSION,
        credentials: [...registry.credentials, entry],
      });
      return this.statusForEntry(entry);
    });
  }

  public async delete(id: string): Promise<boolean> {
    assertCodexCredentialId(id);
    return this.mutateRegistry(async (registry) => {
      const entry = registry.credentials.find((candidate) => candidate.id === id);
      if (!entry) return false;
      await this.writeRegistry({
        version: REGISTRY_VERSION,
        credentials: registry.credentials.filter((candidate) => candidate.id !== id),
      });
      if (entry.source === "managed_copy") {
        await rm(entry.filePath, { force: true });
      }
      return true;
    });
  }

  public async resolve(
    id: string,
    options: CredentialResolveOptions & { readonly forceRefresh?: boolean } = {},
  ): Promise<ResolvedCodexCredential> {
    assertCodexCredentialId(id);
    const entry = (await this.readRegistry()).credentials.find((candidate) => candidate.id === id);
    if (!entry) {
      throw new CodexCredentialError(
        "codex_credential_missing",
        `Codex credential "${safeIdentifier(id)}" is not imported.`,
        true,
      );
    }
    const parsed = parseCodexAuthBytes(await readBoundedFile(entry.filePath));
    if (options.forceRefresh || needsRefresh(parsed.expiresAt, this.now())) {
      return this.refreshEntry(entry, parsed, options);
    }
    if (isExpired(parsed.expiresAt, this.now()) && !parsed.refreshToken) {
      throw new CodexCredentialError(
        "codex_credential_expired",
        "Codex credential is expired and must be re-imported.",
        true,
      );
    }
    return this.runtimeCredential(entry, parsed);
  }

  private async refreshEntry(
    entry: CodexRegistryEntry,
    parsed: ParsedCodexAuth,
    options: CredentialResolveOptions & { readonly forceRefresh?: boolean },
  ): Promise<ResolvedCodexCredential> {
    if (entry.source !== "managed_copy") {
      throw new CodexCredentialError(
        "codex_reference_refresh_blocked",
        "This read-only Codex auth reference must be re-imported before it can be refreshed.",
        true,
      );
    }
    if (!parsed.refreshToken) {
      throw new CodexCredentialError(
        "codex_refresh_token_missing",
        "Codex credential has no refresh token and must be re-imported.",
        true,
      );
    }
    const existing = this.refreshFlights.get(entry.id);
    if (existing) return awaitWithAbort(existing, options.signal);

    const flight = this.performRefresh(
      entry,
      parsed,
      Boolean(options.forceRefresh),
    )
      .finally(() => this.refreshFlights.delete(entry.id));
    this.refreshFlights.set(entry.id, flight);
    return awaitWithAbort(flight, options.signal);
  }

  private async performRefresh(
    entry: CodexRegistryEntry,
    parsed: ParsedCodexAuth,
    forceRefresh: boolean,
  ): Promise<ResolvedCodexCredential> {
    return withFileLock(`${entry.filePath}.refresh.lock`, async () => {
      const lockedLatest = parseCodexAuthBytes(await readBoundedFile(entry.filePath));
      if (
        (!forceRefresh && !needsRefresh(lockedLatest.expiresAt, this.now()))
        || (lockedLatest.accessToken !== parsed.accessToken
          && !needsRefresh(lockedLatest.expiresAt, this.now()))
      ) {
        await this.setLastRefresh(entry.id, "succeeded");
        return this.runtimeCredential(entry, lockedLatest);
      }
      return this.performLockedRefresh(entry, lockedLatest);
    }, {
      code: "codex_refresh_lock_timeout",
      message: "Codex credential refresh is already running in another InkOS process.",
    });
  }

  private async performLockedRefresh(
    entry: CodexRegistryEntry,
    parsed: ParsedCodexAuth,
  ): Promise<ResolvedCodexCredential> {
    try {
      const refreshed = await this.refresher.refresh(parsed.refreshToken!);
      const latest = parseCodexAuthBytes(await readBoundedFile(entry.filePath));
      const latestRefreshToken = latest.refreshToken;
      const currentStillMatches = latestRefreshToken === parsed.refreshToken;
      if (!currentStillMatches && !needsRefresh(latest.expiresAt, this.now())) {
        await this.setLastRefresh(entry.id, "succeeded");
        return this.runtimeCredential(entry, latest);
      }
      const tokens = objectValue(latest.payload.tokens)!;
      const updatedTokens = {
        ...tokens,
        access_token: refreshed.accessToken,
        refresh_token: refreshed.refreshToken ?? latestRefreshToken,
        ...(refreshed.accountId ? { account_id: refreshed.accountId } : {}),
        ...(refreshed.expiresAt ? { expires_at: refreshed.expiresAt } : {}),
      };
      const updatedPayload = {
        ...latest.payload,
        tokens: updatedTokens,
        last_refresh: new Date(this.now()).toISOString(),
      };
      await writeJsonAtomically(entry.filePath, updatedPayload, {
        directoryMode: 0o700,
        fileMode: 0o600,
      });
      await this.setLastRefresh(entry.id, "succeeded");
      return this.runtimeCredential(entry, parseCodexAuthPayload(updatedPayload));
    } catch (error) {
      await this.setLastRefresh(entry.id, "failed").catch(() => undefined);
      throw error;
    }
  }

  private runtimeCredential(
    entry: CodexRegistryEntry,
    parsed: ParsedCodexAuth,
  ): ResolvedCodexCredential {
    return {
      kind: "codex",
      accessToken: parsed.accessToken,
      ...(parsed.accountId ? { accountId: parsed.accountId } : {}),
      refresh: (force = false, options = {}) =>
        this.resolve(entry.id, { ...options, forceRefresh: force }),
    };
  }

  private async statusForEntry(entry: CodexRegistryEntry): Promise<CodexCredentialStatus> {
    try {
      const parsed = parseCodexAuthBytes(await readBoundedFile(entry.filePath));
      const nearExpiry = needsRefresh(parsed.expiresAt, this.now());
      return {
        id: entry.id,
        source: entry.source,
        safeFileName: entry.safeFileName,
        accountHint: maskAccountId(parsed.accountId),
        expiresAt: parsed.expiresAt ?? null,
        nearExpiry,
        needsReimport: (entry.source === "external_reference" && nearExpiry)
          || (isExpired(parsed.expiresAt, this.now()) && !parsed.refreshToken),
        lastRefresh: entry.lastRefresh ?? "never",
      };
    } catch {
      return {
        id: entry.id,
        source: entry.source,
        safeFileName: entry.safeFileName,
        accountHint: null,
        expiresAt: null,
        nearExpiry: false,
        needsReimport: true,
        lastRefresh: entry.lastRefresh ?? "never",
      };
    }
  }

  private async readRegistry(): Promise<CodexRegistry> {
    try {
      const raw = JSON.parse(await readFile(join(this.root, "registry.json"), "utf8")) as unknown;
      const record = objectValue(raw);
      if (record?.version !== REGISTRY_VERSION || !Array.isArray(record.credentials)) {
        throw new CodexCredentialError(
          "codex_registry_invalid",
          "InkOS Codex credential registry is invalid.",
        );
      }
      const credentials = record.credentials.map(parseRegistryEntry);
      return { version: REGISTRY_VERSION, credentials };
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return { version: REGISTRY_VERSION, credentials: [] };
      }
      throw error;
    }
  }

  private writeRegistry(registry: CodexRegistry): Promise<void> {
    return writeJsonAtomically(join(this.root, "registry.json"), registry, {
      directoryMode: 0o700,
      fileMode: 0o600,
    });
  }

  private async setLastRefresh(
    id: string,
    result: "succeeded" | "failed",
  ): Promise<void> {
    await this.mutateRegistry(async (registry) => {
      await this.writeRegistry({
        version: REGISTRY_VERSION,
        credentials: registry.credentials.map((entry) =>
          entry.id === id ? { ...entry, lastRefresh: result } : entry),
      });
    });
  }

  private mutateRegistry<T>(
    operation: (registry: CodexRegistry) => Promise<T>,
  ): Promise<T> {
    return withFileLock(
      join(this.root, "registry.lock"),
      async () => operation(await this.readRegistry()),
      {
        code: "codex_registry_lock_timeout",
        message: "InkOS Codex credential registry is busy in another process.",
      },
    );
  }
}

export class CodexAuthCredentialProvider implements CredentialProvider<ResolvedCodexCredential> {
  public readonly kind = "codex" as const;

  public constructor(private readonly store: CodexCredentialStore) {}

  public resolve(
    ref: CredentialRef,
    options?: CredentialResolveOptions,
  ): Promise<ResolvedCodexCredential> {
    if (ref.kind !== this.kind) {
      throw new CodexCredentialError(
        "codex_credential_kind",
        `Credential "${safeIdentifier(ref.id)}" is not a Codex credential.`,
      );
    }
    return this.store.resolve(ref.id, options);
  }
}

export function defaultCodexCredentialRoot(
  env: Readonly<Record<string, string | undefined>> = process.env,
  homeDir = homedir(),
): string {
  const configured = env.INKOS_CREDENTIAL_HOME?.trim();
  return configured
    ? join(resolve(configured), "codex")
    : join(homeDir, ".inkos", "credentials", "codex");
}

export async function discoverCodexAuthCandidates(
  input: CodexDiscoveryInput,
): Promise<ReadonlyArray<CodexDiscoveryCandidate>> {
  const deduplicated = codexDiscoveryPaths(input);
  const result: CodexDiscoveryCandidate[] = [];
  for (const candidate of deduplicated.values()) {
    result.push(await inspectDiscoveryCandidate(candidate.path, candidate.sources));
  }
  return result;
}

export async function importDiscoveredCodexAuth(
  store: CodexCredentialStore,
  input: CodexDiscoveryInput & {
    readonly candidateId: string;
    readonly credentialId: string;
    readonly mode?: "copy" | "reference";
  },
): Promise<CodexCredentialStatus> {
  const candidate = [...codexDiscoveryPaths(input).values()]
    .find((entry) => codexDiscoveryCandidateId(entry.path) === input.candidateId);
  if (!candidate) {
    throw new CodexCredentialError(
      "codex_candidate_not_found",
      "The selected Codex auth candidate is no longer available.",
      true,
    );
  }
  return store.importExternal({
    id: input.credentialId,
    filePath: candidate.path,
    mode: input.mode,
  });
}

function codexDiscoveryPaths(
  input: CodexDiscoveryInput,
): Map<string, {
  readonly path: string;
  readonly sources: CodexDiscoverySource[];
}> {
  const env = input.env ?? process.env;
  const homeDir = input.homeDir ?? homedir();
  const sources: Array<{ readonly source: CodexDiscoverySource; readonly path: string }> = [
    ...(env.CODEX_AUTH_FILE?.trim()
      ? [{ source: "CODEX_AUTH_FILE" as const, path: env.CODEX_AUTH_FILE.trim() }]
      : []),
    ...(env.CODEX_HOME?.trim()
      ? [{ source: "CODEX_HOME" as const, path: join(env.CODEX_HOME.trim(), "auth.json") }]
      : []),
    { source: "project", path: join(input.projectRoot, ".codex", "auth.json") },
    { source: "user_home", path: join(homeDir, ".codex", "auth.json") },
  ];
  const deduplicated = new Map<string, {
    readonly path: string;
    readonly sources: CodexDiscoverySource[];
  }>();
  for (const candidate of sources) {
    const canonical = canonicalPath(candidate.path);
    const existing = deduplicated.get(canonical);
    if (existing) {
      existing.sources.push(candidate.source);
    } else {
      deduplicated.set(canonical, {
        path: resolve(candidate.path),
        sources: [candidate.source],
      });
    }
  }
  return deduplicated;
}

export function codexDiscoveryCandidateId(path: string): string {
  return createHash("sha256").update(canonicalPath(path)).digest("hex").slice(0, 24);
}

export function parseCodexAuthBytes(bytes: Uint8Array): ParsedCodexAuth {
  if (bytes.byteLength === 0) {
    throw new CodexCredentialError("codex_auth_empty", "Codex auth JSON is empty.", true);
  }
  if (bytes.byteLength > CODEX_AUTH_MAX_BYTES) {
    throw new CodexCredentialError(
      "codex_auth_too_large",
      "Codex auth JSON exceeds the 1 MiB import limit.",
      true,
    );
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    .replace(/^\uFEFF/u, "");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CodexCredentialError("codex_auth_invalid_json", "Codex auth file is not valid JSON.", true);
  }
  return parseCodexAuthPayload(raw);
}

export function parseCodexAuthPayload(raw: unknown): ParsedCodexAuth {
  const payload = objectValue(raw);
  const tokens = objectValue(payload?.tokens);
  if (!payload || !tokens) {
    throw new CodexCredentialError(
      "codex_auth_invalid_shape",
      "Codex auth JSON must contain a tokens object.",
      true,
    );
  }
  const accessToken = stringValue(tokens.access_token);
  if (!accessToken) {
    throw new CodexCredentialError(
      "codex_auth_access_missing",
      "Codex auth JSON is missing tokens.access_token.",
      true,
    );
  }
  const accessClaims = jwtClaims(accessToken);
  const idClaims = jwtClaims(stringValue(tokens.id_token));
  const accountId = firstString(
    tokens.account_id,
    tokens.accountId,
    accessClaims?.account_id,
    accessClaims?.accountId,
    accessClaims?.["https://api.openai.com/auth/account_id"],
    objectValue(accessClaims?.["https://api.openai.com/auth"])?.chatgpt_account_id,
    idClaims?.account_id,
    idClaims?.accountId,
    idClaims?.["https://api.openai.com/auth/account_id"],
    objectValue(idClaims?.["https://api.openai.com/auth"])?.chatgpt_account_id,
  );
  const expiresAt = timestampValue(tokens.expires_at)
    ?? timestampValue(tokens.expiresAt)
    ?? timestampValue(accessClaims?.exp)
    ?? timestampValue(idClaims?.exp);
  return {
    accessToken,
    ...(stringValue(tokens.refresh_token) ? { refreshToken: stringValue(tokens.refresh_token)! } : {}),
    ...(accountId ? { accountId } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    payload,
  };
}

export function maskAccountId(accountId: string | undefined): string | null {
  if (!accountId) return null;
  if (accountId.length <= 8) return "••••••••";
  return `${accountId.slice(0, 4)}••••${accountId.slice(-4)}`;
}

async function inspectDiscoveryCandidate(
  path: string,
  sources: ReadonlyArray<CodexDiscoverySource>,
): Promise<CodexDiscoveryCandidate> {
  const base = {
    candidateId: codexDiscoveryCandidateId(path),
    sources,
    safeFileName: sanitizeFileName(basename(path) || "auth.json"),
  };
  try {
    const parsed = parseCodexAuthBytes(await readBoundedFile(path));
    return {
      ...base,
      state: "available",
      accountHint: maskAccountId(parsed.accountId),
      expiresAt: parsed.expiresAt ?? null,
      nearExpiry: needsRefresh(parsed.expiresAt, Date.now()),
      message: "Existing Codex CLI login credential is available to import.",
    };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return {
        ...base,
        state: "missing",
        accountHint: null,
        expiresAt: null,
        nearExpiry: false,
        message: "Codex auth file was not found.",
      };
    }
    if (isNodeError(error, "EACCES") || isNodeError(error, "EPERM")) {
      return {
        ...base,
        state: "permission_denied",
        accountHint: null,
        expiresAt: null,
        nearExpiry: false,
        message: "Codex auth file cannot be read because permission was denied.",
      };
    }
    return {
      ...base,
      state: error instanceof CodexCredentialError ? "invalid" : "unreadable",
      accountHint: null,
      expiresAt: null,
      nearExpiry: false,
      message: error instanceof CodexCredentialError
        ? error.message
        : "Codex auth file could not be read.",
    };
  }
}

async function readBoundedFile(path: string): Promise<Uint8Array> {
  const metadata = await stat(path);
  if (metadata.size > CODEX_AUTH_MAX_BYTES) {
    throw new CodexCredentialError(
      "codex_auth_too_large",
      "Codex auth JSON exceeds the 1 MiB import limit.",
      true,
    );
  }
  return readFile(path);
}

function parseRegistryEntry(raw: unknown): CodexRegistryEntry {
  const entry = objectValue(raw);
  const id = stringValue(entry?.id);
  const source = entry?.source;
  const safeFileName = stringValue(entry?.safeFileName);
  const filePath = stringValue(entry?.filePath);
  if (
    !id
    || !STABLE_CREDENTIAL_ID.test(id)
    || (source !== "managed_copy" && source !== "external_reference")
    || !safeFileName
    || !filePath
  ) {
    throw new CodexCredentialError(
      "codex_registry_invalid",
      "InkOS Codex credential registry contains an invalid entry.",
    );
  }
  const lastRefresh = entry?.lastRefresh;
  return {
    id,
    source,
    safeFileName: sanitizeFileName(safeFileName),
    filePath,
    ...(lastRefresh === "succeeded" || lastRefresh === "failed" ? { lastRefresh } : {}),
  };
}

function assertCodexCredentialId(id: string): void {
  if (!STABLE_CREDENTIAL_ID.test(id)) {
    throw new CodexCredentialError(
      "codex_credential_id_invalid",
      "Codex credential ID must be a stable lowercase identifier.",
    );
  }
}

function needsRefresh(expiresAt: string | undefined, now: number): boolean {
  if (!expiresAt) return false;
  return Date.parse(expiresAt) - now <= CODEX_REFRESH_SKEW_MS;
}

function isExpired(expiresAt: string | undefined, now: number): boolean {
  return Boolean(expiresAt && Date.parse(expiresAt) <= now);
}

function jwtClaims(token: string | undefined): Record<string, unknown> | undefined {
  if (!token) return undefined;
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) return undefined;
  try {
    return objectValue(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")));
  } catch {
    return undefined;
  }
}

function timestampValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      return new Date(normalizeEpoch(numeric)).toISOString();
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(normalizeEpoch(value)).toISOString();
  }
  return undefined;
}

function normalizeEpoch(value: number): number {
  return value < 10_000_000_000 ? value * 1_000 : value;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = stringValue(value);
    if (text) return text;
  }
  return undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function sanitizeFileName(value: string): string {
  const safe = basename(value).replace(/[\r\n\u0000-\u001f]/gu, "").slice(0, 128);
  return safe || "auth.json";
}

function safeIdentifier(value: string): string {
  return value.replace(/[^a-z0-9._:-]/giu, "?").slice(0, 128);
}

function isNodeError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error
    && (error as { readonly code?: unknown }).code === code);
}

async function awaitWithAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const onAbort = () => rejectPromise(signal.reason ?? new Error("Operation aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        rejectPromise(error);
      },
    );
  });
}

async function withFileLock<T>(
  path: string,
  operation: () => Promise<T>,
  timeout: {
    readonly code: string;
    readonly message: string;
  },
): Promise<T> {
  const deadline = Date.now() + 30_000;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  while (true) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        return await operation();
      } finally {
        await handle.close();
        await rm(path, { force: true });
      }
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      const lockStat = await stat(path).catch(() => undefined);
      if (lockStat && Date.now() - lockStat.mtimeMs > 60_000) {
        await rm(path, { force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new CodexCredentialError(
          timeout.code,
          timeout.message,
        );
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
  }
}
