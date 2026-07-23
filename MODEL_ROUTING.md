# InkOS Model Routing Configuration

InkOS keeps three concerns separate:

- A **logical model route** is the user-facing model choice. It owns an ordered
  list of candidates and a `promptFamily`.
- A **backend instance** describes a concrete provider endpoint and transport.
  It references a credential by ID and never embeds a secret.
- A **credential reference** is non-secret metadata. Project API keys live in
  `.inkos/secrets.json`; future Codex and Grok credentials live under the
  user-level `~/.inkos` credential store, never in the project directory.

## Schema version and compatibility

`llm.routing.version` is currently `1`. The existing `llm.services`,
`llm.defaultModel`, top-level LLM compatibility fields, environment variables,
and legacy string/object `modelOverrides` remain readable during the
compatibility window. A route-aware override uses `{ "routeId": "route-..." }`.

The first normal `loadProjectConfig()` call upgrades a legacy project when no
routing graph exists. Stable credential, backend, and route IDs are derived
from service identity and model identity, so repeated loads do not create new
objects or rewrite unchanged files. Multi-service projects retain every
service; the currently selected service and default model become the default
single-candidate route.

Project API keys are copied to credential-ID entries in
`.inkos/secrets.json`, while the legacy service-keyed entries remain available
to Studio, CLI, and older runtimes. No key is written to `inkos.json`.

## Safe writes, recovery, and rollback

Configuration and secret updates use same-directory temporary files followed
by replacement. Secret directories/files request restrictive `0700`/`0600`
permissions on platforms that support POSIX modes.

Migration prepares secrets before committing `inkos.json`. If the config
commit fails, InkOS restores the original secrets. If restoration itself
fails, the unchanged legacy service entry remains readable and a later load
can safely retry; InkOS does not delete the legacy configuration during this
window.

For a manual rollback, restore both `inkos.json` and
`.inkos/secrets.json` from the same backup/revision. Removing only
`llm.routing` is also safe while the compatibility fields remain: the next
normal load deterministically reconstructs version 1 routing.

OAuth access/refresh tokens are outside this migration. They must never be
placed in `.inkos/secrets.json`, `inkos.json`, logs, API payloads, or project
fixtures.

## Prompt layers and model families

InkOS composes prompts in three separate layers:

1. The **model-global prompt** is provider/model adaptation owned by the logical
   route. `promptFamily` accepts `gpt`, `grok`, `deepseek`, or `none`. It is
   injected once at the final `chatCompletion()` transport boundary.
2. The **Agent/role system prompt** describes the current authoring role and
   task. It remains after the model-global prompt and is never replaced by it.
3. A **project prompt pack** is user/project content. Its order and text remain
   part of the role/task context.

Routes migrated before strict family selection may still contain `generic`.
InkOS resolves that compatibility sentinel deterministically from a recognized
official endpoint, then an explicit service mapping, then a normalized model
ID. Unknown models use `none` and return diagnostic fallback metadata; save an
explicit `promptFamily` on the route to make the choice persistent.

Business generation defaults to model-global prompt mode `auto`. Narrow
connectivity/provider verification calls pass
`modelGlobalPrompt: "disabled"` explicitly. Disabling strips any recognized
InkOS model-global prefix but does not alter role prompts, prompt packs, JSON
schema instructions, or user messages.

Each asset has a stable non-secret ID, numeric revision, and boundary marker.
Retry and failover attempts reuse the family/revision resolved for the logical
route, so changing backend URL or provider transport cannot stack or change
the prompt. Routing observers receive only family, asset ID/revision, enabled
state, and fallback source; the full asset text is never written to trace
events.

## Runtime failover and backend health

Production `PipelineRunner` calls use the configured default logical route.
Route-based agent overrides use the same runtime and health store. Candidate
order is stable; a request never leaves its selected `LogicalModelRoute`, even
when candidates map that logical model to different upstream model IDs.
Library and non-runner production paths can use
`createRouteAwareLLMClient()` and keep the existing
`chatCompletion(client, model, messages, options)` signature. A configuration
without `llm.routing` returns the ordinary single client unchanged.
Legacy model-only or explicit base-URL overrides continue through their
original single-client compatibility path; selecting a multi-backend logical
model requires a route reference so InkOS never guesses a different route.

The API-key runtime applies this bounded policy:

| Category | Current backend | Next candidate |
| --- | --- | --- |
| `quota` | no local retry; mark `quota_exhausted` | switch immediately |
| `auth` | no refresh; mark `auth_required` | switch immediately |
| `rate_limit` | one retry with bounded `Retry-After` | cooldown, then switch |
| `network`, `timeout`, `overloaded` | two bounded backoff retries | cooldown, then switch |
| `model_unavailable` | no local retry | cooldown, then switch |
| invalid/context/policy/unknown/cancelled | no retry | no switch |

Any non-empty text delivered through `onTextDelta` closes the replay boundary:
an error after that point is returned with `visibleOutput: true`, and InkOS
does not retry or switch. Calls without a delta callback may replay the whole
request before a result is returned; partial content from different backends
is never joined.

Health is stored in `.inkos/backend-health.json` with atomic replacement and
serialized read-modify-write updates within the running InkOS process. It
records per-backend success/failure,
consecutive failures, cooldown/recovery conditions and probe result, plus the
active backend for each route. Temporary cooldowns become eligible after their
deadline while retaining history. Quota and authentication states require an
explicit `ResilientChatRuntime.resetBackend()` or successful
`recordProbe()` call; they never recover on a short timer.

Codex and Grok credential references remain explicit but unavailable to this
API-key runtime. They are skipped with a safe unsupported-credential reason
until their dedicated transports are added.
