# InkOS Project Instructions

## Repository Roles

- `origin` is `https://github.com/while4234/inkos.git`. It is the user's independent public repository and the destination for local changes.
- `upstream` is `https://github.com/Narcooo/inkos.git`. It is read-only and must never receive pushes.
- `master` is the user's customized and deployable main line.
- `upstream-sync` is a mirror of `upstream/master`. It must contain no local feature commits.
- Develop local features on `feature/<short-name>` branches created from the latest `master`.

## Meaning Of Update Requests

When the user says **“更新代码”**:

1. Treat it as updating from the user's repository only.
2. Require a clean working tree.
3. Run `git fetch origin --prune`.
4. Update the local `master` from `origin/master` with fast-forward-only behavior.
5. Do not fetch or merge `upstream` as part of this request.
6. If local history diverges or uncommitted work exists, stop and explain instead of overwriting anything.

When the user says **“更新原始代码”**:

1. Fetch only `Narcooo/inkos` commits already merged into its `master` branch.
2. Never fetch, inspect for adoption, cherry-pick, or merge code from any other upstream branch, including `feature/*`, `fix/*`, and `release/*`.
3. Fast-forward `upstream-sync` to `upstream/master`.
4. Preflight the merge between the user's `master` and `upstream/master` without changing the working tree, using `git merge-tree` or an equivalent read-only check.
5. Review merged upstream changes for dependency, configuration, interface, data-format, and behavior impact on local customizations.
6. If there is a textual conflict, behavior conflict, likely regression, or uncertain interaction, report the affected files and behavior plus a recommended resolution. Wait for explicit user confirmation before resolving conflicts or completing the merge.
7. If no conflict is found, merge on `sync/upstream-YYYYMMDD`, run the required validation, then merge into `master` and push to `origin`.
8. Tags are version metadata only; never use a tag or non-`master` branch as the source of an upstream code merge.

## Change And Safety Rules

- Never force-push, rewrite published history, discard user work, or push to `upstream`.
- Preserve the upstream attribution notices and the AGPL-3.0-only license.
- Do not change npm package names, publishing scopes, or public APIs unless the user explicitly requests it.
- Keep secrets and runtime content out of Git. In particular, never commit `.env*`, `.inkos/`, `books/`, `worlds/`, `inkos.json`, `prompt/`, private keys, tokens, cookies, or raw credentials.
- Keep changes focused and use the upstream commit convention: `<type>: <description>`.
- Add or update tests for functional changes.

## Required Validation

For changes that can affect runtime behavior, run:

```text
corepack pnpm@9.15.9 install --frozen-lockfile
corepack pnpm@9.15.9 build
corepack pnpm@9.15.9 typecheck
corepack pnpm@9.15.9 test
corepack pnpm@9.15.9 verify:publish-manifests
```

Use pnpm 9 for this repository because pnpm 11 does not honor the current `package.json` override layout and rejects the frozen lockfile. Use a temporary InkOS content directory for Studio smoke tests so that repository source and user content stay separate. Update `GIT_NOTES.md` and `.codex/HANDOFF.md` before final handoff after meaningful project work.
