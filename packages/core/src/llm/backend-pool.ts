import type { BackendHealthFile, BackendHealthStore } from "./backend-health-store.js";
import { isBackendAvailable } from "./backend-health-store.js";
import type { CredentialResolver, ResolvedCredential } from "./credentials/index.js";
import type {
  BackendInstance,
  LogicalModelCandidate,
  LogicalModelRoute,
  ModelRoutingConfig,
} from "./model-routing.js";
import { resolveLogicalModelRoute } from "./model-routing.js";

export type CandidateSkipReason =
  | "disabled"
  | "duplicate_backend"
  | "missing_backend"
  | "already_attempted"
  | "health_unavailable"
  | "unsupported_credential_kind"
  | "credential_unavailable"
  | "model_unsupported";

export interface SkippedBackendCandidate {
  readonly backendId: string;
  readonly upstreamModelId: string;
  readonly reason: CandidateSkipReason;
}

export interface ResolvedBackendCandidate {
  readonly backend: BackendInstance;
  readonly candidate: LogicalModelCandidate;
  readonly credential: ResolvedCredential;
}

export interface BackendPoolResolution {
  readonly route: LogicalModelRoute;
  readonly candidates: ReadonlyArray<ResolvedBackendCandidate>;
  readonly skipped: ReadonlyArray<SkippedBackendCandidate>;
  readonly health: BackendHealthFile;
}

export interface BackendPoolOptions {
  readonly supportsModel?: (
    backend: BackendInstance,
    upstreamModelId: string,
  ) => boolean | Promise<boolean>;
  readonly now?: () => number;
}

export class BackendPool {
  private readonly supportsModel: NonNullable<BackendPoolOptions["supportsModel"]>;
  private readonly now: () => number;

  public constructor(
    private readonly routing: ModelRoutingConfig,
    private readonly credentials: CredentialResolver,
    private readonly healthStore: BackendHealthStore,
    options: BackendPoolOptions = {},
  ) {
    this.supportsModel = options.supportsModel ?? (() => true);
    this.now = options.now ?? Date.now;
  }

  public async resolve(
    routeId: string,
    attemptedBackendIds: ReadonlySet<string> = new Set(),
    signal?: AbortSignal,
  ): Promise<BackendPoolResolution> {
    const route = resolveLogicalModelRoute(this.routing, routeId);
    const health = await this.healthStore.read();
    const candidates: ResolvedBackendCandidate[] = [];
    const skipped: SkippedBackendCandidate[] = [];
    const seenBackendIds = new Set<string>();
    const backends = new Map(this.routing.backends.map((backend) => [backend.id, backend]));

    for (const candidate of route.candidates) {
      const backend = backends.get(candidate.backendId);
      const skip = await this.skipReason(
        backend,
        candidate,
        seenBackendIds,
        attemptedBackendIds,
        health,
      );
      seenBackendIds.add(candidate.backendId);
      if (skip) {
        skipped.push({
          backendId: candidate.backendId,
          upstreamModelId: candidate.upstreamModelId,
          reason: skip,
        });
        continue;
      }

      try {
        const credential = await this.credentials.resolve(
          backend!.credentialRef,
          { signal },
        );
        candidates.push({ backend: backend!, candidate, credential });
      } catch {
        skipped.push({
          backendId: candidate.backendId,
          upstreamModelId: candidate.upstreamModelId,
          reason: "credential_unavailable",
        });
      }
    }

    return { route, candidates, skipped, health };
  }

  private async skipReason(
    backend: BackendInstance | undefined,
    candidate: LogicalModelCandidate,
    seenBackendIds: ReadonlySet<string>,
    attemptedBackendIds: ReadonlySet<string>,
    health: BackendHealthFile,
  ): Promise<CandidateSkipReason | undefined> {
    if (!backend) return "missing_backend";
    if (!backend.enabled) return "disabled";
    if (seenBackendIds.has(backend.id)) return "duplicate_backend";
    if (attemptedBackendIds.has(backend.id)) return "already_attempted";
    if (!isBackendAvailable(health.backends[backend.id], this.now())) {
      return "health_unavailable";
    }
    if (backend.credentialRef.kind !== "api_key" && backend.credentialRef.kind !== "codex") {
      return "unsupported_credential_kind";
    }
    if (!await this.supportsModel(backend, candidate.upstreamModelId)) {
      return "model_unsupported";
    }
    return undefined;
  }
}
