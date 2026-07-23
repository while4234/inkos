import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileBackendHealthStore,
  backendHealthFilePath,
  isBackendAvailable,
} from "../llm/backend-health-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "inkos-backend-health-"));
  roots.push(root);
  return root;
}

describe("FileBackendHealthStore", () => {
  it("serializes concurrent updates across store instances without lost writes", async () => {
    const root = await tempRoot();
    const first = new FileBackendHealthStore(root);
    const second = new FileBackendHealthStore(root);

    await Promise.all(Array.from({ length: 24 }, (_, index) => (
      (index % 2 === 0 ? first : second).recordFailure({
        backendId: "backend-a",
        status: "temporary_cooldown",
        reason: "network",
        at: 1_000 + index,
        cooldownUntil: 60_000,
      })
    )));

    const snapshot = await first.read();
    expect(snapshot.revision).toBe(24);
    expect(snapshot.backends["backend-a"]).toMatchObject({
      status: "temporary_cooldown",
      consecutiveFailures: 24,
      cooldownReason: "network",
    });
    expect(JSON.parse(await readFile(backendHealthFilePath(root), "utf-8"))).toEqual(snapshot);
  });

  it("persists active backend, permanent failures, reset, probe, and cooldown expiry", async () => {
    const root = await tempRoot();
    const store = new FileBackendHealthStore(root);

    await store.recordFailure({
      backendId: "backend-a",
      status: "quota_exhausted",
      reason: "quota",
      at: 1_000,
    });
    let snapshot = await store.read();
    expect(isBackendAvailable(snapshot.backends["backend-a"], 10_000)).toBe(false);

    await store.reset("backend-a", 2_000);
    snapshot = await store.read();
    expect(isBackendAvailable(snapshot.backends["backend-a"], 2_000)).toBe(true);

    await store.recordFailure({
      backendId: "backend-a",
      status: "temporary_cooldown",
      reason: "rate_limit",
      at: 3_000,
      cooldownUntil: 5_000,
    });
    snapshot = await store.read();
    expect(isBackendAvailable(snapshot.backends["backend-a"], 4_999)).toBe(false);
    expect(isBackendAvailable(snapshot.backends["backend-a"], 5_000)).toBe(true);

    await store.recordProbe({
      backendId: "backend-a",
      outcome: "success",
      reason: "manual_probe",
      at: 6_000,
    });
    await store.recordSuccess("route-main", "backend-a", 7_000);
    snapshot = await store.read();
    expect(snapshot.backends["backend-a"]).toMatchObject({
      status: "healthy",
      consecutiveFailures: 0,
      lastSuccessAt: new Date(7_000).toISOString(),
    });
    expect(snapshot.routes["route-main"]).toMatchObject({
      activeBackendId: "backend-a",
    });
  });

  it("keeps the previous file parseable when an atomic write dependency fails", async () => {
    const root = await tempRoot();
    const healthyStore = new FileBackendHealthStore(root);
    await healthyStore.recordSuccess("route-main", "backend-a", 1_000);
    const before = JSON.parse(await readFile(backendHealthFilePath(root), "utf-8"));
    const failingStore = new FileBackendHealthStore(
      backendHealthFilePath(root),
      {
        exactPath: true,
        writer: async () => {
          throw new Error("simulated write failure");
        },
      },
    );

    await expect(failingStore.recordFailure({
      backendId: "backend-a",
      status: "quota_exhausted",
      reason: "quota",
      at: 2_000,
    })).rejects.toThrow("simulated write failure");

    const after = JSON.parse(await readFile(backendHealthFilePath(root), "utf-8"));
    expect(after).toEqual(before);
    expect(await healthyStore.read()).toEqual(before);
  });

  it("never persists credentials embedded in failure or probe reasons", async () => {
    const root = await tempRoot();
    const store = new FileBackendHealthStore(root);
    const rawSecret = "sk-fixture-health-store-secret";

    await store.recordFailure({
      backendId: "backend-a",
      status: "auth_required",
      reason: `Authorization: Bearer ${rawSecret}`,
      at: 1_000,
    });
    await store.recordProbe({
      backendId: "backend-a",
      outcome: "failure",
      reason: `api_key=${rawSecret}`,
      at: 2_000,
    });

    const serialized = await readFile(backendHealthFilePath(root), "utf-8");
    expect(serialized).not.toContain(rawSecret);
    expect(serialized).not.toContain("Bearer sk-");
    expect(serialized).toContain("[REDACTED]");
  });
});
