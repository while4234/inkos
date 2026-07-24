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
- 2026-07-24 PR-07 acceptance completed locally: added fail-closed Grok OIDC configuration, trusted discovery/JWKS verification, bounded PKCE/state/nonce login sessions, exact loopback and paste callback handling, multi-account user storage, cross-process refresh joining, bearer chat transport, shared route failover/prompt handling, and Studio connection management with automatic callback polling. A repository-external browser smoke covered exact missing-config behavior, Chinese/English copy, 375px layout, console health, and DOM secret/path absence without any Grok/OIDC request. Full pnpm 9.15.9 frozen install/build/typecheck/test/publish-manifest validation passed (Core 195 files / 1895 tests, Studio 63 files / 569 tests, CLI 41 files / 229 tests). All OAuth/provider fixtures are synthetic; no real login or external model call was executed.
- 2026-07-24 PR-08 acceptance completed locally: routed Studio Agent streaming through the shared logical-route runtime, added an explicit material-output replay boundary, bounded pre-output retry/failover, dynamic Codex/Grok credential refresh, safe per-turn routing summaries, interrupted partial-output restore, reconnect dedupe, and distinct Studio switch/interruption banners. A repository-external browser smoke loaded the empty-project workbench and model configuration route with no console errors or warnings. Full pnpm 9.15.9 frozen install/build/typecheck/test/publish-manifest validation passed (Core 197 files / 1920 tests, Studio 64 files / 578 tests, CLI 41 files / 229 tests). Focused routing validation uses only mocks; no real provider request was executed.
- 2026-07-24 PR-09 acceptance completed locally: added the shared version 1 routing trace/collector, precise provider-observed per-attempt/per-backend usage, explicit price source/revision cost semantics, bounded task/chapter/transcript persistence, Studio trace details, and controlled half-open/single-flight health recovery. Studio task snapshots now write atomically as version 2 while reading version 1 fixtures. Final full pnpm 9.15.9 frozen install/build/typecheck/test/publish-manifest validation passed (Core 200 files / 1932 tests, Studio 64 files / 582 tests, CLI 41 files / 229 tests); main acceptance focused suites passed 96 Core and 30 Studio tests, plus all 151 Studio server regression tests. A repository-external browser smoke loaded the model-continuity page with zero console errors/warnings, and browser artifact leakage scans were clean. All provider, refresh, OAuth, usage, limit, and stream cases used mocks; no real model/OAuth request was executed.
- 2026-07-24 provider onboarding UX correction completed: moved Codex import, Grok connection, and API-key backend creation into Studio Providers; continuity now opens only after backend setup and shows a provider-onboarding state for empty projects instead of `MODEL_ROUTING_MISSING`. Empty normalized graphs use `defaultRouteId: null`, preserve legacy LLM execution until the first route is created, and automatically select that first route as default. Full pnpm 9.15.9 frozen install/build/typecheck/test/publish-manifest validation passed (Core 200 files / 1934 tests, Studio 64 files / 583 tests, CLI 41 files / 229 tests). A live empty-project browser smoke verified both pages with zero console errors or warnings.
- 2026-07-24 provider backend configuration refinement completed: reduced provider onboarding to three credential types—Custom API Key, Codex credential import, and Grok OAuth account—and placed Codex/Grok under Overseas original providers with dedicated configuration pages. All three flows now detect models, require a selected-model real request before save, create normalized backends, and optionally join continuity failover. Full pnpm 9.15.9 build/typecheck/test/publish-manifest validation passed (Core 200 files / 1934 tests, Studio 64 files / 585 tests, CLI 41 files / 229 tests). Live browser smoke verified the provider list and all three detail flows with no current-page console errors; no real credential or external provider request was used.

- 2026-07-24 provider continuity UX correction completed: Grok now uses the bundled native OAuth application settings with one-click browser authorization, exact loopback completion, and callback/query paste fallback; users no longer enter issuer/client/redirect fields. Custom normalization is idempotent and automatically repairs duplicate backends, routes, credential metadata, and orphan secrets for the same service/endpoint. Logical routes now expose a bounded revisioned project-global prompt editor; saved content replaces the built-in family prompt and remains single-injection at the final transport boundary while traces retain metadata only. Full pnpm 9.15.9 frozen install/build/typecheck/test/publish-manifest validation passed (Core 200 files / 1937 tests, Studio 64 files / 586 tests, CLI 41 files / 229 tests). Isolated-browser smoke verified one Custom backend/route, the prompt editor, the simplified Grok page, and zero console errors; no real OAuth login or provider request was executed.
- 2026-07-24 model-family prompt UX correction completed: moved project-global prompt storage out of logical routes into one top-level family map for GPT, Grok, DeepSeek, and Other / Custom; current and future routes automatically use the saved prompt for their selected family. Added deterministic migration of legacy route prompts, a generic built-in prompt, one Studio prompt editor/save action, and production-facing empty activity copy without internal PR text. Full pnpm 9.15.9 validation passed using direct package commands where bare nested `pnpm` resolved incorrectly (Core 200 files / 1940 tests, Studio 64 files / 586 tests, CLI 41 files / 229 tests); publish manifests and browser save/refresh smoke also passed with zero console errors.
- 2026-07-24 Studio runtime recovery: diagnosed `Failed to fetch` as a stopped port-4567 server while the stale frontend remained open. The external default project still contained its Custom backend, default route, and configured credential. Restarted Studio from `D:\inkos-data\default` and verified HTTP 200 plus the backend, route, and masked credential-status APIs; no source or runtime configuration was changed.
- 2026-07-24 Studio blank-page fix: stopped caching the built SPA entry document for the life of the server, because a later Vite rebuild could remove the content-hashed JS/CSS files referenced by that stale HTML. Studio now reloads `index.html` for SPA fallbacks with `Cache-Control: no-cache`, with a regression test covering entry replacement. Full pnpm 9.15.9 frozen install/build/typecheck/test/publish-manifest validation passed (Core 200 files / 1940 tests, Studio 64 files / 587 tests, CLI 41 files / 229 tests). The rebuilt real-project server returned HTTP 200 for the entry and current assets, preserved one Custom backend and one route, and rendered the services page in a fresh browser tab with zero console errors/warnings.

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
- PR-07 branch: `feature/model-continuity-pr07`.
- PR-07 planned commit subject: `feat: add grok oauth credentials`.
- PR-07 security review: production OAuth parameters are configuration-only and fail closed when absent; token/code/verifier/raw ID-token data stays in short-lived server state or user-level restricted files and never enters routing config, API status, traces, snapshots, or Git. Tests use explicit fixture values and injected local/mock transports only.
- PR-07 scope boundary: Grok OAuth joins the existing production route runtime. Studio Agent streaming and unified usage/cost trace remain PR-08 and PR-09.
- PR-08 branch: `feature/model-continuity-pr08`.
- PR-08 planned commit subject: `feat: route studio agent streams`.
- PR-08 security review: route revisions, transcript summaries, SSE DTOs, API responses, and UI banners contain only bounded logical/backend/model metadata. Unknown provider event fields are allowlisted out before transcript persistence; credentials, Authorization headers, raw bodies, and full model-global prompts are excluded.
- PR-08 continuity boundary: non-empty text, forwarded thinking/reasoning, and every tool-call phase close failover. Pre-output attempts may retry/switch; post-output failures remain interrupted partial turns and are never automatically resumed. Cross-backend checkpoint/resume remains outside scope; unified usage/cost trace remains PR-09.
- PR-09 branch: `feature/model-continuity-pr09`.
- PR-09 planned commit subject: `feat: add routing observability and recovery`.
- PR-09 security review: trace/task/chapter/transcript/SSE/UI data is bounded and allowlisted; unknown provider usage and price remain `null`/`unknown`; full prompts, raw responses, credentials, Authorization headers, and token files are excluded. Browser and diff scans found no credential or full-prompt leakage.
- PR-09 scope boundary: model-continuity P0 is complete without step-level checkpointing, cross-backend continuation from existing output, replay of partial tool calls, credential cloud sync, or inferred quota/price data.

## Rollback Notes

- The original imported state is commit `1a2fd09b50681f764081675feebd02a9657f973b`.
- Do not rewrite published history. Revert later customization commits when rollback is required.
