# Git Notes

## Repository Purpose

Independent public mirror of `Narcooo/inkos` for localized changes and feature development under `while4234/inkos`.

## Ignore And Secret Policy

Runtime content, LLM credentials, environment files, private keys, build output, dependencies, caches, and browser test artifacts are excluded. Safe placeholder files such as `.env.example` remain tracked.

## Current Baseline

- Upstream baseline: `1a2fd09b50681f764081675feebd02a9657f973b` (`upstream/master`)
- Personal initialization commit: `6b72785a798441f3a84aba1613a8157016247f5f` (`origin/master`)
- `upstream-sync`: `1a2fd09b50681f764081675feebd02a9657f973b`, exactly matching `upstream/master`
- Working tree: clean after the initialization push
- Validation:
  - pnpm 9.15.9 frozen install -> passed
  - build -> passed
  - typecheck -> passed
  - publish-manifest verification -> passed
  - core tests -> 181 files / 1761 tests passed
  - Studio tests -> 58 files / 547 tests passed
  - CLI tests -> 40 files passed; 1 file has one upstream localhost `doctor` test timing out after 10 seconds, while the other 228 tests passed
  - setup launcher -> passed
  - Studio smoke test -> HTTP 200 and visible UI at `http://127.0.0.1:4567`
  - GitHub Actions run `30004983154` -> passed on Windows and Linux with Node 20, 22, and 24; `verify-pack` also passed

## Change Log

- 2026-07-23 `1a2fd09b` imported: exact upstream `master` baseline plus 38 release tags; `upstream-sync` created at the same commit.
- 2026-07-23 `6b72785a` added: repository attribution, durable update semantics, local setup/start launchers, and validation records.
- 2026-07-23 PR-01 acceptance completed: added the logical-model routing foundation, atomic credential migration, compatibility writers, masked Studio secret reads, and a bounded CLI doctor connectivity probe. Full pnpm 9.15.9 build/typecheck/test/publish-manifest validation passed (Core 1781, Studio 549, CLI 229 tests).
- 2026-07-23 PR-02 acceptance completed: added structured provider errors, conservative classification, bounded Retry-After parsing, cancellation and visible-output semantics, safe display/serialization, and shared Core/CLI/Studio compatibility adapters. Full pnpm 9.15.9 build/typecheck/test/publish-manifest validation passed (Core 1811, Studio 549, CLI 229 tests).
- 2026-07-24 PR-03 acceptance completed: added route-aware API-key failover, bounded per-backend retries, persistent backend health, safe aggregate attempts, routing events, PipelineRunner/short-fiction integration, and legacy override compatibility. Full pnpm 9.15.9 build/typecheck/test/publish-manifest validation passed (Core 1829, Studio 549, CLI 229 tests).
- 2026-07-24 PR-04 acceptance completed: added explicit model-family routing, three auditable model-adaptation prompt assets, revision-safe/idempotent final-boundary injection, retry/failover metadata, probe opt-out, and a reusable Grok history transform. Full pnpm 9.15.9 frozen install/build/typecheck/test/publish-manifest validation passed (Core 191 files / 1859 tests after the final acceptance fixes; Studio and CLI suites passed).
- 2026-07-24 PR-05 acceptance completed: added modular Studio credential/backend/route/health APIs, revision-protected normalized graph updates, masked secret status with explicit replace/keep/clear semantics, production routing SSE/task summaries, and the `#/model-routing` management UI. A repository-external browser smoke covered Chinese/English, route creation, health probing, keyboard focus, 375px layout, and secret absence from the DOM. Full pnpm 9.15.9 frozen install/build/typecheck/test/publish-manifest validation passed (Core 191 files / 1859 tests, Studio 63 files / 565 tests, CLI 41 files / 229 tests).
- 2026-07-24 PR-06 acceptance completed locally: added safe Codex auth discovery/import, path-safe and cross-process-serialized user credential storage, coordinated refresh (including non-rotating token single-flight), Codex Responses/SSE transport, structured same-backend auth retry and route failover, and Studio import/status/re-import/delete management. A repository-external browser smoke covered isolated discovery/import, backend creation, Chinese/English copy, 375px layout, console health, and DOM secret/path absence. Full pnpm 9.15.9 frozen install/build/typecheck/test/publish-manifest validation passed (Core 193 files / 1875 tests, Studio 63 files / 567 tests, CLI 41 files / 229 tests).

## Model Continuity Pipeline

- Run id: `model-continuity-p0`; local state is excluded through `.git/info/exclude`.
- Delivery protocol: one focused feature branch and one atomic commit per PR, fast-forwarded to personal `master` and pushed only to `origin/master` after all gates pass.
- PR-01 branch: `feature/model-continuity-pr01`.
- PR-01 commit subject: `feat: add logical model routing foundation`.
- PR-01 security review: no complete API key/token/Authorization data or runtime/pipeline state is included.
- PR-01 compatibility boundary: route references execute on the current backend; cross-backend retry/failover remains reserved for PR-03.
- PR-02 branch: `feature/model-continuity-pr02`.
- PR-02 commit subject: `feat: add structured provider errors`.
- PR-02 security review: provider causes and raw bodies stay out of safe JSON/API output; added Authorization/API-key strings are mock fixtures only, and no real credential or runtime/pipeline state is included.
- PR-02 scope boundary: classification exposes retry/failover eligibility but does not select, score, persist health for, or switch backends; those behaviors remain reserved for PR-03.
- PR-03 branch: `feature/model-continuity-pr03`.
- PR-03 commit subject: `feat: add resilient backend failover`.
- PR-03 security review: `.inkos/backend-health.json` remains ignored runtime state; persisted reasons, aggregate errors, and routing events are bounded and credential-safe; all credential-shaped additions are mock fixtures or redaction rules.
- PR-03 scope boundary: only API-key/OpenAI-compatible production routing is enabled. Codex/Grok credentials, Studio Agent streaming, model-family prompts, UI management, and cost/trace unification remain later PR work.
- PR-04 branch: `feature/model-continuity-pr04`.
- PR-04 commit subject: `feat: add model family global prompts`.
- PR-04 security review: routing events contain only family, asset ID/revision, enabled state, and selection source; prompt text, credentials, Authorization data, and pipeline/runtime state stay out of traces and Git.
- PR-04 scope boundary: production `chatCompletion()` uses the shared injection boundary, while Studio Agent `streamSimple()` intentionally remains for PR-08. The Grok structured-history transform is exported now and is consumed by that later Agent integration.
- PR-05 branch: `feature/model-continuity-pr05`.
- PR-05 planned commit subject: `feat: add studio routing management`.
- PR-05 security review: credential GETs return only configured state and a short mask; API keys never enter routing config, browser rehydration, routing events, task summaries, logs, snapshots, or browser artifacts. Test keys use explicit non-production fixture values.
- PR-05 scope boundary: API Key/OpenAI-compatible backends are fully managed. Codex/Grok connection flows remain PR-06/07, Studio Agent stream failover remains PR-08, and unified usage/cost trace remains PR-09.
- PR-06 branch: `feature/model-continuity-pr06`.
- PR-06 planned commit subject: `feat: add codex credential transport`.
- PR-06 security review: project routing data stores only credential references; managed Codex auth copies and refresh state stay in the user-level credential directory. Studio status/discovery expose only bounded IDs, safe basenames, masked account metadata, expiry, and state. All auth/Responses fixtures are synthetic.
- PR-06 scope boundary: credentials are imported from existing Codex CLI auth rather than created through browser OAuth. Grok OAuth, Studio Agent streaming, unified trace/cost, and real provider integration remain outside this PR.

## Rollback Notes

- The original imported state is commit `1a2fd09b50681f764081675feebd02a9657f973b`.
- Do not rewrite published history. Revert later customization commits when rollback is required.
