# Project Handoff

Last updated: 2026-07-24 09:22 CST
Project root: `D:\lnkos`
Branch: `feature/fix-grok-custom-prompts`
Status: acceptance_passed_ready_for_delivery

## Current Goal

Simplify Grok login, collapse duplicate Custom normalized backends, and expose
editable per-route project-global prompts in model continuity.

## Current Position

- The implementation and acceptance checks passed on the feature branch.
- Studio is running on port 4567 against repository-external content.
- Opening model continuity repaired the existing duplicate Custom backend and
  route while preserving the default backend, route, and configured key.
- No real login, API key, provider account, or external model request was used.

## Recent Actions

- Added bundled native Grok OAuth settings, one-click browser authorization,
  exact loopback completion, and callback URL/query paste fallback.
- Removed issuer, client ID, and redirect URI inputs from the Grok provider UI.
- Made Custom normalized save idempotent and added automatic duplicate repair.
- Added bounded revisioned `globalPrompt` data to logical routes and applied it
  exactly once in both resilient chat and Studio Agent final request paths.
- Added create/edit UI for route global prompts; blank uses the built-in family
  prompt and `none` disables injection.
- Raised the large Studio server test import-hook timeout to 30 seconds to avoid
  Windows load-time flakes; all 153 server regression tests now execute.

## Validation

- pnpm 9.15.9 frozen install, build, typecheck, test, and publish-manifest
  verification passed.
- Final clean tests: Core 200 files / 1937 tests, Studio 64 files / 586 tests,
  CLI 41 files / 229 tests.
- `git diff --check` passed.
- Isolated Playwright smoke verified one Custom backend/route, the route prompt
  editor, and the Grok page without developer fields; console errors: zero.
- Credential/token contents, authorization headers, full prompt text in traces,
  runtime content, and browser artifacts are excluded from the change set.

## Blockers / Risks

- No known implementation blocker.
- The native Grok login was validated with mocks and UI smoke only; a real
  provider login was intentionally not used as an acceptance gate.
- Project-global prompt text is stored in project routing configuration, but
  only its safe asset ID/revision/family metadata enters routing traces.

## Next Steps

1. Commit the accepted feature branch, fast-forward local `master`, and push
   only `origin/master`.
2. Optionally complete a real Grok login and selected-model connection test
   from the provider page.
