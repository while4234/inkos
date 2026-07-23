import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  CODEX_AUTH_MAX_BYTES,
  CodexCredentialError,
  CodexCredentialStore,
  discoverCodexAuthCandidates,
  parseCodexAuthBytes,
  type CodexTokenRefresher,
} from "../llm/credentials/codex-auth.js";

describe("Codex auth credential store", () => {
  it("detects candidates in priority order, de-duplicates paths, and exposes only safe status", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "inkos-codex-discovery-"));
    const home = join(fixture, "home");
    const project = join(fixture, "project");
    const explicit = join(fixture, "selected", "auth.json");
    await mkdir(join(project, ".codex"), { recursive: true });
    await mkdir(join(fixture, "selected"), { recursive: true });
    await writeFile(explicit, authJson({ accountId: "account-discovery-12345678" }));
    await writeFile(join(project, ".codex", "auth.json"), "{broken");

    const candidates = await discoverCodexAuthCandidates({
      projectRoot: project,
      homeDir: home,
      env: {
        CODEX_AUTH_FILE: explicit,
        CODEX_HOME: join(fixture, "selected"),
      },
    });

    expect(candidates).toHaveLength(3);
    expect(candidates[0]).toMatchObject({
      sources: ["CODEX_AUTH_FILE", "CODEX_HOME"],
      safeFileName: "auth.json",
      state: "available",
      accountHint: "acco••••5678",
    });
    expect(candidates[1]).toMatchObject({ sources: ["project"], state: "invalid" });
    expect(candidates[2]).toMatchObject({ sources: ["user_home"], state: "missing" });
    expect(JSON.stringify(candidates)).not.toContain(fixture);
    expect(JSON.stringify(candidates)).not.toContain("access-value");
  });

  it("does not attribute default discovery paths to unset environment variables", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "inkos-codex-default-discovery-"));
    const candidates = await discoverCodexAuthCandidates({
      projectRoot: join(fixture, "project"),
      homeDir: join(fixture, "home"),
      env: {},
    });

    expect(candidates.map((candidate) => candidate.sources)).toEqual([
      ["project"],
      ["user_home"],
    ]);
  });

  it("imports only bounded nested-token JSON and leaves no managed file after validation failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-codex-store-"));
    const store = new CodexCredentialStore(root);
    const status = await store.importBytes({
      id: "credential-codex",
      bytes: new TextEncoder().encode(authJson({ accountId: "account-import-12345678" })),
      safeFileName: "chosen-auth.json",
    });
    expect(status).toMatchObject({
      id: "credential-codex",
      source: "managed_copy",
      safeFileName: "chosen-auth.json",
      accountHint: "acco••••5678",
      needsReimport: false,
    });
    await expect(store.importBytes({
      id: "credential-invalid",
      bytes: new TextEncoder().encode("{}"),
    })).rejects.toMatchObject({ code: "codex_auth_invalid_shape" });
    await expect(store.importBytes({
      id: "credential-large",
      bytes: new Uint8Array(CODEX_AUTH_MAX_BYTES + 1),
    })).rejects.toMatchObject({ code: "codex_auth_too_large" });
    await expect(readFile(join(root, "auth", "credential-invalid.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(root, "auth", "credential-large.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects path-like credential IDs before creating a managed auth file", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "inkos-codex-id-"));
    const root = join(fixture, "registry");
    const store = new CodexCredentialStore(root);

    await expect(store.importBytes({
      id: "../../escaped",
      bytes: new TextEncoder().encode(authJson()),
    })).rejects.toMatchObject({ code: "codex_credential_id_invalid" });
    await expect(readFile(join(fixture, "escaped.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes registry mutations across store instances without losing credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-codex-registry-race-"));
    const first = new CodexCredentialStore(root);
    const second = new CodexCredentialStore(root);

    await Promise.all([
      first.importBytes({
        id: "credential-first",
        bytes: new TextEncoder().encode(authJson()),
      }),
      second.importBytes({
        id: "credential-second",
        bytes: new TextEncoder().encode(authJson()),
      }),
    ]);

    expect((await first.list()).map((credential) => credential.id).sort()).toEqual([
      "credential-first",
      "credential-second",
    ]);
  });

  it("single-flights near-expiry refresh and persists rotated refresh tokens atomically", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-codex-refresh-"));
    const now = Date.UTC(2026, 6, 24, 0, 0, 0);
    let refreshCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const refresher: CodexTokenRefresher = {
      async refresh() {
        refreshCalls += 1;
        await gate;
        return {
          accessToken: tokenValue("new-access"),
          refreshToken: tokenValue("rotated-refresh"),
          expiresAt: new Date(now + 3_600_000).toISOString(),
        };
      },
    };
    const store = new CodexCredentialStore(root, refresher, () => now);
    await store.importBytes({
      id: "credential-codex",
      bytes: new TextEncoder().encode(authJson({
        expiresAt: new Date(now + 30_000).toISOString(),
      })),
    });
    const secondStore = new CodexCredentialStore(root, refresher, () => now);

    const first = store.resolve("credential-codex");
    const second = secondStore.resolve("credential-codex");
    for (let attempt = 0; attempt < 20 && refreshCalls === 0; attempt += 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    }
    expect(refreshCalls).toBe(1);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.accessToken).toBe(tokenValue("new-access"));
    expect(b.accessToken).toBe(tokenValue("new-access"));
    expect(refreshCalls).toBe(1);

    const saved = JSON.parse(await readFile(
      join(root, "auth", "credential-codex.json"),
      "utf8",
    )) as { tokens: { access_token: string; refresh_token: string } };
    expect(saved.tokens).toMatchObject({
      access_token: tokenValue("new-access"),
      refresh_token: tokenValue("rotated-refresh"),
    });
    expect(await store.getStatus("credential-codex")).toMatchObject({
      lastRefresh: "succeeded",
      nearExpiry: false,
    });
  });

  it("single-flights forced refresh across stores when the refresh token does not rotate", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-codex-force-refresh-"));
    const now = Date.UTC(2026, 6, 24, 0, 0, 0);
    let refreshCalls = 0;
    const refresher: CodexTokenRefresher = {
      async refresh() {
        refreshCalls += 1;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
        return {
          accessToken: tokenValue("forced-access"),
          refreshToken: tokenValue("refresh"),
          expiresAt: new Date(now + 3_600_000).toISOString(),
        };
      },
    };
    const first = new CodexCredentialStore(root, refresher, () => now);
    const second = new CodexCredentialStore(root, refresher, () => now);
    await first.importBytes({
      id: "credential-codex",
      bytes: new TextEncoder().encode(authJson()),
    });

    const [a, b] = await Promise.all([
      first.resolve("credential-codex", { forceRefresh: true }),
      second.resolve("credential-codex", { forceRefresh: true }),
    ]);

    expect(a.accessToken).toBe(tokenValue("forced-access"));
    expect(b.accessToken).toBe(tokenValue("forced-access"));
    expect(refreshCalls).toBe(1);
  });

  it("records rejected refreshes without overwriting the last usable token", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-codex-refresh-failure-"));
    const now = Date.UTC(2026, 6, 24, 0, 0, 0);
    const store = new CodexCredentialStore(root, {
      async refresh() {
        throw new CodexCredentialError(
          "codex_refresh_rejected",
          "Codex credential refresh was rejected.",
          true,
        );
      },
    }, () => now);
    await store.importBytes({
      id: "credential-codex",
      bytes: new TextEncoder().encode(authJson({
        expiresAt: new Date(now + 30_000).toISOString(),
      })),
    });

    await expect(store.resolve("credential-codex"))
      .rejects.toMatchObject({ code: "codex_refresh_rejected", authRequired: true });
    expect(await store.getStatus("credential-codex")).toMatchObject({
      lastRefresh: "failed",
      nearExpiry: true,
    });
    const saved = parseCodexAuthBytes(await readFile(
      join(root, "auth", "credential-codex.json"),
    ));
    expect(saved.accessToken).toBe(tokenValue("access"));
  });

  it("deletes only the InkOS managed copy and never removes an external reference", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "inkos-codex-delete-"));
    const external = join(fixture, "external-auth.json");
    const root = join(fixture, "registry");
    await writeFile(external, authJson());
    const store = new CodexCredentialStore(root);
    await store.importExternal({
      id: "credential-reference",
      filePath: external,
      mode: "reference",
    });
    expect(await store.delete("credential-reference")).toBe(true);
    expect(parseCodexAuthBytes(await readFile(external)).accessToken).toBe(tokenValue("access"));
  });

  it("rejects top-level token guesses instead of silently accepting an unknown variant", () => {
    expect(() => parseCodexAuthBytes(new TextEncoder().encode(JSON.stringify({
      access_token: tokenValue("access"),
    })))).toThrow(CodexCredentialError);
  });
});

function authJson(options: {
  readonly accountId?: string;
  readonly expiresAt?: string;
} = {}): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      access_token: tokenValue("access"),
      refresh_token: tokenValue("refresh"),
      account_id: options.accountId ?? "account-fixture-12345678",
      expires_at: options.expiresAt ?? "2099-01-01T00:00:00.000Z",
    },
  });
}

function tokenValue(label: string): string {
  return ["fixture", label, "credential"].join("-");
}
