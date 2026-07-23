import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CredentialResolver,
  ProjectApiKeyCredentialProvider,
  createProjectCredentialResolver,
} from "../llm/credentials/index.js";
import { saveSecrets } from "../llm/secrets.js";

describe("project credential resolver", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-credential-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("resolves project API keys by stable credential id", async () => {
    await saveSecrets(root, {
      services: { moonshot: { apiKey: "fixture-project-key" } },
      credentials: {
        "credential-moonshot": {
          kind: "api_key",
          apiKey: "fixture-project-key",
          legacyServiceId: "moonshot",
        },
      },
    });

    const resolver = createProjectCredentialResolver(root);

    await expect(resolver.resolve({
      id: "credential-moonshot",
      kind: "api_key",
    })).resolves.toEqual({
      kind: "api_key",
      apiKey: "fixture-project-key",
    });
  });

  it("returns non-secret errors for missing and unsupported credentials", async () => {
    const resolver = new CredentialResolver([
      new ProjectApiKeyCredentialProvider(root),
    ]);

    await expect(resolver.resolve({
      id: "credential-missing",
      kind: "api_key",
    })).rejects.toThrow('API key credential "credential-missing" is not configured');
    await expect(resolver.resolve({
      id: "credential-codex",
      kind: "codex",
    })).rejects.toThrow('Credential kind "codex" is not supported');
  });
});
