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

## Rollback Notes

- The original imported state is commit `1a2fd09b50681f764081675feebd02a9657f973b`.
- Do not rewrite published history. Revert later customization commits when rollback is required.
