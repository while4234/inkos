# Project Handoff

Last updated: 2026-07-24 01:55 CST
Project root: D:\lnkos
Branch after delivery: `master`
Status: PR-05 accepted; PR-06 is next

## Current Goal

Continue `model-continuity-p0` with PR-06, adding Codex CLI credential import, user-level secure storage, Responses transport, and refresh without regressing the shared routing runtime.

## Current Position

PR-01 through PR-04 are on `origin/master` through `50e3e46c`. PR-05 is the current HEAD after delivery and adds Studio routing management; use `git rev-parse HEAD` for its delivery SHA. The next branch must be `feature/model-continuity-pr06` from the latest verified `master`, and only PR-06 may be rendered.

## Recent Actions

- Added modular Studio APIs for credential status, backend/route CRUD, health probe/reset, activity, ETag/revision conflict handling, and serialized atomic graph mutations.
- Added masked API Key status plus explicit replace/keep/clear behavior for normalized, legacy service, and cover credentials.
- Added `#/model-routing` for backend health, route candidates/defaults, key management, and Agent route overrides.
- Connected Core routing events to Studio SSE, de-duplicated ordered reducers, task snapshots, recent activity, and A→B task banners.
- Hardened backend deletion to remove orphaned credentials/secrets with rollback, and bounded SSE replay IDs in persisted summaries.

## Changed / Relevant Files

- `packages/studio/src/api/routes/`: model management store, DTOs, APIs, activity, health, and tests.
- `packages/studio/src/pages/ModelRoutingPage.tsx`, `model-routing-state.ts`: routing UI and key/health semantics.
- `packages/studio/src/shared/contracts.ts`, `routing-summary.ts`: browser-safe contracts and replay-safe reducers.
- `packages/studio/src/api/server.ts`, `task-store.ts`: registration, observer bridge, secret semantics, and task persistence.
- `packages/studio/src/store/chat/`, `components/chat/ToolExecutionSteps.tsx`: live/task routing summaries.
- `MODEL_ROUTING.md`, `GIT_NOTES.md`: behavior, migration, acceptance, and scope notes.

## Validation

- Studio focused regression and client/server typecheck passed.
- Studio package: 63 files / 565 tests and production build passed.
- Repository gates with pnpm 9.15.9 passed: frozen install, build, typecheck, test, and publish-manifest verification.
- Repository test totals: Core 191 files / 1859 tests; Studio 63 / 565; CLI 41 / 229.
- The first root test attempt had one isolated core dynamic-import timeout at 15.645s; the isolated test passed in 6.395s and the exact full root test rerun passed.
- Repository-external Studio browser smoke passed for two masked backends, route creation, probe, Chinese/English, keyboard focus, 375px overflow, console errors, and full-secret absence from HTML/DOM.
- `git diff --check`, forbidden-path review, and credential review passed; browser and temporary content artifacts were removed.

## Blockers / Risks

- No PR-05 blocker remains.
- Codex/Grok metadata is display-only until PR-06/07.
- Studio Agent `streamSimple()` remains intentionally outside automatic failover until PR-08.
- Candidate updates require the latest routing revision; stale pages fail with 409 instead of overwriting.

## Next Steps

1. Confirm local `master`, `origin/master`, and PR-05 pipeline SHA match.
2. Render only PR-06 and assign it to a new agent.
3. Keep Codex credentials in the user-level credential directory and reuse Core routing/error/prompt boundaries; do not add Grok OAuth or Agent streaming early.

## Notes For Next Session

- Normalized CRUD synchronizes the current legacy service/model/provider/baseUrl selection.
- Health storage is lazy so unrelated Studio tests remain decoupled.
- All provider/probe/failover behavior was mocked or local; no real provider, OAuth, paid model, deployment, or `upstream` push was used.
