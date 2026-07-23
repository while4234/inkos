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

## Rollback Notes

- The original imported state is commit `1a2fd09b50681f764081675feebd02a9657f973b`.
- Do not rewrite published history. Revert later customization commits when rollback is required.
