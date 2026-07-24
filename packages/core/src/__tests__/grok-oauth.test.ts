import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GROK_NATIVE_OAUTH_CONFIG,
  GrokCredentialStore,
  GrokOAuthClient,
  GrokOAuthError,
  GrokOAuthLoginManager,
  grokOAuthConfigFromEnv,
  grokOAuthConfigurationStatus,
  startGrokLoopbackCallback,
  type GrokOAuthConfig,
  type GrokOAuthTokenSet,
} from "../llm/credentials/grok-oauth.js";

const roots: string[] = [];
const now = Date.parse("2026-07-24T00:00:00.000Z");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe("Grok OAuth OIDC login", () => {
  it("ships the native Grok login application settings without asking users for developer fields", () => {
    expect(grokOAuthConfigFromEnv({})).toEqual(GROK_NATIVE_OAUTH_CONFIG);
    expect(grokOAuthConfigurationStatus(grokOAuthConfigFromEnv({}))).toMatchObject({
      configured: true,
      issuer: "https://auth.x.ai",
      redirectUri: "http://127.0.0.1:56121/callback",
    });
  });

  it("reports exact missing production configuration without network access", () => {
    expect(grokOAuthConfigurationStatus({})).toEqual({
      configured: false,
      missing: ["issuer", "clientId", "redirectUri"],
      issuer: null,
      redirectUri: null,
    });
    expect(() => new GrokOAuthClient({
      issuer: "http://issuer.example",
      clientId: "client",
      redirectUri: "http://127.0.0.1:56121/callback",
    })).toThrow(/trusted HTTPS/u);
  });

  it("rejects untrusted discovery endpoints before authorization or token requests", async () => {
    const fetch = vi.fn(async () => jsonResponse({
      issuer: "https://auth.example",
      authorization_endpoint: "https://evil.example/authorize",
      token_endpoint: "https://auth.example/token",
      jwks_uri: "https://auth.example/jwks",
    }));
    const client = new GrokOAuthClient(config(), { fetch });
    await expect(client.discover()).rejects.toMatchObject({
      code: "grok_discovery_endpoint_untrusted",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uses isolated PKCE sessions and rejects state, nonce, expiry, and replay", async () => {
    const root = await tempRoot();
    const seenTokenBodies: URLSearchParams[] = [];
    const fetch = vi.fn(async (
      url: Parameters<typeof globalThis.fetch>[0],
      init?: RequestInit,
    ) => {
      if (url.toString().includes(".well-known")) return discoveryResponse();
      seenTokenBodies.push(new URLSearchParams(String(init?.body)));
      return jsonResponse(tokenResponse("id-token"));
    });
    let clock = now;
    const verifyIdToken = vi.fn(async (
      token: string,
      expected: { readonly nonce: string },
    ) => {
      expect(token).toBe("id-token");
      expect(expected.nonce).toHaveLength(43);
      return { subject: "subject-1", email: "person@example.test" };
    });
    const client = new GrokOAuthClient(config(), {
      fetch,
      now: () => clock,
      randomBytes: deterministicRandom(),
      verifyIdToken,
    });
    const store = new GrokCredentialStore(root, () => client, () => clock);
    const manager = new GrokOAuthLoginManager(client, store, {
      now: () => clock,
      sessionTtlMs: 1_000,
    });

    const first = await manager.begin("grok-one");
    const second = await manager.begin("grok-two");
    expect(first.sessionId).not.toBe(second.sessionId);
    const firstUrl = new URL(first.authorizationUrl);
    expect(firstUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(firstUrl.searchParams.get("code_challenge")).toHaveLength(43);
    expect(firstUrl.searchParams.get("state")).not.toBe(
      new URL(second.authorizationUrl).searchParams.get("state"),
    );

    await expect(manager.complete(
      first.sessionId,
      "http://127.0.0.1:56121/callback?code=secret-code&state=wrong",
    )).rejects.toMatchObject({ code: "grok_callback_state_mismatch" });
    await expect(manager.complete(first.sessionId, "secret-code"))
      .rejects.toMatchObject({ code: "grok_login_session_missing" });
    expect(seenTokenBodies).toHaveLength(0);

    const secondState = new URL(second.authorizationUrl).searchParams.get("state")!;
    const completed = await manager.complete(
      second.sessionId,
      `?code=secret-code&state=${secondState}`,
    );
    expect(completed).toMatchObject({
      id: "grok-two",
      active: true,
      accountHint: "pe••@example.test",
    });
    expect(seenTokenBodies[0]?.get("code_verifier")).toHaveLength(64);
    expect(seenTokenBodies[0]?.get("code")).toBe("secret-code");
    expect(manager.status(second.sessionId)).toBe("completed");
    expect(manager.status(second.sessionId)).toBe("missing");
    await expect(manager.complete(second.sessionId, "secret-code"))
      .rejects.toMatchObject({ code: "grok_login_session_missing" });

    const expired = await manager.begin("grok-expired");
    clock += 1_001;
    expect(manager.status(expired.sessionId)).toBe("expired");
    const expiredState = new URL(expired.authorizationUrl).searchParams.get("state");
    await expect(manager.completeCallback(
      `http://127.0.0.1:56121/callback?code=secret-code&state=${expiredState}`,
    )).rejects.toMatchObject({ code: "grok_login_session_missing" });
    expect(verifyIdToken).toHaveBeenCalledTimes(1);
  });

  it("verifies RS256 signatures and required OIDC claims with the discovered JWKS", async () => {
    const root = await tempRoot();
    const trusted = generateKeyPairSync("rsa", { modulusLength: 2_048 });
    const untrusted = generateKeyPairSync("rsa", { modulusLength: 2_048 });
    const jwk = trusted.publicKey.export({ format: "jwk" });
    let nonce = "";
    let signingKey = trusted.privateKey;
    const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = input.toString();
      if (url.includes(".well-known")) return discoveryResponse();
      if (url.endsWith("/jwks")) {
        return jsonResponse({
          keys: [{ ...jwk, kid: "fixture-key", use: "sig", alg: "RS256" }],
        });
      }
      return jsonResponse(tokenResponse(signedIdToken(signingKey, {
        iss: "https://auth.example",
        aud: "client-id",
        nonce,
        exp: Math.floor(now / 1_000) + 3_600,
        iat: Math.floor(now / 1_000),
        sub: "subject-jwks",
        email: "jwks@example.test",
      })));
    });
    const client = new GrokOAuthClient(config(), { fetch, now: () => now });
    const store = new GrokCredentialStore(root, () => client, () => now);
    const manager = new GrokOAuthLoginManager(client, store, { now: () => now });

    const valid = await manager.begin("grok-jwks");
    nonce = new URL(valid.authorizationUrl).searchParams.get("nonce")!;
    await expect(manager.complete(valid.sessionId, "valid-code")).resolves.toMatchObject({
      id: "grok-jwks",
      subject: "subject-jwks",
    });

    const wrongNonce = await manager.begin("grok-wrong-nonce");
    nonce = "wrong-nonce";
    await expect(manager.complete(wrongNonce.sessionId, "wrong-nonce-code"))
      .rejects.toMatchObject({ code: "grok_id_token_claim" });

    const badSignature = await manager.begin("grok-bad-signature");
    nonce = new URL(badSignature.authorizationUrl).searchParams.get("nonce")!;
    signingKey = untrusted.privateKey;
    await expect(manager.complete(badSignature.sessionId, "bad-signature-code"))
      .rejects.toMatchObject({ code: "grok_id_token_signature" });
  });

  it("rejects a failed ID-token verifier and stores no account", async () => {
    const root = await tempRoot();
    const fetch = vi.fn(async (url: Parameters<typeof globalThis.fetch>[0]) =>
      url.toString().includes(".well-known")
        ? discoveryResponse()
        : jsonResponse(tokenResponse("bad-id-token")));
    const client = new GrokOAuthClient(config(), {
      fetch,
      now: () => now,
      verifyIdToken: async () => {
        throw new GrokOAuthError(
          "grok_id_token_claim",
          "Grok ID token nonce validation failed.",
          true,
        );
      },
    });
    const store = new GrokCredentialStore(root, () => client, () => now);
    const manager = new GrokOAuthLoginManager(client, store, { now: () => now });
    const login = await manager.begin("grok-rejected");
    const state = new URL(login.authorizationUrl).searchParams.get("state")!;
    await expect(manager.complete(
      login.sessionId,
      `http://127.0.0.1:56121/callback?code=one-time&state=${state}`,
    )).rejects.toMatchObject({ code: "grok_id_token_claim" });
    expect(await store.list()).toEqual([]);
  });

  it("rejects denial and malicious callback origins without exchanging a token", async () => {
    const root = await tempRoot();
    const fetch = vi.fn(async (url: Parameters<typeof globalThis.fetch>[0]) =>
      url.toString().includes(".well-known")
        ? discoveryResponse()
        : jsonResponse(tokenResponse("unexpected")));
    const client = new GrokOAuthClient(config(), {
      fetch,
      verifyIdToken: async () => ({ subject: "unexpected" }),
    });
    const manager = new GrokOAuthLoginManager(
      client,
      new GrokCredentialStore(root, () => client),
    );
    const denied = await manager.begin("grok-denied");
    const deniedState = new URL(denied.authorizationUrl).searchParams.get("state");
    await expect(manager.complete(
      denied.sessionId,
      `http://127.0.0.1:56121/callback?error=access_denied&state=${deniedState}`,
    )).rejects.toMatchObject({ code: "grok_authorization_denied" });

    const malicious = await manager.begin("grok-malicious");
    const state = new URL(malicious.authorizationUrl).searchParams.get("state");
    await expect(manager.complete(
      malicious.sessionId,
      `http://evil.test/callback?code=once&state=${state}`,
    )).rejects.toMatchObject({ code: "grok_callback_origin_mismatch" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("Grok multi-account credential store", () => {
  it("stores two accounts, switches active, and never exposes tokens in status", async () => {
    const root = await tempRoot();
    const store = new GrokCredentialStore(root, undefined, () => now);
    await store.saveLogin(login("grok-one", "subject-one", "one@example.test"));
    await store.saveLogin(login("grok-two", "subject-two", "two@example.test"));
    expect((await store.list()).map((status) => [status.id, status.active]))
      .toEqual([["grok-one", false], ["grok-two", true]]);

    await store.setActive("grok-one");
    const safeJson = JSON.stringify(await store.list());
    expect(safeJson).not.toContain("access-token");
    expect(safeJson).not.toContain("refresh-token");
    expect(safeJson).not.toContain("id-token");
    expect((await store.getStatus("grok-one"))?.active).toBe(true);

    await store.delete("grok-one");
    expect(await store.list()).toEqual([
      expect.objectContaining({ id: "grok-two", active: true }),
    ]);
    const registry = await readFile(join(root, "registry.json"), "utf8");
    expect(registry).not.toContain("access-token");
  });

  it("single-flights concurrent near-expiry refresh across store instances", async () => {
    const root = await tempRoot();
    let refreshCalls = 0;
    const client = {
      discover: vi.fn(async () => discovery()),
      refresh: vi.fn(async () => {
        refreshCalls += 1;
        await Promise.resolve();
        return {
          accessToken: "access-token-new",
          refreshToken: "refresh-token-rotated",
          expiresAt: new Date(now + 3_600_000).toISOString(),
        };
      }),
    } as unknown as GrokOAuthClient;
    const createClient = () => client;
    const first = new GrokCredentialStore(root, createClient, () => now);
    const second = new GrokCredentialStore(root, createClient, () => now);
    await first.saveLogin(login(
      "grok-one",
      "subject-one",
      "one@example.test",
      new Date(now + 30_000).toISOString(),
    ));

    const [a, b] = await Promise.all([
      first.resolve("grok-one"),
      second.resolve("grok-one"),
    ]);
    expect(refreshCalls).toBe(1);
    expect(a.accessToken).toBe("access-token-new");
    expect(b.accessToken).toBe("access-token-new");
    const tokenFile = await readFile(join(root, "accounts", "grok-one.json"), "utf8");
    expect(tokenFile).toContain("refresh-token-rotated");
    expect(JSON.parse(tokenFile)).toHaveProperty("revision");
    expect((await first.getStatus("grok-one"))?.lastRefresh).toBe("succeeded");
  });

  it("marks rejected refresh auth_required without leaking the token", async () => {
    const root = await tempRoot();
    const client = {
      discover: vi.fn(async () => discovery()),
      refresh: vi.fn(async () => {
        throw new GrokOAuthError(
          "grok_token_rejected",
          "Grok OAuth refresh was rejected.",
          true,
        );
      }),
    } as unknown as GrokOAuthClient;
    const store = new GrokCredentialStore(root, () => client, () => now);
    await store.saveLogin(login(
      "grok-one",
      "subject-one",
      "one@example.test",
      new Date(now + 30_000).toISOString(),
    ));
    await expect(store.resolve("grok-one")).rejects.toMatchObject({
      code: "grok_token_rejected",
      authRequired: true,
    });
    expect(await store.getStatus("grok-one")).toMatchObject({
      authRequired: true,
      lastRefresh: "failed",
    });
  });
});

describe("Grok loopback callback", () => {
  it("binds only 127.0.0.1 and receives the configured callback path", async () => {
    const port = await availablePort();
    const listener = await startGrokLoopbackCallback({
      redirectUri: `http://127.0.0.1:${port}/callback`,
      timeoutMs: 2_000,
    });
    const callbackUrl = `http://127.0.0.1:${port}/callback?code=once&state=test`;
    expect(await httpStatus(`http://127.0.0.1:${port}/callback?code=once`)).toBe(400);
    expect(await httpStatus(callbackUrl, "POST")).toBe(405);
    expect(await httpStatus(callbackUrl)).toBe(200);
    expect(await listener.wait).toBe(callbackUrl);
  });

  it("reports a fixed-port conflict with manual-paste guidance", async () => {
    const { server, port } = await listeningServer();
    try {
      await expect(startGrokLoopbackCallback({
        redirectUri: `http://127.0.0.1:${port}/callback`,
      })).rejects.toMatchObject({ code: "grok_callback_port_in_use" });
    } finally {
      await closeServer(server);
    }
  });

  it("times out a loopback wait without retaining the listener", async () => {
    const port = await availablePort();
    const listener = await startGrokLoopbackCallback({
      redirectUri: `http://127.0.0.1:${port}/callback`,
      timeoutMs: 20,
    });
    await expect(listener.wait).rejects.toMatchObject({
      code: "grok_callback_timeout",
    });
  });
});

function config(): GrokOAuthConfig {
  return {
    issuer: "https://auth.example",
    clientId: "client-id",
    redirectUri: "http://127.0.0.1:56121/callback",
  };
}

function discovery() {
  return {
    issuer: "https://auth.example",
    authorizationEndpoint: "https://auth.example/authorize",
    tokenEndpoint: "https://auth.example/token",
    jwksUri: "https://auth.example/jwks",
  };
}

function discoveryResponse(): Response {
  return jsonResponse({
    issuer: "https://auth.example",
    authorization_endpoint: "https://auth.example/authorize",
    token_endpoint: "https://auth.example/token",
    jwks_uri: "https://auth.example/jwks",
  });
}

function tokenResponse(idToken: string) {
  return {
    access_token: "access-token",
    refresh_token: "refresh-token",
    id_token: idToken,
    token_type: "Bearer",
    expires_in: 3_600,
    scope: "openid offline_access",
  };
}

function login(
  id: string,
  subject: string,
  email: string,
  expiresAt = new Date(now + 3_600_000).toISOString(),
) {
  return {
    id,
    config: config(),
    identity: { subject, email },
    tokens: {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      idToken: "id-token",
      tokenType: "Bearer",
      expiresAt,
    } satisfies GrokOAuthTokenSet,
  };
}

function deterministicRandom(): (size: number) => Uint8Array {
  let call = 0;
  return (size) => {
    call += 1;
    return Uint8Array.from({ length: size }, (_, index) => (index + call) % 256);
  };
}

function signedIdToken(
  privateKey: KeyObject,
  claims: Readonly<Record<string, unknown>>,
): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "fixture-key" }))
    .toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signingInput = `${header}.${payload}`;
  return `${signingInput}.${sign(
    "RSA-SHA256",
    Buffer.from(signingInput),
    privateKey,
  ).toString("base64url")}`;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "inkos-grok-auth-"));
  roots.push(root);
  return root;
}

async function availablePort(): Promise<number> {
  const { server, port } = await listeningServer();
  await closeServer(server);
  return port;
}

async function listeningServer(): Promise<{ readonly server: Server; readonly port: number }> {
  const server = createServer((_request, response) => response.end("occupied"));
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No loopback port.");
  return { server, port: address.port };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, rejectClose) =>
    server.close((error) => error ? rejectClose(error) : resolveClose()));
}

function httpStatus(url: string, method = "GET"): Promise<number> {
  return new Promise((resolveStatus, rejectStatus) => {
    const request = httpRequest(url, { method }, (response) => {
      response.resume();
      resolveStatus(response.statusCode ?? 0);
    });
    request.once("error", rejectStatus);
    request.end();
  });
}
