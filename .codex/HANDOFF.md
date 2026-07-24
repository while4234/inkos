# Project Handoff

Last updated: 2026-07-24 10:41 CST
Project root: `D:\lnkos`
Branch: `master` (delivered from `feature/model-family-prompts`)
Status: delivered_to_origin

## Current Goal

Make project-global prompts a model-family setting rather than a backend or
logical-route setting, and remove stale developer-facing copy from the routing
activity UI.

## Current Position

- The accepted feature commit was fast-forwarded to `master` and pushed only to
  `origin/master`.
- Studio has one prompt editor for GPT, Grok, DeepSeek, and Other / Custom.
- Prompts are stored once per family and automatically apply to current and
  future routes/backends that select that family.
- Logical routes retain only their family selection; route-level prompt editors
  and persistence were removed.
- Legacy route-level prompt data migrates deterministically into the family map.
- The empty routing-activity state now describes real runtime behavior and no
  longer mentions an internal PR milestone.

## Recent Actions

- Added a top-level `modelGlobalPrompts` routing map and a revision-protected
  Studio endpoint for saving or restoring each family prompt.
- Added a built-in `generic` prompt family for Other / Custom models and wired
  family overrides through resilient chat and Studio Agent routing.
- Updated contracts, runtime consumers, migration behavior, tests, and
  `MODEL_ROUTING.md`.
- Browser-smoked save, refresh, family switching, single-editor layout, and
  empty activity copy against repository-external synthetic content.

## Validation

- pnpm 9.15.9 frozen install passed.
- Core and Studio builds passed; CLI build and all typechecks passed using
  direct pnpm 9 package commands.
- Full tests passed: Core 200 files / 1940 tests, Studio 64 files / 586 tests,
  CLI 41 files / 229 tests.
- Publish-manifest verification and `git diff --check` passed.
- Browser smoke found exactly one textarea, persisted the Other / Custom prompt
  across refresh, found no `PR-08` copy, and reported zero console errors.

## Blockers / Risks

- No implementation blocker.
- The repository root build script and CLI prehooks invoke bare `pnpm`; in the
  Codex desktop runtime that resolves to bundled pnpm 11. Equivalent package
  build/typecheck/test commands were run explicitly with pnpm 9.15.9.
- A repository-external synthetic smoke directory remains at
  `D:\inkos-data\codex-model-prompts-smoke-20260724`; recursive cleanup was
  blocked by the local command-safety policy. It contains no credential.

## Next Steps

- No required follow-up.
- The repository-external synthetic smoke directory may be removed manually if
  desired.
