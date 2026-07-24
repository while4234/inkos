# Project Handoff

Last updated: 2026-07-24 11:36 CST
Project root: `D:\lnkos`
Branch: `master`
Status: done

## Current Goal

Fix the blank Studio page at `http://127.0.0.1:4567` and leave the real project
open with its existing Custom backend configuration intact.

## Current Position

- The blank page was caused by `startStudioServer()` caching `index.html` at
  startup. After a frontend rebuild, that stale HTML referenced removed
  content-hashed JS/CSS assets and both requests returned 404.
- Studio now reads the current entry document for each SPA fallback request and
  responds with `Cache-Control: no-cache`.
- The rebuilt server is running on port 4567 against `D:\inkos-data\default`.
- A fresh controlled Chrome tab is open on `#/services`; the page renders and
  its fresh-tab console has zero errors and zero warnings.
- The real project still exposes one saved Custom backend and one logical route.

## Recent Actions

- Reproduced the stale-entry failure: root HTML returned 200 while its old
  Vite-hashed JavaScript and stylesheet returned 404.
- Changed the standalone Studio SPA fallback to load the latest `index.html`
  instead of retaining a startup snapshot.
- Added a regression test that replaces the entry file and verifies the new
  content is read.
- Rebuilt and restarted the real Studio process, then verified the entry and
  both current assets return 200.
- Reopened the services page in a fresh browser tab and retained that tab for
  the user.

## Changed / Relevant Files

- `packages/studio/src/api/server.ts`: refreshes the SPA entry and disables
  entry-document caching.
- `packages/studio/src/api/server.test.ts`: covers an entry-file replacement
  after a frontend rebuild.
- `GIT_NOTES.md`: records the fix and validation.
- `.codex/HANDOFF.md`: current continuation state.
- `D:\inkos-data\default`: external runtime project; used without changing its
  saved configuration.

## Validation

- pnpm 9.15.9 frozen install -> passed.
- Core, Studio, and CLI builds -> passed.
- Core, Studio client/server, and CLI typechecks -> passed.
- Core tests -> 200 files / 1940 tests passed.
- Studio tests -> 64 files / 587 tests passed.
- CLI tests -> 41 files / 229 tests passed on the clean serial rerun.
- Publish-manifest verification and `git diff --check` -> passed.
- Live root -> HTTP 200 with `Cache-Control: no-cache`.
- Live current JS and CSS assets -> HTTP 200.
- Live routing APIs -> 1 backend and 1 route.
- Fresh Chrome tab -> rendered `服务商管理`, zero console errors/warnings.

## Blockers / Risks

- None known.
- Running all three full test suites concurrently can exhaust local resources
  and produce CLI timeouts; run the CLI suite serially after Core and Studio.

## Next Steps

1. Use the already-open Studio services tab.
2. If port 4567 is restarted after another rebuild, launch it against
   `D:\inkos-data\default` so the real provider inventory is used.

## Notes For Next Session

- Do not diagnose a root HTTP 200 as a healthy SPA by itself; verify every
  content-hashed entry asset also returns 200.
- Start the real Studio project from `D:\inkos-data\default`; an empty or
  synthetic project shows a different backend inventory.
