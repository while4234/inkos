# Project Handoff

Last updated: 2026-07-24 08:13 CST
Project root: `D:\lnkos`
Branch: `feature/unify-provider-backend-config`
Status: acceptance_passed_ready_for_delivery

## Current Goal

Make Studio backend setup match the user-facing provider model: Custom is the
single API-key backend flow, while Codex credentials and Grok OAuth accounts
are configured from dedicated cards under Overseas original providers.

## Current Position

- The implementation and acceptance checks passed on
  `feature/unify-provider-backend-config`.
- Studio is running on port 4567 against a repository-external temporary
  content project.
- No real login, API key, provider account, or external model request was used.

## Recent Actions

- Removed the duplicate advanced backend form from the provider list.
- Added dedicated Codex and Grok provider pages with credential setup, model
  detection, selected-model real-request verification, and normalized backend
  save controls.
- Upgraded Custom to the same detect, select, verify, save flow and synchronized
  its saved secret into a credential-referenced normalized backend.
- Made inclusion in automatic failover explicit and repaired the default route
  when a backend route is removed.
- Added safe server endpoints and regression coverage for provider discovery,
  connection tests, service cards, normalized Custom creation, and OAuth setup.

## Validation

- pnpm 9.15.9 frozen install, build, typecheck, test, and publish-manifest
  verification passed.
- Final clean tests: Core 200 files / 1934 tests, Studio 64 files / 585 tests,
  CLI 41 files / 229 tests.
- `git diff --check` passed.
- Live Chrome smoke verified the provider list, Codex, Grok, and Custom pages.
  The current port 4567 pages produced no console errors.
- Credentials, tokens, authorization headers, provider responses, and browser
  artifacts are excluded from the change set.

## Blockers / Risks

- No known implementation blocker.
- Codex model discovery uses the compatible credential catalog; the selected
  model must still pass a real request before the backend can be saved.
- Grok login remains fail-closed until valid OIDC application settings are
  supplied.

## Next Steps

1. Deliver the accepted commit to `origin/master` with fast-forward-only
   semantics.
2. Configure one of the three provider types in Studio, then open model
   continuity to arrange failover order and health policy.
