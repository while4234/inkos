import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { migrateConfig, writeProjectConfigWithRouting } from "../llm/config-migration.js";
import { loadSecrets } from "../llm/secrets.js";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("config migration", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-migrate-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("migrates old llm.provider+model+apiKey to services[] + secrets", async () => {
    const oldConfig = {
      name: "mybook",
      llm: {
        provider: "openai",
        model: "kimi-k2.5",
        baseUrl: "https://api.moonshot.cn/v1",
        apiKey: "sk-old-key",
      },
      language: "zh",
    };
    await writeFile(join(root, "inkos.json"), JSON.stringify(oldConfig));

    const result = await migrateConfig(root);

    expect(result.migrated).toBe(true);

    const raw = await readFile(join(root, "inkos.json"), "utf-8");
    const config = JSON.parse(raw);
    expect(config.llm.services).toHaveLength(1);
    expect(config.llm.services[0].service).toBe("moonshot");
    expect(config.llm.services[0].apiKey).toBeUndefined();
    expect(config.llm.defaultModel).toBe("kimi-k2.5");
    expect(config.llm.provider).toBeUndefined();
    expect(config.llm.model).toBeUndefined();
    expect(config.llm.apiKey).toBeUndefined();

    const secrets = await loadSecrets(root);
    expect(secrets.services.moonshot.apiKey).toBe("sk-old-key");
    const credentialId = config.llm.routing.credentials[0].id;
    expect(secrets.credentials?.[credentialId]).toMatchObject({
      kind: "api_key",
      apiKey: "sk-old-key",
      legacyServiceId: "moonshot",
    });
    expect(config.llm.routing).toMatchObject({
      version: 1,
      defaultRouteId: expect.stringMatching(/^route-/),
    });
    expect(config.llm.routing.backends[0]).not.toHaveProperty("apiKey");
  });

  it("adds routing to the existing services format without changing its selection", async () => {
    const newConfig = {
      name: "mybook",
      llm: {
        services: [{ service: "moonshot" }],
        defaultModel: "kimi-k2.5",
      },
      language: "zh",
    };
    await writeFile(join(root, "inkos.json"), JSON.stringify(newConfig));

    const result = await migrateConfig(root);
    expect(result).toMatchObject({ migrated: true, routingCreated: true });
    const config = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8"));
    expect(config.llm.services).toEqual([{ service: "moonshot" }]);
    expect(config.llm.defaultModel).toBe("kimi-k2.5");
    expect(config.llm.routing.routes[0].candidates[0].upstreamModelId).toBe("kimi-k2.5");
  });

  it("guesses service from baseUrl", async () => {
    const oldConfig = {
      llm: {
        provider: "openai",
        model: "deepseek-chat",
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "sk-deep",
      },
    };
    await writeFile(join(root, "inkos.json"), JSON.stringify(oldConfig));

    await migrateConfig(root);

    const raw = await readFile(join(root, "inkos.json"), "utf-8");
    const config = JSON.parse(raw);
    expect(config.llm.services[0].service).toBe("deepseek");
  });

  it("creates custom service when baseUrl is unrecognized", async () => {
    const oldConfig = {
      llm: {
        provider: "openai",
        model: "my-model",
        baseUrl: "https://llm.internal.corp/v1",
        apiKey: "sk-corp",
      },
    };
    await writeFile(join(root, "inkos.json"), JSON.stringify(oldConfig));

    await migrateConfig(root);

    const raw = await readFile(join(root, "inkos.json"), "utf-8");
    const config = JSON.parse(raw);
    expect(config.llm.services[0].service).toBe("custom");
    expect(config.llm.services[0].baseUrl).toBe("https://llm.internal.corp/v1");
    expect(config.llm.services[0].name).toBe("Custom");
  });

  it("migrates all service backends while preserving the selected service and model", async () => {
    await writeFile(join(root, "inkos.json"), JSON.stringify({
      name: "multi-service",
      llm: {
        configSource: "studio",
        service: "google",
        services: [{ service: "google" }, { service: "moonshot" }],
        defaultModel: "gemini-2.5-flash",
      },
    }));
    await mkdir(join(root, ".inkos"), { recursive: true });
    await writeFile(join(root, ".inkos", "secrets.json"), JSON.stringify({
      services: {
        google: { apiKey: "fixture-google-key" },
        moonshot: { apiKey: "fixture-moonshot-key" },
      },
    }));

    await migrateConfig(root);

    const config = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8"));
    expect(config.llm.service).toBe("google");
    expect(config.llm.defaultModel).toBe("gemini-2.5-flash");
    expect(config.llm.services).toHaveLength(2);
    expect(config.llm.routing.backends.map((backend: { service: string }) => backend.service))
      .toEqual(["google", "moonshot"]);
    expect(config.llm.routing.routes[0].candidates[0].upstreamModelId)
      .toBe("gemini-2.5-flash");

    const secrets = await loadSecrets(root);
    expect(Object.values(secrets.credentials ?? {})).toEqual(expect.arrayContaining([
      expect.objectContaining({ legacyServiceId: "google" }),
      expect.objectContaining({ legacyServiceId: "moonshot" }),
    ]));
  });

  it("is idempotent across repeated loads", async () => {
    await writeFile(join(root, "inkos.json"), JSON.stringify({
      name: "repeatable",
      llm: {
        provider: "openai",
        model: "deepseek-chat",
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "fixture-repeat-key",
      },
    }));

    const first = await migrateConfig(root);
    const firstConfig = await readFile(join(root, "inkos.json"), "utf-8");
    const firstSecrets = await readFile(join(root, ".inkos", "secrets.json"), "utf-8");
    const second = await migrateConfig(root);

    expect(first.migrated).toBe(true);
    expect(second.migrated).toBe(false);
    expect(await readFile(join(root, "inkos.json"), "utf-8")).toBe(firstConfig);
    expect(await readFile(join(root, ".inkos", "secrets.json"), "utf-8")).toBe(firstSecrets);
  });

  it("restores the original secrets when the config commit fails", async () => {
    const originalConfig = {
      name: "rollback",
      llm: {
        provider: "openai",
        model: "deepseek-chat",
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "fixture-rollback-key",
      },
    };
    await writeFile(join(root, "inkos.json"), JSON.stringify(originalConfig));

    await expect(migrateConfig(root, {
      writeConfig: async () => {
        throw new Error("simulated config write failure");
      },
    })).rejects.toThrow("simulated config write failure");

    expect(JSON.parse(await readFile(join(root, "inkos.json"), "utf-8"))).toEqual(originalConfig);
    expect(await loadSecrets(root, { strict: true })).toEqual({ services: {} });
  });

  it("fails closed without overwriting a malformed secrets file", async () => {
    await writeFile(join(root, "inkos.json"), JSON.stringify({
      llm: {
        provider: "openai",
        model: "deepseek-chat",
        baseUrl: "https://api.deepseek.com/v1",
      },
    }));
    await mkdir(join(root, ".inkos"), { recursive: true });
    const malformed = "{\"services\":";
    await writeFile(join(root, ".inkos", "secrets.json"), malformed);

    await expect(migrateConfig(root)).rejects.toThrow(/secrets file is invalid/i);
    expect(await readFile(join(root, ".inkos", "secrets.json"), "utf-8")).toBe(malformed);
  });

  it("moves an inline key written by a legacy client into an existing route credential", async () => {
    await writeFile(join(root, "inkos.json"), JSON.stringify({
      name: "legacy-writer",
      llm: {
        provider: "openai",
        model: "deepseek-chat",
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "fixture-first-key",
      },
    }));
    await migrateConfig(root);

    const configPath = join(root, "inkos.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.llm.apiKey = "fixture-updated-key";
    await writeFile(configPath, JSON.stringify(config));

    await migrateConfig(root);

    const migrated = await readFile(configPath, "utf-8");
    const secrets = await loadSecrets(root, { strict: true });
    const credentialId = config.llm.routing.backends[0].credentialRef.id;
    expect(migrated).not.toContain("fixture-updated-key");
    expect(secrets.services.deepseek.apiKey).toBe("fixture-updated-key");
    expect(secrets.credentials?.[credentialId]?.apiKey).toBe("fixture-updated-key");
  });

  it("keeps legacy config writers synchronized with the routing default", async () => {
    await writeFile(join(root, "inkos.json"), JSON.stringify({
      name: "legacy-writer-sync",
      llm: {
        service: "moonshot",
        services: [{ service: "moonshot" }, { service: "deepseek" }],
        defaultModel: "kimi-k2.5",
      },
    }));
    await migrateConfig(root);

    const configPath = join(root, "inkos.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.llm.routing.routes.push({
      id: "route-user-preserved",
      displayName: "User route",
      promptFamily: "generic",
      enabled: true,
      candidates: [{
        backendId: config.llm.routing.backends[0].id,
        upstreamModelId: "user-model",
      }],
    });
    config.llm.service = "deepseek";
    config.llm.defaultModel = "deepseek-reasoner";

    await writeProjectConfigWithRouting(root, config);

    const saved = JSON.parse(await readFile(configPath, "utf-8"));
    const selectedRoute = saved.llm.routing.routes.find(
      (route: { id: string }) => route.id === saved.llm.routing.defaultRouteId,
    );
    const selectedBackend = saved.llm.routing.backends.find(
      (backend: { id: string }) => backend.id === selectedRoute.candidates[0].backendId,
    );
    expect(selectedBackend.service).toBe("deepseek");
    expect(selectedRoute.candidates[0].upstreamModelId).toBe("deepseek-reasoner");
    expect(saved.llm.routing.routes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "route-user-preserved" }),
    ]));
  });
});
