import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadStudioTaskSnapshot,
  saveStudioTaskSnapshot,
  studioTaskSnapshotPath,
} from "./task-store.js";

describe("Studio task snapshots", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-studio-task-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("persists a running task so a refreshed Studio session can restore it", async () => {
    await saveStudioTaskSnapshot(root, {
      version: 1,
      sessionId: "session-1",
      requestedIntent: "short_run",
      updatedAt: 20,
      execution: {
        id: "task-1",
        tool: "short_fiction_run",
        label: "生成短篇",
        status: "running",
        startedAt: 10,
        logs: ["正在生成大纲"],
      },
    });

    await expect(loadStudioTaskSnapshot(root, "session-1")).resolves.toEqual({
      version: 1,
      sessionId: "session-1",
      requestedIntent: "short_run",
      updatedAt: 20,
      execution: {
        id: "task-1",
        tool: "short_fiction_run",
        label: "生成短篇",
        status: "running",
        startedAt: 10,
        logs: ["正在生成大纲"],
      },
    });
  });

  it("serializes overlapping progress writes and keeps the newest snapshot", async () => {
    const base = {
      version: 1 as const,
      sessionId: "session-2",
      requestedIntent: "script_create" as const,
      execution: {
        id: "task-2",
        tool: "script_create",
        label: "生成剧本",
        status: "running" as const,
        startedAt: 10,
      },
    };

    await Promise.all([
      saveStudioTaskSnapshot(root, { ...base, updatedAt: 20, execution: { ...base.execution, logs: ["第一步"] } }),
      saveStudioTaskSnapshot(root, { ...base, updatedAt: 30, execution: { ...base.execution, logs: ["第一步", "第二步"] } }),
    ]);

    await expect(loadStudioTaskSnapshot(root, "session-2")).resolves.toMatchObject({
      updatedAt: 30,
      execution: { logs: ["第一步", "第二步"] },
    });
  });

  it("persists the latest active backend and safe switch history across refresh", async () => {
    await saveStudioTaskSnapshot(root, {
      version: 1,
      sessionId: "session-routing",
      requestedIntent: "write_next",
      updatedAt: 30,
      execution: {
        id: "task-routing",
        tool: "sub_agent",
        agent: "writer",
        label: "写作",
        status: "completed",
        startedAt: 10,
        completedAt: 30,
        routingSummary: {
          logicalModelId: "route-ab",
          logicalModelDisplayName: "Writer",
          activeBackendId: "backend-b",
          retryCount: 1,
          lastEventAt: "2026-07-24T00:00:00.000Z",
          switches: [{
            eventId: "request-1:3",
            requestId: "request-1",
            type: "backend_switched",
            timestamp: "2026-07-24T00:00:00.000Z",
            logicalModelId: "route-ab",
            logicalModelDisplayName: "Writer",
            phase: "retry",
            fromBackendId: "backend-a",
            toBackendId: "backend-b",
            reason: "quota",
            retryCount: 1,
          }],
        },
      },
    });

    const restored = await loadStudioTaskSnapshot(root, "session-routing");
    expect(restored?.execution.routingSummary).toMatchObject({
      activeBackendId: "backend-b",
      retryCount: 1,
    });
    const serialized = await readFile(studioTaskSnapshotPath(root, "session-routing"), "utf-8");
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("Authorization");
  });

  it("treats a corrupt snapshot as unavailable instead of crashing session restore", async () => {
    const path = studioTaskSnapshotPath(root, "session-3");
    await saveStudioTaskSnapshot(root, {
      version: 1,
      sessionId: "session-3",
      requestedIntent: "short_run",
      updatedAt: 20,
      execution: {
        id: "task-3",
        tool: "short_fiction_run",
        label: "生成短篇",
        status: "running",
        startedAt: 10,
      },
    });
    await writeFile(path, "{broken", "utf-8");

    await expect(loadStudioTaskSnapshot(root, "session-3")).resolves.toBeNull();
    await expect(readFile(path, "utf-8")).resolves.toBe("{broken");
  });
});
