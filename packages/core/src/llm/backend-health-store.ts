import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { writeJsonAtomically } from "./atomic-json.js";

export const BACKEND_HEALTH_SCHEMA_VERSION = 1 as const;
export const BACKEND_HEALTH_RELATIVE_PATH = join(".inkos", "backend-health.json");

export const BackendHealthStatusSchema = z.enum([
  "healthy",
  "temporary_cooldown",
  "quota_exhausted",
  "auth_required",
  "disabled",
  "unknown",
]);

const BackendProbeResultSchema = z.object({
  at: z.string().datetime(),
  outcome: z.enum(["success", "failure"]),
  reason: z.string().min(1).max(160).optional(),
}).strict();

const BackendHealthRecordSchema = z.object({
  backendId: z.string().min(1),
  status: BackendHealthStatusSchema,
  lastSuccessAt: z.string().datetime().optional(),
  lastFailureAt: z.string().datetime().optional(),
  consecutiveFailures: z.number().int().min(0),
  cooldownReason: z.string().min(1).max(160).optional(),
  cooldownUntil: z.string().datetime().optional(),
  recoveryCondition: z.enum(["cooldown_elapsed", "manual_reset_or_probe"]).optional(),
  lastProbe: BackendProbeResultSchema.optional(),
}).strict();

const RouteHealthRecordSchema = z.object({
  routeId: z.string().min(1),
  activeBackendId: z.string().min(1).optional(),
  updatedAt: z.string().datetime(),
}).strict();

export const BackendHealthFileSchema = z.object({
  version: z.literal(BACKEND_HEALTH_SCHEMA_VERSION),
  revision: z.number().int().min(0),
  backends: z.record(BackendHealthRecordSchema),
  routes: z.record(RouteHealthRecordSchema),
}).strict();

export type BackendHealthStatus = z.infer<typeof BackendHealthStatusSchema>;
export type BackendProbeResult = z.infer<typeof BackendProbeResultSchema>;
export type BackendHealthRecord = z.infer<typeof BackendHealthRecordSchema>;
export type RouteHealthRecord = z.infer<typeof RouteHealthRecordSchema>;
export type BackendHealthFile = z.infer<typeof BackendHealthFileSchema>;

export interface BackendFailureUpdate {
  readonly backendId: string;
  readonly status: BackendHealthStatus;
  readonly reason: string;
  readonly at?: number;
  readonly cooldownUntil?: number;
}

export interface BackendProbeUpdate {
  readonly backendId: string;
  readonly outcome: "success" | "failure";
  readonly reason?: string;
  readonly at?: number;
}

export interface BackendHealthStore {
  read(): Promise<BackendHealthFile>;
  recordFailure(update: BackendFailureUpdate): Promise<BackendHealthRecord>;
  recordSuccess(routeId: string, backendId: string, at?: number): Promise<BackendHealthRecord>;
  reset(backendId: string, at?: number): Promise<BackendHealthRecord>;
  recordProbe(update: BackendProbeUpdate): Promise<BackendHealthRecord>;
}

type HealthFileWriter = (path: string, value: BackendHealthFile) => Promise<void>;

const fileMutationQueues = new Map<string, Promise<void>>();

export function backendHealthFilePath(projectRoot: string): string {
  return join(projectRoot, BACKEND_HEALTH_RELATIVE_PATH);
}

export function createEmptyBackendHealthFile(): BackendHealthFile {
  return {
    version: BACKEND_HEALTH_SCHEMA_VERSION,
    revision: 0,
    backends: {},
    routes: {},
  };
}

export function isBackendAvailable(
  record: BackendHealthRecord | undefined,
  now = Date.now(),
): boolean {
  if (!record) return true;
  switch (record.status) {
    case "healthy":
    case "unknown":
      return true;
    case "temporary_cooldown":
      return Boolean(record.cooldownUntil && Date.parse(record.cooldownUntil) <= now);
    case "quota_exhausted":
    case "auth_required":
    case "disabled":
      return false;
  }
}

export class FileBackendHealthStore implements BackendHealthStore {
  public readonly path: string;

  public constructor(
    projectRootOrPath: string,
    options: {
      readonly exactPath?: boolean;
      readonly writer?: HealthFileWriter;
    } = {},
  ) {
    this.path = resolve(
      options.exactPath
        ? projectRootOrPath
        : backendHealthFilePath(projectRootOrPath),
    );
    this.writeFile = options.writer ?? defaultHealthFileWriter;
  }

  private readonly writeFile: HealthFileWriter;

  public async read(): Promise<BackendHealthFile> {
    return serializeHealthFile(this.path, () => this.readUnlocked());
  }

  public async recordFailure(update: BackendFailureUpdate): Promise<BackendHealthRecord> {
    return this.update((current) => {
      const at = toIsoTime(update.at);
      const previous = current.backends[update.backendId];
      const next: BackendHealthRecord = {
        backendId: update.backendId,
        status: update.status,
        ...(previous?.lastSuccessAt ? { lastSuccessAt: previous.lastSuccessAt } : {}),
        lastFailureAt: at,
        consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
        cooldownReason: sanitizeReason(update.reason),
        ...(update.cooldownUntil !== undefined
          ? { cooldownUntil: toIsoTime(update.cooldownUntil) }
          : {}),
        ...(update.status === "temporary_cooldown"
          ? { recoveryCondition: "cooldown_elapsed" as const }
          : update.status === "quota_exhausted" || update.status === "auth_required"
            ? { recoveryCondition: "manual_reset_or_probe" as const }
            : {}),
        ...(previous?.lastProbe ? { lastProbe: previous.lastProbe } : {}),
      };
      current.backends[update.backendId] = next;
      return next;
    });
  }

  public async recordSuccess(
    routeId: string,
    backendId: string,
    at = Date.now(),
  ): Promise<BackendHealthRecord> {
    return this.update((current) => {
      const timestamp = toIsoTime(at);
      const previous = current.backends[backendId];
      const next: BackendHealthRecord = {
        backendId,
        status: "healthy",
        lastSuccessAt: timestamp,
        ...(previous?.lastFailureAt ? { lastFailureAt: previous.lastFailureAt } : {}),
        consecutiveFailures: 0,
        ...(previous?.lastProbe ? { lastProbe: previous.lastProbe } : {}),
      };
      current.backends[backendId] = next;
      current.routes[routeId] = {
        routeId,
        activeBackendId: backendId,
        updatedAt: timestamp,
      };
      return next;
    });
  }

  public async reset(backendId: string, at = Date.now()): Promise<BackendHealthRecord> {
    return this.update((current) => {
      const previous = current.backends[backendId];
      const next: BackendHealthRecord = {
        backendId,
        status: "unknown",
        ...(previous?.lastSuccessAt ? { lastSuccessAt: previous.lastSuccessAt } : {}),
        ...(previous?.lastFailureAt ? { lastFailureAt: previous.lastFailureAt } : {}),
        consecutiveFailures: 0,
        lastProbe: {
          at: toIsoTime(at),
          outcome: "success",
          reason: "manual_reset",
        },
      };
      current.backends[backendId] = next;
      return next;
    });
  }

  public async recordProbe(update: BackendProbeUpdate): Promise<BackendHealthRecord> {
    return this.update((current) => {
      const previous = current.backends[update.backendId];
      const at = toIsoTime(update.at);
      const lastProbe: BackendProbeResult = {
        at,
        outcome: update.outcome,
        ...(update.reason ? { reason: sanitizeReason(update.reason) } : {}),
      };
      const next: BackendHealthRecord = update.outcome === "success"
        ? {
            backendId: update.backendId,
            status: "healthy",
            lastSuccessAt: at,
            ...(previous?.lastFailureAt ? { lastFailureAt: previous.lastFailureAt } : {}),
            consecutiveFailures: 0,
            lastProbe,
          }
        : {
            backendId: update.backendId,
            status: previous?.status ?? "unknown",
            ...(previous?.lastSuccessAt ? { lastSuccessAt: previous.lastSuccessAt } : {}),
            lastFailureAt: at,
            consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
            ...(previous?.cooldownReason ? { cooldownReason: previous.cooldownReason } : {}),
            ...(previous?.cooldownUntil ? { cooldownUntil: previous.cooldownUntil } : {}),
            ...(previous?.recoveryCondition ? { recoveryCondition: previous.recoveryCondition } : {}),
            lastProbe,
          };
      current.backends[update.backendId] = next;
      return next;
    });
  }

  private async update<T>(
    mutate: (current: BackendHealthFile) => T,
  ): Promise<T> {
    return serializeHealthFile(this.path, async () => {
      const current = await this.readUnlocked();
      const mutable: BackendHealthFile = structuredClone(current);
      const result = mutate(mutable);
      const next = BackendHealthFileSchema.parse({
        ...mutable,
        revision: current.revision + 1,
      });
      await this.writeFile(this.path, next);
      return result;
    });
  }

  private async readUnlocked(): Promise<BackendHealthFile> {
    try {
      const raw = await readFile(this.path, "utf-8");
      return BackendHealthFileSchema.parse(JSON.parse(raw));
    } catch (error) {
      if (isMissingFile(error)) return createEmptyBackendHealthFile();
      throw new Error("Backend health file is invalid and was not modified.", { cause: error });
    }
  }
}

async function defaultHealthFileWriter(path: string, value: BackendHealthFile): Promise<void> {
  await writeJsonAtomically(path, value, {
    directoryMode: 0o700,
    fileMode: 0o600,
  });
}

function serializeHealthFile<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = fileMutationQueues.get(path) ?? Promise.resolve();
  const run = previous.then(operation, operation);
  const settled = run.then(() => undefined, () => undefined);
  fileMutationQueues.set(path, settled);
  return run.finally(() => {
    if (fileMutationQueues.get(path) === settled) {
      fileMutationQueues.delete(path);
    }
  });
}

function sanitizeReason(reason: string): string {
  return reason
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b(api[_ -]?key|token|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\b(?:sk|key|token|xai)-[A-Za-z0-9._-]{8,}\b/gi, "[REDACTED]")
    .replace(/\b(?:AIza[0-9A-Za-z_-]{20,}|(?:ghp|gsk|sk_live)_[A-Za-z0-9_-]{16,})\b/g, "[REDACTED]")
    .replace(/[\r\n\t]/g, " ")
    .trim()
    .slice(0, 160) || "unknown";
}

function toIsoTime(value = Date.now()): string {
  return new Date(value).toISOString();
}

function isMissingFile(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && error.code === "ENOENT",
  );
}
