# Project Handoff

Last updated: 2026-07-23 20:03 CST
Project root: D:\lnkos
Branch: master
Status: complete

## Current Goal

Initialize `while4234/inkos` as an independent public mirror of `Narcooo/inkos`, with a safe local customization and upstream-master synchronization workflow.

## Current Position

Repository initialization, documentation, local setup, local deployment, and CI verification are complete. Studio is running at `http://127.0.0.1:4567` with runtime content stored outside the repository.

## Recent Actions

- Created the public repository `while4234/inkos`.
- Imported upstream `master` at `1a2fd09b50681f764081675feebd02a9657f973b`.
- Pushed 38 release tags.
- Created `upstream-sync` at the same baseline.
- Restricted `upstream` fetches to `master` and disabled pushes to it.
- Installed dependencies and built all workspace packages with pnpm 9.15.9.
- Started Studio from `D:\inkos-data\default`; it is listening on port 4567.
- Pushed initialization commit `6b72785a798441f3a84aba1613a8157016247f5f`.
- Verified GitHub Actions run `30004983154` across Windows/Linux and Node 20/22/24.

## Changed / Relevant Files

- `AGENTS.md`: durable repository and update semantics.
- `LOCAL_DEVELOPMENT.md`: Windows development and synchronization workflow.
- `README.md`, `README.en.md`, `README.ja.md`: upstream attribution.
- `GIT_NOTES.md`: Git baseline and rollback notes.
- `Setup-InkOS.*`, `Start-InkOS.*`: repeatable Windows setup and startup.

## Validation

- Remote baseline and tag import -> passed.
- Frozen dependency install, build, typecheck, publish manifests, and setup launcher -> passed.
- Core tests -> 181 files / 1761 tests passed.
- Studio tests -> 58 files / 547 tests passed.
- CLI tests -> 228 passed; one upstream localhost `doctor` integration test times out at 10 seconds.
- Studio smoke test -> HTTP 200 and visible UI passed.
- GitHub Actions -> all six build/test matrix jobs and `verify-pack` passed.

## Blockers / Risks

- The upstream CLI integration test `inkos doctor > treats localhost OpenAI-compatible endpoints as API-key optional` times out during API connectivity on this Windows environment. Runtime Studio deployment is unaffected, and the same test passes in GitHub Actions.
- GitHub reports a non-blocking warning that some pinned action versions still target its deprecated internal Node.js 20 runtime.

## Next Steps

1. Configure an LLM service in the open Studio UI using the user's private API key.
2. Create `feature/<name>` branches from personal `master` for localization work.
3. Use the documented confirmation gate whenever an upstream `master` merge has text, interface, or behavior conflicts.

## Notes For Next Session

- “更新代码” means update only from the personal `origin`.
- “更新原始代码” means use only commits already merged into `Narcooo/inkos` `master`; never adopt code from other upstream branches.
