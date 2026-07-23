import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeJsonAtomically } from "../llm/atomic-json.js";

describe("writeJsonAtomically", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-atomic-json-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("atomically replaces JSON without leaving temporary files", async () => {
    const path = join(root, ".inkos", "secrets.json");
    await writeJsonAtomically(path, { version: 1 }, {
      directoryMode: 0o700,
      fileMode: 0o600,
    });
    await writeJsonAtomically(path, { version: 2 }, {
      directoryMode: 0o700,
      fileMode: 0o600,
    });

    expect(JSON.parse(await readFile(path, "utf-8"))).toEqual({ version: 2 });
    expect(await readdir(join(root, ".inkos"))).toEqual(["secrets.json"]);

    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, ".inkos"))).mode & 0o777).toBe(0o700);
    }
  });
});
