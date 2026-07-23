# Project Handoff

Last updated: 2026-07-24 07:28 CST
Project root: `D:\lnkos`
Branch: `feature/provider-auth-onboarding`
Status: acceptance_passed_uncommitted

## Current Goal

Correct the model-continuity onboarding order: configure Codex, Grok, or
API-key backends under Providers first, then configure logical routing and
failover on the Model continuity page.

## Current Position

- The implementation and acceptance checks have passed on
  `feature/provider-auth-onboarding`.
- Studio is running the rebuilt output on port 4567 with project root
  `D:\inkos-data\default`.
- No real provider login, OAuth flow, API key, or model request was used.

## Recent Actions

- Made an absent normalized routing graph a valid empty onboarding graph with
  `defaultRouteId: null`.
- Kept legacy model execution active until a logical route exists; the first
  created logical route becomes the default automatically.
- Moved Codex credential import, Grok connection, and API-key backend creation
  into Studio Providers.
- Gated the continuity entry until a backend exists and added a clear
  empty-project link back to Providers.
- Updated user documentation and added Core/schema plus Studio API regression
  tests for backend-first onboarding.

## Validation

- pnpm 9.15.9 frozen install, build, typecheck, test, and publish-manifest
  verification passed.
- Final clean tests: Core 200 files / 1934 tests, Studio 64 files / 583 tests,
  CLI 41 files / 229 tests.
- The first full test attempt ended with a transient Vitest worker
  `ERR_IPC_CHANNEL_CLOSED`; the unchanged rerun passed completely.
- `git diff --check` passed.
- Live HTTP smoke: root and referenced JS/CSS assets returned 200;
  `/api/v1/model-backends` and `/api/v1/model-routes` returned empty valid
  collections instead of `MODEL_ROUTING_MISSING`.
- Headless Chromium verified `#/services` exposes Codex, Grok, and API-key
  onboarding; `#/model-routing` shows the backend-first empty state, contains
  no old error, and produced zero console errors or warnings.

## Blockers / Risks

- No known implementation blocker.
- Grok still requires explicit issuer, client ID, and registered redirect URI;
  missing configuration remains fail-closed by design.
- The real user content project currently has zero normalized backends, so
  continuity remains disabled until one is created under Providers.

## Next Steps

1. Complete final diff and credential/path review.
2. Commit the accepted fix.
3. Fast-forward local `master`, push only `origin/master`, and verify the
   remote SHA.
