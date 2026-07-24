import { describe, expect, it } from "vitest";
import {
  ModelRoutingConfigSchema,
  resolveLogicalModelRoute,
} from "../llm/model-routing.js";
import { ProjectConfigSchema } from "../models/project.js";

function validRouting() {
  return {
    version: 1 as const,
    credentials: [{
      id: "credential-primary",
      kind: "api_key" as const,
      label: "Primary API Key",
      scope: "project" as const,
    }],
    backends: [{
      id: "backend-primary",
      displayName: "Primary",
      service: "custom:Primary",
      provider: "custom" as const,
      baseUrl: "https://llm.example.test/v1",
      credentialRef: {
        id: "credential-primary",
        kind: "api_key" as const,
      },
      enabled: true,
      transport: {
        apiFormat: "chat" as const,
        stream: true,
      },
    }],
    routes: [{
      id: "route-primary",
      displayName: "logical-writer",
      promptFamily: "generic",
      enabled: true,
      candidates: [{
        backendId: "backend-primary",
        upstreamModelId: "upstream-writer",
      }],
    }],
    modelGlobalPrompts: {},
    defaultRouteId: "route-primary",
  };
}

describe("ModelRoutingConfigSchema", () => {
  it("accepts an onboarding graph before the first logical route exists", () => {
    expect(ModelRoutingConfigSchema.parse({
      version: 1,
      credentials: [],
      backends: [],
      routes: [],
      modelGlobalPrompts: {},
      defaultRouteId: null,
    })).toEqual({
      version: 1,
      credentials: [],
      backends: [],
      routes: [],
      modelGlobalPrompts: {},
      defaultRouteId: null,
    });
  });

  it("requires a default as soon as a logical route exists", () => {
    const routing = validRouting();

    const result = ModelRoutingConfigSchema.safeParse({
      ...routing,
      defaultRouteId: null,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toContain("defaultRouteId");
    }
  });

  it.each(["gpt", "grok", "deepseek", "none"] as const)(
    "accepts the explicit %s prompt family",
    (family) => {
      const routing = validRouting();
      routing.routes[0]!.promptFamily = family;
      expect(ModelRoutingConfigSchema.parse(routing).routes[0]?.promptFamily).toBe(family);
    },
  );

  it("rejects an unregistered prompt family", () => {
    const routing = validRouting();
    routing.routes[0]!.promptFamily = "mystery";
    expect(ModelRoutingConfigSchema.safeParse(routing).success).toBe(false);
  });

  it("persists bounded project prompts by model family", () => {
    const routing = validRouting();
    Object.assign(routing.modelGlobalPrompts, {
      gpt: {
        text: "Keep names, chronology, and established facts consistent.",
        revision: 2,
      },
    });

    expect(ModelRoutingConfigSchema.parse(routing).modelGlobalPrompts.gpt)
      .toEqual({
        text: "Keep names, chronology, and established facts consistent.",
        revision: 2,
      });
    Object.assign(routing.modelGlobalPrompts, {
      gpt: { text: "", revision: 3 },
    });
    expect(ModelRoutingConfigSchema.safeParse(routing).success).toBe(false);
  });

  it("migrates a legacy route prompt to its model family", () => {
    const routing = validRouting();
    delete (routing as { modelGlobalPrompts?: unknown }).modelGlobalPrompts;
    Object.assign(routing.routes[0]!, {
      promptFamily: "gpt",
      globalPrompt: {
        text: "Preserve the existing project canon.",
        revision: 4,
      },
    });

    const parsed = ModelRoutingConfigSchema.parse(routing);

    expect(parsed.modelGlobalPrompts.gpt).toEqual({
      text: "Preserve the existing project canon.",
      revision: 4,
    });
    expect(parsed.routes[0]).not.toHaveProperty("globalPrompt");
  });

  it("parses a normalized graph and preserves candidate order", () => {
    const routing = validRouting();
    routing.routes[0]!.candidates.push({
      backendId: "backend-primary",
      upstreamModelId: "upstream-fallback",
    });

    const parsed = ModelRoutingConfigSchema.parse(routing);

    expect(parsed.routes[0]!.candidates.map((candidate) => candidate.upstreamModelId))
      .toEqual(["upstream-writer", "upstream-fallback"]);
    expect(resolveLogicalModelRoute(parsed, "route-primary").displayName)
      .toBe("logical-writer");
  });

  it.each([
    {
      name: "duplicate credential ids",
      mutate: (routing: ReturnType<typeof validRouting>) => {
        routing.credentials.push({ ...routing.credentials[0]! });
      },
      path: "credentials.1.id",
    },
    {
      name: "dangling credentials",
      mutate: (routing: ReturnType<typeof validRouting>) => {
        routing.backends[0]!.credentialRef.id = "credential-missing";
      },
      path: "backends.0.credentialRef.id",
    },
    {
      name: "dangling backends",
      mutate: (routing: ReturnType<typeof validRouting>) => {
        routing.routes[0]!.candidates[0]!.backendId = "backend-missing";
      },
      path: "routes.0.candidates.0.backendId",
    },
    {
      name: "empty candidate lists",
      mutate: (routing: ReturnType<typeof validRouting>) => {
        routing.routes[0]!.candidates = [];
      },
      path: "routes.0.candidates",
    },
    {
      name: "disabled defaults",
      mutate: (routing: ReturnType<typeof validRouting>) => {
        routing.routes[0]!.enabled = false;
      },
      path: "defaultRouteId",
    },
  ])("rejects $name with a field-localized error", ({ mutate, path }) => {
    const routing = validRouting();
    mutate(routing);

    const result = ModelRoutingConfigSchema.safeParse(routing);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toContain(path);
    }
  });

  it("accepts route references alongside legacy model override forms", () => {
    const parsed = ProjectConfigSchema.parse({
      name: "override-project",
      version: "0.1.0",
      llm: {
        provider: "custom",
        service: "custom",
        configSource: "studio",
        baseUrl: "https://llm.example.test/v1",
        apiKey: "",
        model: "upstream-writer",
        routing: validRouting(),
      },
      modelOverrides: {
        writer: { routeId: "route-primary" },
        auditor: "legacy-auditor-model",
        reviser: {
          model: "legacy-reviser-model",
          baseUrl: "https://legacy.example.test/v1",
        },
      },
    });

    expect(parsed.modelOverrides).toEqual({
      writer: { routeId: "route-primary" },
      auditor: "legacy-auditor-model",
      reviser: {
        model: "legacy-reviser-model",
        baseUrl: "https://legacy.example.test/v1",
      },
    });
    expect(JSON.parse(JSON.stringify(parsed)).modelOverrides.writer)
      .toEqual({ routeId: "route-primary" });
  });

  it("rejects route overrides that reference a missing route", () => {
    const result = ProjectConfigSchema.safeParse({
      name: "dangling-override",
      version: "0.1.0",
      llm: {
        provider: "custom",
        baseUrl: "https://llm.example.test/v1",
        model: "upstream-writer",
        routing: validRouting(),
      },
      modelOverrides: {
        writer: { routeId: "route-missing" },
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join(".")))
        .toContain("modelOverrides.writer.routeId");
    }
  });
});
