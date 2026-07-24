# InkOS Model Routing Configuration

InkOS keeps three concerns separate:

- A **logical model route** is the user-facing model choice. It owns an ordered
  list of candidates and selects a `promptFamily`.
- A **backend instance** describes a concrete provider endpoint and transport.
  It references a credential by ID and never embeds a secret.
- A **credential reference** is non-secret metadata. Project API keys live in
  `.inkos/secrets.json`; imported Codex CLI credentials live under the
  user-level `~/.inkos/credentials/codex` store, and Grok OAuth credentials
  live under `~/.inkos/credentials/grok`. Login credentials never live in the
  project directory.
- **Model-global prompts** are project-level settings keyed by model family.
  They are independent of backend and route identities.

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

1. The **model-global prompt** is provider/model adaptation selected by the
   logical route but stored once per project and model family.
   `modelGlobalPrompts` accepts `gpt`, `grok`, `deepseek`, and `generic`
   (shown as Other / Custom in Studio). A route's `promptFamily` selects one of
   those families or `none`. The selected prompt is injected once at the final
   `chatCompletion()` transport boundary.
2. The **Agent/role system prompt** describes the current authoring role and
   task. It remains after the model-global prompt and is never replaced by it.
3. A **project prompt pack** is user/project content. Its order and text remain
   part of the role/task context.

For `generic`, InkOS resolves a recognized official endpoint first, then an
explicit service mapping, then a normalized model ID. Recognized models use the
saved GPT, Grok, or DeepSeek prompt; unknown models use the saved Other / Custom
prompt. Legacy route-level prompts are normalized into the corresponding
project family when the routing graph is read.

Business generation defaults to model-global prompt mode `auto`. Narrow
connectivity/provider verification calls pass
`modelGlobalPrompt: "disabled"` explicitly. Disabling strips any recognized
InkOS model-global prefix but does not alter role prompts, prompt packs, JSON
schema instructions, or user messages.

Each asset has a stable non-secret ID, numeric revision, and boundary marker.
Retry and failover attempts reuse the family/revision resolved for the logical
route. Adding or changing a backend never creates another prompt copy, and all
routes selecting the same family use the same project setting. Routing
observers receive only family, asset ID/revision, enabled state, and fallback
source; the full asset text is never written to trace events.

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

Codex and Grok OAuth credential references use the same pool and health policy as API-key
credentials. The dedicated adapter resolves and pre-refreshes the credential,
forces at most one refresh after an explicit 401/403, retries the same backend
once, then returns structured `auth` so the pool can mark `auth_required` and
switch within the same logical route.

## Using existing Codex CLI credentials

Studio labels this flow **Use Codex login credentials**. It imports an existing
Codex CLI `auth.json`; InkOS does not perform browser OAuth and never asks for
the user's password.

Discovery order is `CODEX_AUTH_FILE`, `CODEX_HOME/auth.json`, project
`.codex/auth.json`, then user `~/.codex/auth.json`. Canonical duplicate paths
are collapsed. The API returns only source labels, a safe file name, masked
account metadata, expiry and a bounded status; it never returns the absolute
path or JSON/token content.

The default **Import copy** action validates a maximum 1 MiB JSON object with a
`tokens` object and `tokens.access_token`, then atomically writes an
InkOS-managed copy and user-level registry with restrictive permissions.
`tokens.refresh_token`, explicit expiry fields, or JWT `exp`/account claims are
used only for refresh/status metadata. A deliberately selected external
reference is read-only: near expiry it asks for re-import instead of changing
the Codex CLI file. Re-import replaces the managed copy. Deleting an InkOS
reference deletes only its registry entry and managed copy; it never deletes
an external Codex CLI file, and deletion is blocked while a backend uses it.

Codex backends use the Responses endpoint, bearer and account headers,
`Accept: text/event-stream`, an originator and per-request ID. The adapter
normalizes `/v1/responses` to `/responses`, forces `store:false` and streaming,
removes unsupported completion fields, safely collects streaming output for
non-incremental callers, and maps usage, cancellation, partial streams and
provider errors into the existing Core result/error model. The route owns the
GPT (or explicitly configured) prompt family, so a Codex-to-API-key switch
reuses one family/revision and injects it only once per attempt.

## Connecting Grok with OAuth/OIDC

InkOS does not ship guessed production OAuth parameters. **Connect Grok** is
enabled only when all three values are configured:

```text
INKOS_GROK_OAUTH_ISSUER=https://<trusted-issuer>
INKOS_GROK_OAUTH_CLIENT_ID=<registered-public-client-id>
INKOS_GROK_OAUTH_REDIRECT_URI=http://127.0.0.1:<registered-port>/<callback-path>
INKOS_GROK_OAUTH_SCOPE=openid profile email offline_access   # optional
```

The issuer must be HTTPS. Discovery must return that exact issuer, and its
authorization, token, and JWKS endpoints must remain on the trusted origin.
HTTP issuer/endpoints are accepted only for an explicitly injected loopback
mock in tests. The redirect must be an exact `127.0.0.1` HTTP URI with a fixed
port and path already registered for the client; InkOS does not promise that
the provider accepts a dynamic fallback port.

Each login has an isolated ten-minute, single-use server session with
high-entropy state and nonce plus PKCE S256. The callback validates the exact
scheme, host, port, path, and state before exchange. A full callback URL can
be pasted when the port is busy or the browser does not return. A bare
one-time code is accepted only while bound to the explicitly selected pending
session. Completion validates the ID-token signature from the trusted JWKS
  and its issuer, audience/authorized party, expiry, issued-at/not-before,
  nonce, and subject. Claims are display metadata, never a substitute for
  provider authorization. Completion,
denial, cancellation, validation failure, timeout, or Studio restart destroys
the sensitive session; after a restart the user must start again.

Multiple accounts live under the user credential root
(`~/.inkos/credentials/grok` or `INKOS_CREDENTIAL_HOME/grok`). The registry
contains safe account/expiry/refresh status only. Access, refresh, and ID
tokens are in per-account files written atomically with restrictive
permissions. Project routing stores only the stable `grok_oauth` credential
ID. Studio can choose an active account while a route still references any
specific account. Deletion is blocked while a backend references the
credential. Local deletion is not provider-side revocation; revoke separately
in the provider account. Token export, cloud sync, and account sharing are not
supported.

Near-expiry resolution uses per-credential single-flight refresh and
atomically preserves rotated refresh tokens. A provider 401/403 forces at
most one refresh and one same-backend replay. Another auth rejection marks
the credential/backend `auth_required`; quota, rate-limit, network,
cancellation, and visible-output behavior remains the shared structured route
policy. Grok uses bearer injection at the transport boundary, shared
usage/error/cancel handling, the route's explicit `grok` prompt family, and
the final-boundary history conversion that removes unsupported private
reasoning/thinking while preserving ordinary text, tool calls, and results.

Troubleshooting:

- A missing-field notice means no discovery request was made. Configure the
  exact issuer, client ID, and registered redirect, then restart Studio.
- For a port conflict or callback timeout, use the paste fallback without
  changing the registered redirect.
- `auth_required` means refresh was rejected or the refreshed token remained
  unauthorized. Reconnect, then reset/probe backend health.
- Issuer/origin, state, nonce, signature, audience, or expiry failures are
  intentionally fail-closed and require a fresh connection.

## Studio management and A/B setup

Open **Providers** (`#/services`) first to import Codex credentials, connect
Grok, or create API-key backends. Credentials and backend connections belong
to provider setup. Studio's browser API exposes credential status and a short
mask only; it never returns a complete API key. Leaving a key field blank
keeps the stored value. Replacing a key is an explicit PUT and clearing it is
an explicit DELETE.

After at least one backend exists, open **Providers → Model continuity and
failover** (`#/model-routing`) to configure the normalized logical routes,
candidate order, health, and failover behavior. An empty project opens as an
onboarding state and directs the user back to Providers instead of treating
the missing routing graph as an error.

To configure two OpenAI-compatible endpoints:

1. Create backend A and backend B with distinct stable IDs, HTTPS/local
   endpoints, and API keys. The key input is cleared after submission and is
   never rehydrated into the form.
2. Create one logical route, select A then B in candidate order, provide the
   upstream model ID, and choose the route's explicit prompt family.
3. Optionally edit the project-level prompt once for each model family. Current
   and future routes selecting that family use it automatically.
4. Set that route as the default. Per-Agent routing remains under Project
   settings; route-aware overrides are stored as `{ "routeId": "..." }`.
5. Probe both backends from the health area. Probes call the controlled
   `/models` boundary and do not send a chat prompt or inject a model-global
   prompt.
6. Run a production task against a mock or authorized provider. A quota/auth
   failure on A makes the Core resilient runtime select B. The task card and
   recent activity show the logical model, A → B, safe reason, and routing
   phase. Refreshing Studio restores the task summary and backend health.

Every graph mutation includes the routing revision returned by the last GET.
An outdated page receives a revision conflict and must reload instead of
overwriting another page's edit. Backends referenced by a route and default
routes cannot be deleted. Quota/auth health requires key/account repair plus a
manual probe or reset; Studio does not describe those states as short
automatic cooldowns.

Codex credential import and Grok OAuth connection are available on Providers;
their backends participate in the same refresh, health, and routing runtime.

## Studio Agent streaming continuity

Studio Agent chat uses the same logical route, credential resolver, structured
provider errors, health state, prompt-family revision, Codex Responses
transport, and Grok history conversion as production pipelines. A concrete
service/model represented by a route resolves that route; an unmatched
explicit selection remains on the legacy direct path.

Before material output, bounded metadata is held per attempt and shared retry
and switch policy applies. The replay boundary closes on the first non-empty
text delta, forwarded thinking/reasoning delta, or any tool-call
start/delta/end event. After that boundary InkOS never retries or switches:
Studio preserves partial text, thinking, and tool state, marks the turn as
interrupted, and displays the logical model plus attempted backend/model.
Credentials, raw provider bodies, and complete prompts are excluded.

Routing summaries persist in the session transcript and restore safely.
Replayed SSE activity is deduplicated by event ID. Cross-backend
checkpoint/resume, continuation from partial output, and replay of a partially
emitted tool call are intentionally not implemented.

## Unified routing trace, usage, and cost

Production tasks and Studio Agent streams emit the same routing trace schema
(`version: 1`). Each trace contains the logical model, actual backend/model,
prompt family plus asset revision, ordered attempts and switches, local retry
counts, safe terminal categories, the visible-output boundary, and final
status. Safe caller context may add task/session/book/chapter/stage/Agent IDs;
credentials, raw errors, response bodies, and complete prompts are excluded.

Provider usage is recorded per actual attempt and aggregated per backend.
Input, output, cache-read, cache-write, and reasoning tokens remain `null` when
the provider did not report them. A failed partial response is not guessed or
counted as zero and is not added twice.

Price metadata is optional and belongs to a concrete route candidate:

```json
{
  "backendId": "backend-a",
  "upstreamModelId": "gpt-example",
  "pricing": {
    "currency": "USD",
    "inputPerMillion": 2,
    "outputPerMillion": 8,
    "cacheReadPerMillion": 1,
    "reasoningPerMillion": 8,
    "source": "provider-contract",
    "revision": "2026-07"
  }
}
```

InkOS calculates cost only when provider usage and explicit price
source/revision are both present. Existing model-bank zero placeholders are not
trusted pricing. Unknown cost stays `null`/`unknown` in trace, API, task
snapshots, transcripts, and Studio; it is never shown as `$0.00`.

Studio task snapshots are written atomically as version 2 and legacy version 1
snapshots remain readable. Chapter traces accept an optional `routingTrace`,
and Agent transcript routing summaries retain their legacy fields plus the
canonical bounded trace. At most 100 attempts and 50 switches are retained.

After a temporary cooldown expires, only one half-open business request may
probe recovery; concurrent work skips that backend. Unknown backends use the
same controlled first attempt. Health probes are single-flight, time-bounded,
cancellable, and use `/models` without a model-global prompt. Quota recovery
never guesses a billing period; use explicit reset or a controlled probe.
Authentication requires credential repair/refresh/reconnect or a successful
probe, and disabled backends require explicit enablement.

The complete module/data-flow and persistence contract is documented in
[Model continuity architecture](MODEL_CONTINUITY_ARCHITECTURE.md).
