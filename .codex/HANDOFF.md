# Project Handoff

Last updated: 2026-07-24 00:52 CST
Project root: D:\lnkos
Pipeline: `model-continuity-p0`
Position: PR-04 accepted on `feature/model-continuity-pr04`; delivery target is `origin/master`

## Current Goal

Deliver PR-01 through PR-09 serially. Each PR uses a different implementation agent, receives full acceptance validation, then becomes one atomic fast-forward commit on `origin/master` before the next PR starts.

## Current Position

PR-01 through PR-03 are committed and verified on `origin/master`; PR-03 is at `4e688e98ae8784fcf5c35fc4bb30c9d22e78f597`. PR-04 adds explicit model-family selection plus one final-transport-boundary prompt implementation shared by direct and route-aware `chatCompletion()`. Its implementation, focused validation, full repository gates, build-artifact check, compatibility review, and safe-output review are complete. Delivery is one atomic commit followed by fast-forward-only `master` update, `origin/master` push, remote SHA verification, and local pipeline completion recording.

## Recent Actions

- Added `PromptFamilySchema` support for `gpt`, `grok`, `deepseek`, and `none`, retaining `generic` only as the deterministic compatibility sentinel for already-migrated routes.
- Added three independently auditable TypeScript prompt assets with stable IDs, revisions, and non-secret boundary markers.
- Added pure deep-cloning injection/stripping that replaces old family/revision prefixes, remains idempotent, and always precedes existing string, structured, or opaque system content.
- Resolved one family/revision per logical route before attempts and reused it across local retry and A-to-B failover; routing events expose metadata only.
- Explicitly disabled model-global prompting in Core provider verification, CLI doctor connectivity, and Studio service probes.
- Exported a reusable Grok history transform that removes replayed assistant reasoning/thinking while preserving text and tool semantics for PR-08.
- Added family-resolution, asset, ordering, immutability, history, probe opt-out, and local A/B HTTP tests; corrected marker matching so project-owned lookalike markers are never stripped.

## Changed / Relevant Files

- `packages/core/src/llm/model-global-prompt.ts`
- `packages/core/src/llm/model-global-prompts/{gpt,grok,deepseek}.ts`
- `packages/core/src/llm/model-routing.ts`
- `packages/core/src/llm/resilient-client.ts`
- `packages/core/src/llm/routing-trace.ts`
- `packages/core/src/llm/provider.ts`
- `packages/core/src/llm/providers/verify.ts`
- `packages/core/src/index.ts`
- `packages/core/src/__tests__/model-global-prompt.test.ts`
- Routing, resilient-client, verify, PipelineRunner, Studio server, and CLI doctor tests/call sites
- `MODEL_ROUTING.md`

## Validation

- `corepack pnpm@9.15.9 install --frozen-lockfile` -> passed.
- Root `build` and `typecheck` -> passed after final acceptance fixes.
- Root `test` -> passed for Core, Studio, and CLI. Core reported 191 files / 1859 tests after the final two acceptance tests.
- `verify:publish-manifests` -> passed for Core, CLI, and Studio.
- Final focused prompt/routing/resilient/verify subset -> 4 files / 52 tests passed; Core typecheck also passed.
- Built `packages/core/dist` contains exactly three model-global prompt asset modules, and the compiled registry imports successfully.
- `git diff --check` -> passed before handoff update; final staged diff check remains part of the commit gate.
- Forbidden-path and added-line credential scans found zero matches. Routing-event tests confirm complete prompt text is absent.

## Blockers / Risks

- No PR-04 blocker remains.
- Unknown endpoint/service/model combinations conservatively resolve to `none` with diagnostic source metadata; saving an explicit route `promptFamily` makes the choice persistent.
- Studio Agent `streamSimple()` is not yet connected to this boundary; PR-08 must reuse the exported implementation and Grok history transform.
- Prompt assets are TypeScript constants so the normal Core compiler and package include them without a separate copy step.

## Next Steps

1. Create the atomic PR-04 commit `feat: add model family global prompts`.
2. Re-fetch `origin`, fast-forward local `master`, push only `origin/master`, and verify the remote SHA.
3. Mark PR-04 complete in local pipeline state with the commit and validation evidence.
4. Render PR-05 only, create `feature/model-continuity-pr05` from verified `master`, and assign a fifth, different implementation agent.

## Safety Notes

- Never push `upstream`, force-push, publish, deploy, or call real paid model/OAuth services for this pipeline.
- Never put API keys, tokens, Authorization headers, runtime content, or `.codex/pr-pipeline/` state in Git.
