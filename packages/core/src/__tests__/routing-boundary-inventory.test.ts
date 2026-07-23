import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("production model boundary inventory", () => {
  it("keeps every direct chatCompletion site classified", async () => {
    const files = await directCallFiles(/\bchatCompletion\(/);
    expect(files).toEqual([
      "agent/film-authoring-tools.ts",
      "agents/base.ts",
      "interaction/project-tools.ts",
      "interactive-film/generate.ts",
      "llm/provider.ts",
      "llm/providers/verify.ts",
      "pipeline/runner.ts",
      "translation/llm-model.ts",
    ]);
    const pipeline = await readFile(join(sourceRoot, "pipeline", "runner.ts"), "utf-8");
    expect(pipeline).toContain("this.routingRuntime.createRouteClient");
    const provider = await readFile(join(sourceRoot, "llm", "provider.ts"), "utf-8");
    expect(provider).toContain("client._routeRuntime.complete");
    const probe = await readFile(join(sourceRoot, "llm", "providers", "verify.ts"), "utf-8");
    expect(probe).toContain('modelGlobalPrompt: "disabled"');
  });

  it("keeps streamSimple only behind the explicit legacy Agent adapter", async () => {
    expect(await directCallFiles(/\bstreamSimple\(/)).toEqual([
      "agent/agent-session.ts",
    ]);
    const agent = await readFile(join(sourceRoot, "agent", "agent-session.ts"), "utf-8");
    expect(agent).toContain("if (route)");
    expect(agent).toContain("route.runtime.stream");
    expect(agent).toContain("return guardedStreamSimple");
  });
});

async function directCallFiles(pattern: RegExp): Promise<string[]> {
  const files = await walk(sourceRoot);
  const matching: string[] = [];
  for (const path of files) {
    if (path.includes(`${join("__tests__", "")}`)) continue;
    if (!path.endsWith(".ts")) continue;
    if (pattern.test(await readFile(path, "utf-8"))) {
      matching.push(relative(sourceRoot, path).replaceAll("\\", "/"));
    }
  }
  return matching.sort();
}

async function walk(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  }));
  return nested.flat();
}
