import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export async function writeJsonAtomically(
  path: string,
  value: unknown,
  options: {
    readonly directoryMode?: number;
    readonly fileMode?: number;
  } = {},
): Promise<void> {
  const directory = dirname(path);
  const fileMode = options.fileMode ?? 0o600;
  await mkdir(directory, {
    recursive: true,
    ...(options.directoryMode === undefined ? {} : { mode: options.directoryMode }),
  });
  if (options.directoryMode !== undefined) {
    await applyRestrictedMode(directory, options.directoryMode);
  }

  const temporaryPath = join(directory, `.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, "wx", fileMode);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await applyRestrictedMode(temporaryPath, fileMode);
    await rename(temporaryPath, path);
    await applyRestrictedMode(path, fileMode);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function applyRestrictedMode(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}
