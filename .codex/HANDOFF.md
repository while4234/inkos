# Project Handoff

Last updated: 2026-07-23 23:04 CST
Project root: D:\lnkos
Pipeline: `model-continuity-p0`
Position: PR-01 accepted on `feature/model-continuity-pr01`; delivery target is `origin/master`

## Current Goal

Deliver PR-01 through PR-09 serially. Each PR uses a different implementation agent, receives full acceptance validation, then becomes one atomic fast-forward commit on `origin/master` before the next PR starts.

## Current Position

PR-01 establishes the versioned routing schema, stable credential/backend/route identities, project API-key credential resolution, atomic migration, legacy config compatibility, and route-aware model overrides. Its implementation and acceptance gates are complete. The pipeline state under `.codex/pr-pipeline/` is intentionally local-only and records the pushed SHA after remote verification.

## Recent Actions

- Added versioned routing models and public Core exports for credentials, backend instances, logical routes, candidates, and resolvers.
- Integrated idempotent migration into normal project loading, with atomic config/secret writes and rollback on partial failure.
- Preserved old single-service, multi-service, string override, object override, CLI, and Studio write paths through compatibility adapters.
- Changed Studio service and cover secret reads to return configured/masked status instead of complete API keys.
- Added a six-second cancellation budget to CLI doctor connectivity probing so the Windows integration test completes within its process deadline.
- Added focused migration, routing, secret, resolver, pipeline, Studio, and CLI regression coverage.

## Changed / Relevant Files

- `packages/core/src/llm/model-routing.ts`
- `packages/core/src/llm/credentials/index.ts`
- `packages/core/src/llm/atomic-json.ts`
- `packages/core/src/llm/config-migration.ts`
- `packages/core/src/llm/secrets.ts`
- `packages/core/src/models/project.ts`
- `packages/core/src/utils/config-loader.ts`
- `packages/core/src/utils/effective-llm-config.ts`
- `packages/core/src/pipeline/runner.ts`
- `packages/cli/src/commands/config.ts`
- `packages/cli/src/commands/doctor.ts`
- `packages/studio/src/api/server.ts`
- `packages/studio/src/pages/ServiceDetailPage.tsx`
- `packages/studio/src/pages/ServiceListPage.tsx`
- `packages/studio/src/pages/service-detail-state.ts`
- `MODEL_ROUTING.md` and localized README routing links

## Validation

- `corepack pnpm@9.15.9 install --frozen-lockfile` -> passed.
- Root `build` and `typecheck` -> passed after final changes.
- Root `test` -> passed: Core 184 files / 1781 tests; Studio 58 files / 549 tests; CLI 41 files / 229 tests.
- `verify:publish-manifests` -> passed for Core, CLI, and Studio.
- Focused Core routing/migration/secret/pipeline tests -> 119 passed.
- Focused Studio server/service-secret tests -> 156 passed.
- `git diff --check` -> passed; line-ending conversion warnings only.
- Diff path and credential scans -> no runtime content, pipeline state, Authorization header, bearer token, or complete credential additions.

## Blockers / Risks

- No PR-01 blocker remains.
- Cross-backend route execution is intentionally rejected until PR-03; PR-01 only resolves route overrides on the current backend.
- Existing legacy fields remain during the compatibility window and must not become a second routing implementation.

## Next Steps

1. Create the atomic PR-01 commit, fast-forward local `master`, push `origin/master`, and verify the remote SHA.
2. Mark PR-01 complete in local pipeline state with its commit and validation evidence.
3. Render PR-02 only, create `feature/model-continuity-pr02` from the verified remote master, and assign a different agent.

## Safety Notes

- Never push `upstream`, force-push, publish, deploy, or call real paid model/OAuth services for this pipeline.
- Never put API keys, tokens, Authorization headers, runtime content, or `.codex/pr-pipeline/` state in Git.
