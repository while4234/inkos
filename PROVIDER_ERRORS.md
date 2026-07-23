# InkOS Provider Error Contract

InkOS classifies provider failures before any user-facing formatting. Core
exports `ProviderError`, `ProviderErrorCategory`, `classifyProviderError()`,
`providerErrorFromResponse()`, `toSafeProviderErrorDetails()`, and
`toProviderDisplayError()`.

## Classifier and display responsibilities

The classifier consumes structured HTTP status, upstream `code` / `type`,
response headers, known transport codes, cancellation signals, and narrowly
controlled message patterns, in that order. It produces one of:

`quota`, `rate_limit`, `auth`, `network`, `timeout`, `overloaded`,
`model_unavailable`, `invalid_request`, `context_overflow`, `content_policy`,
or `unknown`.

`ProviderError` retains safe routing identity (`backendId`, `logicalModelId`,
and `upstreamModelId`), HTTP status, upstream code/type, normalized
`Retry-After`, request ID, the original `cause`, and whether any output was
already visible to the caller. Its derived `retryable`, `onCurrentBackend`,
and `failoverEligible` fields are policy inputs; PR-02 does not select or
switch backends.

The display mapper is intentionally separate. User and API messages are
Chinese, actionable, and do not include raw provider bodies, authorization
headers, tokens, complete API keys, or local paths. `toJSON()` and
`toSafeProviderErrorDetails()` omit `cause` and partial content. Development
logs may use safe routing IDs and upstream request IDs only through that safe
serialization boundary.

## Conservative semantics

- A generic `403` is `unknown`; only explicit credential/token evidence is
  `auth`, while explicit safety evidence is `content_policy`.
- Structured codes are evaluated before a generic `400` fallback, so model,
  context, policy, quota, and authentication failures retain their meaning.
- A bare `500` and undocumented provider failures are `unknown`.
- Integer-seconds and HTTP-date `Retry-After` values are normalized and
  bounded to 24 hours. Invalid values retain only a short source string.
- User cancellation is represented by `ProviderCancellationError` with
  `cancelled: true`. It is never retryable or failover-eligible.
- `AbortSignal.timeout()` / `TimeoutError` is a timeout rather than a user
  cancellation.

## Streaming output

`PartialResponseError` carries an explicit `visibleOutput` flag. Transport
buffers are not considered visible merely because bytes were received.
Native and pi-ai streaming paths set the flag only when an `onTextDelta`
boundary forwarded text to the caller. Callers that introduce another output
boundary must update this state at that boundary with
`ProviderError.withVisibleOutput()`.
