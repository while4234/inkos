import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify as verifySignature,
  type JsonWebKey,
} from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { writeJsonAtomically } from "../atomic-json.js";
import type { CredentialProvider, CredentialResolveOptions } from "./index.js";
import type { CredentialRef } from "../model-routing.js";

const REGISTRY_VERSION = 1 as const;
const STABLE_ID = /^[a-z0-9][a-z0-9._:-]*$/u;
const MAX_OAUTH_RESPONSE_BYTES = 1 << 20;
export const GROK_REFRESH_SKEW_MS = 120_000;
export const GROK_LOGIN_SESSION_TTL_MS = 10 * 60_000;

export interface GrokOAuthConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scope?: string;
}

export interface GrokOAuthConfigurationStatus {
  readonly configured: boolean;
  readonly missing: ReadonlyArray<"issuer" | "clientId" | "redirectUri">;
  readonly issuer: string | null;
  readonly redirectUri: string | null;
}

export interface GrokOidcDiscovery {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
}

export interface GrokOAuthTokenSet {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly idToken?: string;
  readonly tokenType: string;
  readonly scope?: string;
  readonly expiresAt: string;
}

export interface GrokAccountIdentity {
  readonly subject: string;
  readonly email?: string;
  readonly displayName?: string;
}

export interface GrokCredentialStatus {
  readonly id: string;
  readonly issuer: string;
  readonly subject: string;
  readonly accountHint: string | null;
  readonly expiresAt: string;
  readonly nearExpiry: boolean;
  readonly active: boolean;
  readonly authRequired: boolean;
  readonly lastRefresh: "never" | "succeeded" | "failed";
}

export interface ResolvedGrokOAuthCredential {
  readonly kind: "grok_oauth";
  readonly accessToken: string;
  readonly expiresAt: string;
  readonly refresh: (
    force?: boolean,
    options?: CredentialResolveOptions,
  ) => Promise<ResolvedGrokOAuthCredential>;
  readonly markAuthRequired: () => Promise<void>;
}

interface GrokRegistryEntry {
  readonly id: string;
  readonly issuer: string;
  readonly subject: string;
  readonly email?: string;
  readonly displayName?: string;
  readonly expiresAt: string;
  readonly scope?: string;
  readonly lastRefresh?: "succeeded" | "failed";
  readonly authRequired?: boolean;
}

interface GrokRegistry {
  readonly version: typeof REGISTRY_VERSION;
  readonly activeCredentialId?: string;
  readonly credentials: ReadonlyArray<GrokRegistryEntry>;
}

interface StoredGrokTokens {
  readonly version: 1;
  /** Non-secret write generation used to join cross-process refreshes safely. */
  readonly revision?: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly subject: string;
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly idToken?: string;
  readonly tokenType: string;
  readonly scope?: string;
  readonly expiresAt: string;
}

export interface GrokOAuthLoginStart {
  readonly sessionId: string;
  readonly authorizationUrl: string;
  readonly expiresAt: string;
  readonly callback: {
    readonly scheme: "http";
    readonly host: "127.0.0.1";
    readonly port: number;
    readonly path: string;
  };
}

interface GrokLoginSession {
  readonly sessionId: string;
  readonly credentialId: string;
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
  readonly discovery: GrokOidcDiscovery;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export class GrokOAuthError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly authRequired = false,
  ) {
    super(message);
    this.name = "GrokOAuthError";
  }
}

export function grokOAuthConfigurationStatus(
  input: Partial<GrokOAuthConfig>,
): GrokOAuthConfigurationStatus {
  const missing: Array<"issuer" | "clientId" | "redirectUri"> = [];
  if (!input.issuer?.trim()) missing.push("issuer");
  if (!input.clientId?.trim()) missing.push("clientId");
  if (!input.redirectUri?.trim()) missing.push("redirectUri");
  return {
    configured: missing.length === 0,
    missing,
    issuer: input.issuer?.trim() || null,
    redirectUri: input.redirectUri?.trim() || null,
  };
}

export function grokOAuthConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Partial<GrokOAuthConfig> {
  return {
    ...(env.INKOS_GROK_OAUTH_ISSUER?.trim()
      ? { issuer: env.INKOS_GROK_OAUTH_ISSUER.trim() }
      : {}),
    ...(env.INKOS_GROK_OAUTH_CLIENT_ID?.trim()
      ? { clientId: env.INKOS_GROK_OAUTH_CLIENT_ID.trim() }
      : {}),
    ...(env.INKOS_GROK_OAUTH_REDIRECT_URI?.trim()
      ? { redirectUri: env.INKOS_GROK_OAUTH_REDIRECT_URI.trim() }
      : {}),
    ...(env.INKOS_GROK_OAUTH_SCOPE?.trim()
      ? { scope: env.INKOS_GROK_OAUTH_SCOPE.trim() }
      : {}),
  };
}

export interface GrokOAuthClientOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly timeoutMs?: number;
  /** Test-only escape hatch for an explicitly injected local mock issuer. */
  readonly allowInsecureHttpForTests?: boolean;
  readonly verifyIdToken?: (
    token: string,
    expected: {
      readonly discovery: GrokOidcDiscovery;
      readonly clientId: string;
      readonly nonce: string;
      readonly now: number;
      readonly signal?: AbortSignal;
    },
  ) => Promise<GrokAccountIdentity>;
}

export class GrokOAuthClient {
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly random: (size: number) => Uint8Array;
  private readonly timeoutMs: number;

  public constructor(
    public readonly config: GrokOAuthConfig,
    private readonly options: GrokOAuthClientOptions = {},
  ) {
    assertGrokOAuthConfig(config, Boolean(options.allowInsecureHttpForTests));
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.random = options.randomBytes ?? randomBytes;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  public async discover(signal?: AbortSignal): Promise<GrokOidcDiscovery> {
    const issuer = canonicalIssuer(this.config.issuer);
    const raw = await this.fetchJson(
      `${issuer}/.well-known/openid-configuration`,
      { signal },
    );
    const discovery = {
      issuer: requiredString(raw.issuer, "issuer"),
      authorizationEndpoint: requiredString(
        raw.authorization_endpoint,
        "authorization_endpoint",
      ),
      tokenEndpoint: requiredString(raw.token_endpoint, "token_endpoint"),
      jwksUri: requiredString(raw.jwks_uri, "jwks_uri"),
    };
    if (canonicalIssuer(discovery.issuer) !== issuer) {
      throw new GrokOAuthError(
        "grok_discovery_issuer_mismatch",
        "Grok OIDC discovery returned an unexpected issuer.",
      );
    }
    for (const [name, value] of [
      ["authorization_endpoint", discovery.authorizationEndpoint],
      ["token_endpoint", discovery.tokenEndpoint],
      ["jwks_uri", discovery.jwksUri],
    ] as const) {
      assertTrustedEndpoint(
        value,
        issuer,
        name,
        Boolean(this.options.allowInsecureHttpForTests),
      );
    }
    return discovery;
  }

  public createAuthorizationRequest(
    discovery: GrokOidcDiscovery,
  ): {
    readonly state: string;
    readonly nonce: string;
    readonly verifier: string;
    readonly authorizationUrl: string;
  } {
    const verifier = base64Url(this.random(48));
    const state = base64Url(this.random(32));
    const nonce = base64Url(this.random(32));
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const url = new URL(discovery.authorizationEndpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: this.config.scope ?? "openid profile email offline_access",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      nonce,
    }).toString();
    return { state, nonce, verifier, authorizationUrl: url.toString() };
  }

  public async exchangeCode(
    input: {
      readonly discovery: GrokOidcDiscovery;
      readonly code: string;
      readonly verifier: string;
      readonly nonce: string;
      readonly signal?: AbortSignal;
    },
  ): Promise<{ readonly tokens: GrokOAuthTokenSet; readonly identity: GrokAccountIdentity }> {
    const raw = await this.postToken(
      input.discovery.tokenEndpoint,
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: this.config.clientId,
        redirect_uri: this.config.redirectUri,
        code: input.code,
        code_verifier: input.verifier,
      }),
      input.signal,
    );
    const tokens = parseTokenSet(raw, this.now());
    if (!tokens.idToken) {
      throw new GrokOAuthError(
        "grok_id_token_missing",
        "Grok OIDC token response did not include an ID token.",
        true,
      );
    }
    const verify = this.options.verifyIdToken
      ?? ((token, expected) => this.verifyIdTokenWithJwks(token, expected));
    const identity = await verify(tokens.idToken, {
      discovery: input.discovery,
      clientId: this.config.clientId,
      nonce: input.nonce,
      now: this.now(),
      signal: input.signal,
    });
    return { tokens, identity };
  }

  public async refresh(
    discovery: GrokOidcDiscovery,
    refreshToken: string,
    signal?: AbortSignal,
  ): Promise<Partial<GrokOAuthTokenSet> & Pick<GrokOAuthTokenSet, "accessToken" | "expiresAt">> {
    const raw = await this.postToken(
      discovery.tokenEndpoint,
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: this.config.clientId,
        refresh_token: refreshToken,
      }),
      signal,
    );
    return parseRefreshTokenSet(raw, this.now());
  }

  private async verifyIdTokenWithJwks(
    token: string,
    expected: {
      readonly discovery: GrokOidcDiscovery;
      readonly clientId: string;
      readonly nonce: string;
      readonly now: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<GrokAccountIdentity> {
    const parsed = parseJwt(token);
    if (parsed.header.alg !== "RS256" || typeof parsed.header.kid !== "string") {
      throw new GrokOAuthError(
        "grok_id_token_algorithm",
        "Grok ID token uses an unsupported signing algorithm.",
        true,
      );
    }
    const jwks = await this.fetchJson(expected.discovery.jwksUri, {
      signal: expected.signal,
    });
    const keys = Array.isArray(jwks.keys) ? jwks.keys : [];
    const jwk = keys
      .map(objectValue)
      .find((key): key is Record<string, unknown> =>
        Boolean(
          key
          && key.kid === parsed.header.kid
          && key.kty === "RSA"
          && (key.use === undefined || key.use === "sig")
          && (key.alg === undefined || key.alg === "RS256"),
        ));
    if (!jwk) {
      throw new GrokOAuthError(
        "grok_id_token_key_missing",
        "Grok ID token signing key was not found.",
        true,
      );
    }
    let valid = false;
    try {
      valid = verifySignature(
        "RSA-SHA256",
        Buffer.from(parsed.signingInput),
        createPublicKey({ key: jwk as JsonWebKey, format: "jwk" }),
        Buffer.from(parsed.signature, "base64url"),
      );
    } catch {
      valid = false;
    }
    if (!valid) {
      throw new GrokOAuthError(
        "grok_id_token_signature",
        "Grok ID token signature validation failed.",
        true,
      );
    }
    return validateIdTokenClaims(parsed.claims, expected);
  }

  private async postToken(
    endpoint: string,
    body: URLSearchParams,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchWithTimeout(endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      throw new GrokOAuthError(
        "grok_token_network",
        "Grok OAuth token endpoint could not be reached.",
      );
    }
    if (!response.ok) {
      throw new GrokOAuthError(
        "grok_token_rejected",
        `Grok OAuth token endpoint rejected the request (HTTP ${response.status}).`,
        response.status === 400 || response.status === 401 || response.status === 403,
      );
    }
    return readBoundedJson(response);
  }

  private async fetchJson(
    url: string,
    options: { readonly signal?: AbortSignal },
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchWithTimeout(url, {
        redirect: "error",
        headers: { Accept: "application/json" },
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason ?? error;
      throw new GrokOAuthError(
        "grok_discovery_network",
        "Grok OIDC metadata could not be reached.",
      );
    }
    if (!response.ok) {
      throw new GrokOAuthError(
        "grok_discovery_rejected",
        `Grok OIDC metadata request failed (HTTP ${response.status}).`,
      );
    }
    return readBoundedJson(response);
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("Grok OAuth request timed out.")),
      this.timeoutMs,
    );
    const external = init.signal;
    const onAbort = () => controller.abort(external?.reason);
    external?.addEventListener("abort", onAbort, { once: true });
    try {
      return await this.fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
      external?.removeEventListener("abort", onAbort);
    }
  }
}

export class GrokOAuthLoginManager {
  private readonly sessions = new Map<string, GrokLoginSession>();
  private readonly sessionByState = new Map<string, string>();
  private readonly outcomes = new Map<string, {
    readonly status: "completed" | "failed";
    readonly expiresAt: number;
  }>();
  private readonly now: () => number;

  public constructor(
    private readonly client: GrokOAuthClient,
    private readonly store: GrokCredentialStore,
    options: { readonly now?: () => number; readonly sessionTtlMs?: number } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.sessionTtlMs = options.sessionTtlMs ?? GROK_LOGIN_SESSION_TTL_MS;
  }

  private readonly sessionTtlMs: number;

  public async begin(
    credentialId: string,
    signal?: AbortSignal,
  ): Promise<GrokOAuthLoginStart> {
    assertCredentialId(credentialId);
    this.purgeExpired();
    const discovery = await this.client.discover(signal);
    const request = this.client.createAuthorizationRequest(discovery);
    const sessionId = randomUUID();
    const createdAt = this.now();
    const session: GrokLoginSession = {
      sessionId,
      credentialId,
      state: request.state,
      nonce: request.nonce,
      verifier: request.verifier,
      discovery,
      createdAt,
      expiresAt: createdAt + this.sessionTtlMs,
    };
    this.sessions.set(sessionId, session);
    this.sessionByState.set(session.state, sessionId);
    return {
      sessionId,
      authorizationUrl: request.authorizationUrl,
      expiresAt: new Date(session.expiresAt).toISOString(),
      callback: callbackDescriptor(this.client.config.redirectUri),
    };
  }

  public status(
    sessionId: string,
  ): "pending" | "missing" | "expired" | "completed" | "failed" {
    const outcome = this.outcomes.get(sessionId);
    if (outcome) {
      this.outcomes.delete(sessionId);
      return outcome.expiresAt <= this.now() ? "missing" : outcome.status;
    }
    const session = this.sessions.get(sessionId);
    if (!session) return "missing";
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(sessionId);
      this.sessionByState.delete(session.state);
      return "expired";
    }
    return "pending";
  }

  public cancel(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (session) this.sessionByState.delete(session.state);
    this.outcomes.delete(sessionId);
    return this.sessions.delete(sessionId);
  }

  public async complete(
    sessionId: string,
    callbackOrCode: string,
    signal?: AbortSignal,
  ): Promise<GrokCredentialStatus> {
    const session = this.consumeSession(sessionId);
    try {
      const callback = parseCallbackInput(
        callbackOrCode,
        this.client.config.redirectUri,
        session.state,
      );
      if (callback.error) {
        throw new GrokOAuthError(
          "grok_authorization_denied",
          `Grok authorization was not completed (${safeOAuthError(callback.error)}).`,
          true,
        );
      }
      const result = await this.client.exchangeCode({
        discovery: session.discovery,
        code: callback.code,
        verifier: session.verifier,
        nonce: session.nonce,
        signal,
      });
      const status = await this.store.saveLogin({
        id: session.credentialId,
        config: this.client.config,
        tokens: result.tokens,
        identity: result.identity,
      });
      this.recordOutcome(sessionId, "completed");
      return status;
    } catch (error) {
      this.recordOutcome(sessionId, "failed");
      throw error;
    }
  }

  public async completeCallback(
    callbackUrl: string,
    signal?: AbortSignal,
  ): Promise<{
    readonly sessionId: string;
    readonly credential: GrokCredentialStatus;
  }> {
    let url: URL;
    try {
      url = new URL(callbackUrl);
    } catch {
      throw new GrokOAuthError(
        "grok_callback_invalid",
        "Grok callback URL is invalid.",
      );
    }
    const state = url.searchParams.get("state");
    if (!state) {
      throw new GrokOAuthError(
        "grok_callback_state_mismatch",
        "Grok callback state validation failed.",
      );
    }
    const sessionId = this.sessionByState.get(state);
    if (!sessionId) {
      throw new GrokOAuthError(
        "grok_login_session_missing",
        "Grok login session is unavailable; start the connection again.",
      );
    }
    return {
      sessionId,
      credential: await this.complete(sessionId, callbackUrl, signal),
    };
  }

  private consumeSession(sessionId: string): GrokLoginSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new GrokOAuthError(
        "grok_login_session_missing",
        "Grok login session is unavailable; start the connection again.",
      );
    }
    this.sessions.delete(sessionId);
    this.sessionByState.delete(session.state);
    if (session.expiresAt <= this.now()) {
      throw new GrokOAuthError(
        "grok_login_session_expired",
        "Grok login session expired; start the connection again.",
      );
    }
    return session;
  }

  private purgeExpired(): void {
    const now = this.now();
    for (const [sessionId, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.sessions.delete(sessionId);
        this.sessionByState.delete(session.state);
      }
    }
    for (const [sessionId, outcome] of this.outcomes) {
      if (outcome.expiresAt <= now) this.outcomes.delete(sessionId);
    }
  }

  private recordOutcome(sessionId: string, status: "completed" | "failed"): void {
    this.outcomes.set(sessionId, {
      status,
      expiresAt: this.now() + this.sessionTtlMs,
    });
  }
}

const refreshFlights = new Map<string, Promise<ResolvedGrokOAuthCredential>>();

export class GrokCredentialStore {
  public constructor(
    public readonly root = defaultGrokCredentialRoot(),
    private readonly createClient: (config: GrokOAuthConfig) => GrokOAuthClient =
      (config) => new GrokOAuthClient(config),
    private readonly now: () => number = Date.now,
  ) {}

  public async list(): Promise<ReadonlyArray<GrokCredentialStatus>> {
    const registry = await this.readRegistry();
    return registry.credentials.map((entry) =>
      this.statusForEntry(entry, registry.activeCredentialId));
  }

  public async getStatus(id: string): Promise<GrokCredentialStatus | undefined> {
    assertCredentialId(id);
    const registry = await this.readRegistry();
    const entry = registry.credentials.find((candidate) => candidate.id === id);
    return entry
      ? this.statusForEntry(entry, registry.activeCredentialId)
      : undefined;
  }

  public async saveLogin(input: {
    readonly id: string;
    readonly config: GrokOAuthConfig;
    readonly tokens: GrokOAuthTokenSet;
    readonly identity: GrokAccountIdentity;
  }): Promise<GrokCredentialStatus> {
    assertCredentialId(input.id);
    const tokenFile = this.tokenPath(input.id);
    return this.mutateRegistry(async (registry) => {
      await writeJsonAtomically(tokenFile, {
        version: 1,
        revision: randomUUID(),
        issuer: canonicalIssuer(input.config.issuer),
        clientId: input.config.clientId,
        redirectUri: input.config.redirectUri,
        subject: input.identity.subject,
        accessToken: input.tokens.accessToken,
        ...(input.tokens.refreshToken ? { refreshToken: input.tokens.refreshToken } : {}),
        ...(input.tokens.idToken ? { idToken: input.tokens.idToken } : {}),
        tokenType: input.tokens.tokenType,
        ...(input.tokens.scope ? { scope: input.tokens.scope } : {}),
        expiresAt: input.tokens.expiresAt,
      } satisfies StoredGrokTokens, {
        directoryMode: 0o700,
        fileMode: 0o600,
      });
      const entry: GrokRegistryEntry = {
        id: input.id,
        issuer: canonicalIssuer(input.config.issuer),
        subject: input.identity.subject,
        ...(input.identity.email ? { email: input.identity.email } : {}),
        ...(input.identity.displayName ? { displayName: input.identity.displayName } : {}),
        expiresAt: input.tokens.expiresAt,
        ...(input.tokens.scope ? { scope: input.tokens.scope } : {}),
        lastRefresh: "succeeded",
        authRequired: false,
      };
      const next: GrokRegistry = {
        version: REGISTRY_VERSION,
        activeCredentialId: input.id,
        credentials: [
          ...registry.credentials.filter((candidate) => candidate.id !== input.id),
          entry,
        ],
      };
      await this.writeRegistry(next);
      return this.statusForEntry(entry, input.id);
    });
  }

  public async setActive(id: string): Promise<GrokCredentialStatus> {
    assertCredentialId(id);
    return this.mutateRegistry(async (registry) => {
      const entry = registry.credentials.find((candidate) => candidate.id === id);
      if (!entry) throw credentialMissing(id);
      await this.writeRegistry({ ...registry, activeCredentialId: id });
      return this.statusForEntry(entry, id);
    });
  }

  public async delete(id: string): Promise<void> {
    assertCredentialId(id);
    await this.mutateRegistry(async (registry) => {
      const nextCredentials = registry.credentials.filter((entry) => entry.id !== id);
      if (nextCredentials.length === registry.credentials.length) return;
      const activeCredentialId = registry.activeCredentialId === id
        ? nextCredentials[0]?.id
        : registry.activeCredentialId;
      await this.writeRegistry({
        version: REGISTRY_VERSION,
        ...(activeCredentialId ? { activeCredentialId } : {}),
        credentials: nextCredentials,
      });
      await rm(this.tokenPath(id), { force: true });
    });
  }

  public async resolve(
    id: string,
    options: { readonly forceRefresh?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<ResolvedGrokOAuthCredential> {
    assertCredentialId(id);
    const registry = await this.readRegistry();
    const entry = registry.credentials.find((candidate) => candidate.id === id);
    if (!entry) throw credentialMissing(id);
    const tokens = await this.readTokens(id);
    const shouldRefresh = options.forceRefresh
      || entry.authRequired
      || Date.parse(tokens.expiresAt) - this.now() <= GROK_REFRESH_SKEW_MS;
    if (!shouldRefresh) return this.resolved(id, tokens);
    const key = `${canonicalPath(this.root)}\0${id}`;
    const existing = refreshFlights.get(key);
    if (existing) return awaitWithAbort(existing, options.signal);
    const flight = this.refreshUnderLock(id, tokens, Boolean(options.forceRefresh))
      .finally(() => refreshFlights.delete(key));
    refreshFlights.set(key, flight);
    return awaitWithAbort(flight, options.signal);
  }

  private async refreshUnderLock(
    id: string,
    beforeLock: StoredGrokTokens,
    force: boolean,
    signal?: AbortSignal,
  ): Promise<ResolvedGrokOAuthCredential> {
    return withFileLock(
      join(this.root, "locks", `${id}.refresh.lock`),
      async () => {
        const current = await this.readTokens(id);
        if (wasRefreshedAfter(current, beforeLock)) {
          return this.resolved(id, current);
        }
        if (!force && Date.parse(current.expiresAt) - this.now() > GROK_REFRESH_SKEW_MS) {
          return this.resolved(id, current);
        }
        if (!current.refreshToken) {
          await this.markRefresh(id, "failed", true);
          throw new GrokOAuthError(
            "grok_refresh_token_missing",
            "Grok credential requires reconnection.",
            true,
          );
        }
        try {
          const client = this.createClient({
            issuer: current.issuer,
            clientId: current.clientId,
            redirectUri: current.redirectUri,
          });
          const discovery = await client.discover(signal);
          const refreshed = await client.refresh(discovery, current.refreshToken, signal);
          const next: StoredGrokTokens = {
            ...current,
            revision: randomUUID(),
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken ?? current.refreshToken,
            idToken: refreshed.idToken ?? current.idToken,
            tokenType: refreshed.tokenType ?? current.tokenType,
            scope: refreshed.scope ?? current.scope,
            expiresAt: refreshed.expiresAt,
          };
          await writeJsonAtomically(this.tokenPath(id), next, {
            directoryMode: 0o700,
            fileMode: 0o600,
          });
          await this.markRefresh(id, "succeeded", false, next.expiresAt);
          return this.resolved(id, next);
        } catch (error) {
          await this.markRefresh(id, "failed", isAuthRequired(error));
          throw error;
        }
      },
      "grok_refresh_lock_timeout",
      "Timed out waiting for the Grok credential refresh lock.",
    );
  }

  private resolved(
    id: string,
    tokens: StoredGrokTokens,
  ): ResolvedGrokOAuthCredential {
    return {
      kind: "grok_oauth",
      accessToken: tokens.accessToken,
      expiresAt: tokens.expiresAt,
      refresh: (force = false, options = {}) =>
        this.resolve(id, { forceRefresh: force, signal: options.signal }),
      markAuthRequired: () => this.markRefresh(id, "failed", true),
    };
  }

  private async markRefresh(
    id: string,
    lastRefresh: "succeeded" | "failed",
    authRequired: boolean,
    expiresAt?: string,
  ): Promise<void> {
    await this.mutateRegistry(async (registry) => {
      await this.writeRegistry({
        ...registry,
        credentials: registry.credentials.map((entry) => entry.id === id
          ? {
              ...entry,
              ...(expiresAt ? { expiresAt } : {}),
              lastRefresh,
              authRequired,
            }
          : entry),
      });
    });
  }

  private async readTokens(id: string): Promise<StoredGrokTokens> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.tokenPath(id), "utf8"));
    } catch {
      throw new GrokOAuthError(
        "grok_credential_unreadable",
        `Grok credential "${safeIdentifier(id)}" is unavailable.`,
        true,
      );
    }
    return parseStoredTokens(raw);
  }

  private statusForEntry(
    entry: GrokRegistryEntry,
    activeCredentialId?: string,
  ): GrokCredentialStatus {
    return {
      id: entry.id,
      issuer: entry.issuer,
      subject: entry.subject,
      accountHint: maskAccount(entry.email ?? entry.displayName ?? entry.subject),
      expiresAt: entry.expiresAt,
      nearExpiry: Date.parse(entry.expiresAt) - this.now() <= GROK_REFRESH_SKEW_MS,
      active: entry.id === activeCredentialId,
      authRequired: Boolean(entry.authRequired),
      lastRefresh: entry.lastRefresh ?? "never",
    };
  }

  private tokenPath(id: string): string {
    return join(this.root, "accounts", `${id}.json`);
  }

  private async readRegistry(): Promise<GrokRegistry> {
    try {
      return parseRegistry(JSON.parse(await readFile(join(this.root, "registry.json"), "utf8")));
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return { version: REGISTRY_VERSION, credentials: [] };
      }
      if (error instanceof GrokOAuthError) throw error;
      throw new GrokOAuthError(
        "grok_registry_invalid",
        "InkOS Grok credential registry is invalid.",
      );
    }
  }

  private writeRegistry(registry: GrokRegistry): Promise<void> {
    return writeJsonAtomically(join(this.root, "registry.json"), registry, {
      directoryMode: 0o700,
      fileMode: 0o600,
    });
  }

  private mutateRegistry<T>(operation: (registry: GrokRegistry) => Promise<T>): Promise<T> {
    return withFileLock(
      join(this.root, "locks", "registry.lock"),
      async () => operation(await this.readRegistry()),
      "grok_registry_lock_timeout",
      "Timed out waiting for the Grok credential registry lock.",
    );
  }
}

export class GrokOAuthCredentialProvider
implements CredentialProvider<ResolvedGrokOAuthCredential> {
  public readonly kind = "grok_oauth" as const;

  public constructor(private readonly store: GrokCredentialStore) {}

  public resolve(
    ref: CredentialRef,
    options?: CredentialResolveOptions,
  ): Promise<ResolvedGrokOAuthCredential> {
    if (ref.kind !== this.kind) {
      throw new GrokOAuthError(
        "grok_credential_kind",
        `Credential "${safeIdentifier(ref.id)}" is not a Grok OAuth credential.`,
      );
    }
    return this.store.resolve(ref.id, { signal: options?.signal });
  }
}

export function defaultGrokCredentialRoot(
  env: Readonly<Record<string, string | undefined>> = process.env,
  homeDir = homedir(),
): string {
  const configured = env.INKOS_CREDENTIAL_HOME?.trim();
  return configured
    ? join(resolve(configured), "grok")
    : join(homeDir, ".inkos", "credentials", "grok");
}

export async function startGrokLoopbackCallback(input: {
  readonly redirectUri: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly wait: Promise<string>;
  readonly close: () => Promise<void>;
}> {
  const callback = callbackDescriptor(input.redirectUri);
  let server: Server | undefined;
  let settled = false;
  let resolveWait!: (url: string) => void;
  let rejectWait!: (error: unknown) => void;
  const wait = new Promise<string>((resolvePromise, rejectPromise) => {
    resolveWait = resolvePromise;
    rejectWait = rejectPromise;
  });
  const close = async () => {
    if (!server) return;
    await new Promise<void>((resolveClose) => server!.close(() => resolveClose()));
    server = undefined;
  };
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", input.redirectUri);
    if (url.pathname !== callback.path) {
      response.writeHead(404).end("Not found");
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" }).end("Method not allowed");
      return;
    }
    if (
      !url.searchParams.get("state")
      || (!url.searchParams.get("code") && !url.searchParams.get("error"))
    ) {
      response.writeHead(400).end("Invalid OAuth callback");
      return;
    }
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Grok connection received. You may close this window.");
    if (!settled) {
      settled = true;
      resolveWait(url.toString());
      void close();
    }
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server!.once("error", (error) => rejectListen(new GrokOAuthError(
      isNodeError(error, "EADDRINUSE")
        ? "grok_callback_port_in_use"
        : "grok_callback_listen_failed",
      isNodeError(error, "EADDRINUSE")
        ? `Grok callback port ${callback.port} is already in use; paste the callback URL instead.`
        : "Grok callback listener could not start; paste the callback URL instead.",
    )));
    server!.listen(callback.port, "127.0.0.1", resolveListen);
  });
  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectWait(new GrokOAuthError(
      "grok_callback_timeout",
      "Grok callback did not arrive before the login session expired.",
    ));
    void close();
  }, input.timeoutMs ?? GROK_LOGIN_SESSION_TTL_MS);
  const onAbort = () => {
    if (settled) return;
    settled = true;
    rejectWait(input.signal?.reason ?? new Error("Operation aborted"));
    void close();
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });
  return {
    wait: wait.finally(() => {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", onAbort);
    }),
    close,
  };
}

function assertGrokOAuthConfig(
  config: GrokOAuthConfig,
  allowInsecureHttpForTests: boolean,
): void {
  const status = grokOAuthConfigurationStatus(config);
  if (!status.configured) {
    throw new GrokOAuthError(
      "grok_oauth_config_missing",
      `Grok OAuth configuration is missing: ${status.missing.join(", ")}.`,
    );
  }
  const issuer = new URL(config.issuer);
  if (issuer.username || issuer.password || issuer.search || issuer.hash) {
    throw new GrokOAuthError(
      "grok_issuer_invalid",
      "Grok OAuth issuer must be a clean origin URL.",
    );
  }
  if (
    issuer.protocol !== "https:"
    && !(allowInsecureHttpForTests && issuer.protocol === "http:" && isLoopback(issuer.hostname))
  ) {
    throw new GrokOAuthError(
      "grok_issuer_untrusted",
      "Grok OAuth issuer must use trusted HTTPS.",
    );
  }
  callbackDescriptor(config.redirectUri);
}

function assertTrustedEndpoint(
  endpoint: string,
  issuer: string,
  field: string,
  allowInsecureHttpForTests: boolean,
): void {
  const url = new URL(endpoint);
  const trusted = new URL(issuer);
  if (url.origin !== trusted.origin || url.username || url.password || url.hash) {
    throw new GrokOAuthError(
      "grok_discovery_endpoint_untrusted",
      `Grok OIDC ${field} must use the configured issuer origin.`,
    );
  }
  if (
    url.protocol !== "https:"
    && !(allowInsecureHttpForTests && url.protocol === "http:" && isLoopback(url.hostname))
  ) {
    throw new GrokOAuthError(
      "grok_discovery_endpoint_untrusted",
      `Grok OIDC ${field} must use trusted HTTPS.`,
    );
  }
}

function callbackDescriptor(redirectUri: string): GrokOAuthLoginStart["callback"] {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    throw new GrokOAuthError(
      "grok_redirect_invalid",
      "Grok OAuth redirect URI is invalid.",
    );
  }
  if (
    url.protocol !== "http:"
    || url.hostname !== "127.0.0.1"
    || !url.port
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname === "/"
  ) {
    throw new GrokOAuthError(
      "grok_redirect_untrusted",
      "Grok OAuth redirect URI must be an exact http://127.0.0.1:<port>/<path> callback.",
    );
  }
  return {
    scheme: "http",
    host: "127.0.0.1",
    port: Number(url.port),
    path: url.pathname,
  };
}

function parseCallbackInput(
  value: string,
  expectedRedirectUri: string,
  expectedState: string,
): { readonly code: string; readonly error?: string } {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 8_192) {
    throw new GrokOAuthError(
      "grok_callback_invalid",
      "Grok callback input is empty or too large.",
    );
  }
  if (!trimmed.includes("://")) {
    if (!/^[A-Za-z0-9._~-]+$/u.test(trimmed)) {
      throw new GrokOAuthError(
        "grok_authorization_code_invalid",
        "Grok authorization code contains invalid characters.",
      );
    }
    return { code: trimmed };
  }
  const expected = new URL(expectedRedirectUri);
  const actual = new URL(trimmed);
  if (
    actual.protocol !== expected.protocol
    || actual.hostname !== expected.hostname
    || actual.port !== expected.port
    || actual.pathname !== expected.pathname
  ) {
    throw new GrokOAuthError(
      "grok_callback_origin_mismatch",
      "Grok callback URL does not match the configured loopback redirect.",
    );
  }
  const state = actual.searchParams.get("state");
  if (!state || state !== expectedState) {
    throw new GrokOAuthError(
      "grok_callback_state_mismatch",
      "Grok callback state validation failed.",
    );
  }
  const error = actual.searchParams.get("error") ?? undefined;
  const code = actual.searchParams.get("code") ?? "";
  if (!error && !code) {
    throw new GrokOAuthError(
      "grok_authorization_code_missing",
      "Grok callback did not contain an authorization code.",
    );
  }
  return { code, ...(error ? { error } : {}) };
}

function parseTokenSet(raw: Record<string, unknown>, now: number): GrokOAuthTokenSet {
  const refreshed = parseRefreshTokenSet(raw, now);
  return {
    ...refreshed,
    tokenType: "Bearer",
    ...(stringValue(raw.scope) ? { scope: stringValue(raw.scope)! } : {}),
    ...(stringValue(raw.refresh_token)
      ? { refreshToken: stringValue(raw.refresh_token)! }
      : {}),
    ...(stringValue(raw.id_token) ? { idToken: stringValue(raw.id_token)! } : {}),
  };
}

function parseRefreshTokenSet(
  raw: Record<string, unknown>,
  now: number,
): Partial<GrokOAuthTokenSet> & Pick<GrokOAuthTokenSet, "accessToken" | "expiresAt"> {
  const accessToken = stringValue(raw.access_token);
  const expiresIn = numberValue(raw.expires_in);
  const tokenType = stringValue(raw.token_type);
  if (
    !accessToken
    || !expiresIn
    || expiresIn <= 0
    || tokenType?.toLowerCase() !== "bearer"
  ) {
    throw new GrokOAuthError(
      "grok_token_response_invalid",
      "Grok OAuth token response is missing a valid access token or expiry.",
      true,
    );
  }
  return {
    accessToken,
    expiresAt: new Date(now + expiresIn * 1_000).toISOString(),
    ...(stringValue(raw.refresh_token)
      ? { refreshToken: stringValue(raw.refresh_token)! }
      : {}),
    ...(stringValue(raw.id_token) ? { idToken: stringValue(raw.id_token)! } : {}),
    tokenType: "Bearer",
    ...(stringValue(raw.scope) ? { scope: stringValue(raw.scope)! } : {}),
  };
}

function validateIdTokenClaims(
  claims: Record<string, unknown>,
  expected: {
    readonly discovery: GrokOidcDiscovery;
    readonly clientId: string;
    readonly nonce: string;
    readonly now: number;
  },
): GrokAccountIdentity {
  if (claims.iss !== expected.discovery.issuer) {
    throw idTokenClaimError("issuer");
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(expected.clientId)) {
    throw idTokenClaimError("audience");
  }
  if (audiences.length > 1 && claims.azp !== expected.clientId) {
    throw idTokenClaimError("authorized party");
  }
  if (claims.nonce !== expected.nonce) {
    throw idTokenClaimError("nonce");
  }
  const expiresAt = jwtNumericDate(claims.exp);
  if (!expiresAt || expiresAt * 1_000 <= expected.now) {
    throw idTokenClaimError("expiry");
  }
  const issuedAt = jwtNumericDate(claims.iat);
  if (!issuedAt || issuedAt * 1_000 > expected.now + 60_000) {
    throw idTokenClaimError("issued-at");
  }
  const notBefore = jwtNumericDate(claims.nbf);
  if (notBefore !== undefined && notBefore * 1_000 > expected.now + 60_000) {
    throw idTokenClaimError("not-before");
  }
  const subject = stringValue(claims.sub);
  if (!subject) throw idTokenClaimError("subject");
  return {
    subject,
    ...(stringValue(claims.email) ? { email: stringValue(claims.email)! } : {}),
    ...(stringValue(claims.name) ? { displayName: stringValue(claims.name)! } : {}),
  };
}

function idTokenClaimError(claim: string): GrokOAuthError {
  return new GrokOAuthError(
    "grok_id_token_claim",
    `Grok ID token ${claim} validation failed.`,
    true,
  );
}

function parseJwt(token: string): {
  readonly header: Record<string, unknown>;
  readonly claims: Record<string, unknown>;
  readonly signingInput: string;
  readonly signature: string;
} {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new GrokOAuthError(
      "grok_id_token_invalid",
      "Grok ID token is malformed.",
      true,
    );
  }
  try {
    return {
      header: objectValue(JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")))
        ?? {},
      claims: objectValue(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")))
        ?? {},
      signingInput: `${parts[0]}.${parts[1]}`,
      signature: parts[2],
    };
  } catch {
    throw new GrokOAuthError(
      "grok_id_token_invalid",
      "Grok ID token is malformed.",
      true,
    );
  }
}

function parseStoredTokens(raw: unknown): StoredGrokTokens {
  const value = objectValue(raw);
  const parsed: StoredGrokTokens = {
    version: 1,
    ...(stringValue(value?.revision) ? { revision: stringValue(value?.revision)! } : {}),
    issuer: requiredString(value?.issuer, "issuer"),
    clientId: requiredString(value?.clientId, "clientId"),
    redirectUri: requiredString(value?.redirectUri, "redirectUri"),
    subject: requiredString(value?.subject, "subject"),
    accessToken: requiredString(value?.accessToken, "accessToken"),
    tokenType: requiredString(value?.tokenType, "tokenType"),
    expiresAt: requiredString(value?.expiresAt, "expiresAt"),
    ...(stringValue(value?.refreshToken) ? { refreshToken: stringValue(value?.refreshToken)! } : {}),
    ...(stringValue(value?.idToken) ? { idToken: stringValue(value?.idToken)! } : {}),
    ...(stringValue(value?.scope) ? { scope: stringValue(value?.scope)! } : {}),
  };
  if (value?.version !== 1 || !Number.isFinite(Date.parse(parsed.expiresAt))) {
    throw new GrokOAuthError(
      "grok_credential_invalid",
      "Stored Grok credential is invalid.",
      true,
    );
  }
  return parsed;
}

function parseRegistry(raw: unknown): GrokRegistry {
  const value = objectValue(raw);
  if (value?.version !== REGISTRY_VERSION || !Array.isArray(value.credentials)) {
    throw new GrokOAuthError(
      "grok_registry_invalid",
      "InkOS Grok credential registry is invalid.",
    );
  }
  const credentials = value.credentials.map((item) => {
    const entry = objectValue(item);
    const id = requiredString(entry?.id, "id");
    assertCredentialId(id);
    const expiresAt = requiredString(entry?.expiresAt, "expiresAt");
    if (!Number.isFinite(Date.parse(expiresAt))) {
      throw new GrokOAuthError(
        "grok_registry_invalid",
        "InkOS Grok credential registry contains an invalid expiry.",
      );
    }
    return {
      id,
      issuer: requiredString(entry?.issuer, "issuer"),
      subject: requiredString(entry?.subject, "subject"),
      expiresAt,
      ...(stringValue(entry?.email) ? { email: stringValue(entry?.email)! } : {}),
      ...(stringValue(entry?.displayName)
        ? { displayName: stringValue(entry?.displayName)! }
        : {}),
      ...(stringValue(entry?.scope) ? { scope: stringValue(entry?.scope)! } : {}),
      ...(entry?.lastRefresh === "succeeded" || entry?.lastRefresh === "failed"
        ? { lastRefresh: entry.lastRefresh }
        : {}),
      ...(entry?.authRequired === true ? { authRequired: true } : {}),
    } satisfies GrokRegistryEntry;
  });
  const activeCredentialId = stringValue(value.activeCredentialId);
  if (
    activeCredentialId
    && !credentials.some((entry) => entry.id === activeCredentialId)
  ) {
    throw new GrokOAuthError(
      "grok_registry_invalid",
      "InkOS Grok credential registry has an invalid active account.",
    );
  }
  return {
    version: REGISTRY_VERSION,
    ...(activeCredentialId ? { activeCredentialId } : {}),
    credentials,
  };
}

async function readBoundedJson(response: Response): Promise<Record<string, unknown>> {
  const contentLength = numberValue(response.headers.get("content-length"));
  if (contentLength !== undefined && contentLength > MAX_OAUTH_RESPONSE_BYTES) {
    throw oauthResponseTooLarge();
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_OAUTH_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw oauthResponseTooLarge();
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return objectValue(JSON.parse(new TextDecoder().decode(bytes)))
      ?? (() => { throw new Error("not object"); })();
  } catch {
    throw new GrokOAuthError(
      "grok_oauth_response_invalid",
      "Grok OAuth endpoint returned invalid JSON.",
    );
  }
}

function oauthResponseTooLarge(): GrokOAuthError {
  return new GrokOAuthError(
    "grok_oauth_response_too_large",
    "Grok OAuth response exceeded the safe size limit.",
  );
}

function canonicalIssuer(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}

function wasRefreshedAfter(
  current: StoredGrokTokens,
  beforeLock: StoredGrokTokens,
): boolean {
  if (current.revision || beforeLock.revision) {
    return current.revision !== beforeLock.revision;
  }
  return current.accessToken !== beforeLock.accessToken
    || current.refreshToken !== beforeLock.refreshToken
    || current.expiresAt !== beforeLock.expiresAt;
}

function assertCredentialId(id: string): void {
  if (!STABLE_ID.test(id)) {
    throw new GrokOAuthError(
      "grok_credential_id_invalid",
      "Grok credential ID must be a stable lowercase identifier.",
    );
  }
}

function credentialMissing(id: string): GrokOAuthError {
  return new GrokOAuthError(
    "grok_credential_missing",
    `Grok credential "${safeIdentifier(id)}" is not connected.`,
    true,
  );
}

function requiredString(value: unknown, field: string): string {
  const text = stringValue(value);
  if (!text) {
    throw new GrokOAuthError(
      "grok_oauth_response_invalid",
      `Grok OAuth response is missing ${field}.`,
    );
  }
  return text;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function jwtNumericDate(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function maskAccount(value: string): string {
  if (value.includes("@")) {
    const [local, domain] = value.split("@", 2);
    return `${local?.slice(0, 2) || "••"}••@${domain}`;
  }
  return value.length <= 6
    ? "••••••"
    : `${value.slice(0, 3)}••••${value.slice(-3)}`;
}

function safeIdentifier(value: string): string {
  return value.replace(/[^a-z0-9._:-]/giu, "?").slice(0, 128);
}

function safeOAuthError(value: string): string {
  return value.replace(/[^a-z0-9._-]/giu, "?").slice(0, 64);
}

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function isAuthRequired(error: unknown): boolean {
  return error instanceof GrokOAuthError && error.authRequired;
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
  code: string,
  message: string,
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
      if (Date.now() >= deadline) throw new GrokOAuthError(code, message);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
  }
}
