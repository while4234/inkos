# Model continuity architecture

InkOS has one continuity boundary for both production `chatCompletion()` calls
and Studio Agent streams. Callers provide safe operation context; Core owns
candidate selection, credential resolution and refresh, prompt-family
application, retries, switches, health updates, usage/cost accounting, and
trace event order.

## Module boundaries

- `llm/model-routing.ts` defines versioned credential, backend, route, and
  explicit price metadata. Project configuration contains credential
  references only.
- `llm/resilient-client.ts` is the production request boundary.
- `agent/agent-route-runtime.ts` adapts pi Agent streams to the same routing,
  error, credential, prompt, health, and trace contracts. Material text,
  forwarded thinking, and tool-call events close its replay boundary.
- `llm/routing-trace.ts` is the single versioned observer and aggregation model.
  It contains only bounded identifiers, categories, timestamps, provider
  usage, and explicit price provenance.
- `llm/backend-health-store.ts` persists health atomically under project
  runtime state. `llm/health-recovery.ts` admits one half-open request and
  single-flights probes.
- Studio converts Core events to SSE without inventing backend/model names.
  Task snapshot v2, chapter trace, and Agent transcript schemas carry the same
  safe trace shape.

## Data flow

1. A caller supplies a logical route and optional task/session/book/chapter
   context.
2. Core resolves the route and credential at dispatch time. API keys stay in
   the project secret file; Codex and Grok tokens stay in the user credential
   root.
3. The route fixes one prompt family/asset revision for all attempts. The full
   prompt text is applied only at the final transport boundary and never
   enters trace data.
4. Each actual provider attempt records backend/model, credential kind,
   retry count, safe terminal category, visible-output state, and provider
   usage if observed.
5. Cost is computed only when the selected candidate has currency, rates,
   source, and revision. Missing usage or price provenance remains
   `null`/`unknown`; it is never displayed as zero.
6. The observer emits bounded ordered SSE records. Trace observer or persistence
   failure is isolated from the model result.

## Recovery and concurrency

Temporary cooldown becomes eligible only after its recorded deadline. The
first request after expiry obtains a half-open lease; concurrent requests skip
that backend instead of creating a thundering herd. Unknown backends use the
same controlled first request. A successful business request or probe marks
the backend healthy.

Quota state does not guess a provider billing period. It requires manual reset,
an explicitly configured operational policy outside this P0, or a low-frequency
manual probe. Authentication state recovers only after credential repair,
successful refresh/reconnect, reset, or successful probe. Disabled backends
require an explicit configuration change. Probes are single-flight, bounded by
timeout, cancellable, and use `/models`, so model-global prompts are opted out.

## Persistence and retention

- Studio task snapshots write version 2 atomically and read version 1 fixtures
  as version 2 in memory without rewriting them.
- `ChapterTraceSchema.routingTrace` is optional, so existing chapter trace files
  remain valid.
- Agent `routing_summary` transcript events keep the legacy summary fields and
  optionally include the canonical version 1 trace.
- A trace retains at most 100 attempts and 50 switches. Studio retains at most
  100 recent requests/events. Raw SSE frames, prompts, responses, tool payloads,
  credentials, and provider error bodies are not retained.

## Error and cancellation boundary

User-facing failures use safe structured categories. An aggregate failure keeps
attempt categories for diagnosis but excludes raw provider text. Cancellation
and content-policy failures are terminal and are not rewritten as successful
fallbacks. After any material Agent output, a failure is `interrupted`; InkOS
does not switch, replay text, or repeat a tool call.

Step-level checkpointing, cross-backend continuation from existing output, and
replay of partially emitted tool calls are deliberate future extension points.
They are not implemented in P0.
