# API request protection

## Shared budgets

Public tracking and shipment/payment client routes use atomic Redis counters
shared across API instances. Initial limits per sixty-second window are:

| Route group           | Operation                                     | Client address budget | Authenticated account budget |
| --------------------- | --------------------------------------------- | --------------------: | ---------------------------: |
| Public tracking       | Reads                                         |                    60 |                 Not required |
| Shipments             | Reads, including event history                |                   600 |                          120 |
| Shipments             | Writes                                        |                   300 |                           60 |
| Payment client routes | Reads, including verification                 |                    60 |                           10 |
| Payment client routes | Writes, including initialization/cancellation |                    60 |                           10 |

GET and HEAD share a read budget. Other methods share a write budget. OPTIONS
bypasses counters. Unknown routes under a protected group also consume that
group's budget. Changing tracking ID, shipment ID, payment reference or query
parameters does not create a fresh budget. Different groups and read/write
operations have independent budgets; these are not a combined account-wide cap.

Address checks run before authentication queries. Account checks run after signed
token/live-session/current-account verification. Both must admit the request.
An account denial can therefore consume an address admission; there is no refund.
Idempotent retries also consume admissions, while database idempotency continues
to prevent duplicate business effects. Account identity is the authenticated user
ID, not a caller-provided business ID. Current product business accounts each own
one business; this is not an aggregate budget for hypothetical future staff users.

The Lua operation atomically creates a counter with a sixty-second expiry or
increments an existing counter below its limit. Rejected attempts do not extend
expiry. This is a fixed window anchored at the first admission, not a rolling
window or smooth requests-per-second guarantee. Bursts near a boundary can span
two windows. Limits are initial policy in middleware/api-protection.ts and require
representative workload tuning before release.

Keys use HMAC-SHA256 with JWT_SECRET and a separate api-budget-v1 domain. They
contain no raw IP, account ID, token, URL or idempotency key. All instances must
share the existing JWT_SECRET and Redis database; rotating the key starts fresh
budgets. IPv6 addresses share their /64 prefix, consistent with auth budgets.
Counters expire automatically. Redis restart/data loss/eviction can reset budgets;
these counters are not financial or durable business-state safeguards. Use an
appropriate Redis memory/eviction policy and monitor storage at deployment scale.

## Responses and failure behavior

- Exhausted budget: 429 with error RATE_LIMITED and Retry-After in whole seconds.
- Redis or verified-peer failure: 503 REQUEST_PROTECTION_UNAVAILABLE, Retry-After 5.
- All guard responses use Cache-Control: no-store. CORS already exposes Retry-After.

There is no per-process fallback. The dedicated Redis client disables offline
queues and request retries, with one-second connect/command deadlines. Protected
routes can return 503 during startup/reconnect until Redis is ready. Connection
retries are bounded in delay; no queued request executes later without admission.
Ambiguous Redis replies may consume an admission without executing the handler.
Errors are sanitized and report only the bounded api_budget dependency category.
The limiter connection disconnects during API shutdown.

Signed Stripe POST /api/v1/payments/webhook is registered before client request
budgets. It remains signature-checked and size-bounded during Redis failure. This
does not bypass webhook SQL validation, event idempotency or amount checks.
Database-oriented readiness intentionally remains available for auth/webhooks
during Redis degradation; it is not a claim that every route is functional.
Monitor Redis readiness, API 429/503 rates and background api_budget failures.

## Body boundaries

A common /api/v1 boundary runs before route authentication and JSON/provider work:
16 KiB for ordinary API bodies; 256 KiB for the exact Stripe POST webhook path.
Existing smaller route-specific limits remain in force. Declared lengths are
validated, and actual streamed bytes are counted even if a supplied length is
smaller. Oversized fixed/chunked bodies return 413 PAYLOAD_TOO_LARGE. Ordinary
requests must finish reading their body within ten seconds, otherwise return 408
REQUEST_TIMEOUT and cancel the stream. The same deadline applies to webhooks.
Compressed bodies are unsupported and return 415; malformed lengths return 400.
Webhook raw bytes are preserved so the signature still covers the original body.

## Configuration and deployment

No new secret, migration, paid service or GitHub allowlist change is needed.
Use the existing UPSTASH_REDIS_URL, JWT_SECRET and TRUSTED_PROXY_IPS. A reverse proxy
must overwrite X-Real-IP, and only exact trusted immediate proxy addresses may be
listed. Untrusted X-Real-IP/X-Forwarded-For headers are ignored. A trusted proxy
without a single valid verified X-Real-IP fails closed. Confirm these details on
the chosen preview host; a wrong configuration can combine users behind a proxy
or make protected routes unavailable. Users behind a shared public address share
its address budget.

Each anonymous admission uses one Redis EVAL; protected authenticated admissions
usually use two. Check free-tier command/connection limits and queue usage before
enabling hosted traffic. Local counters do not establish million-user capacity.
These controls do not cover every driver/business/profile endpoint, replace
existing PostgreSQL auth/account-action budgets, or replace edge connection,
header/URL-size, volumetric traffic, provider-spend and bot controls. Public-link
expiration/rotation remains separate work. Main/live deployments are untouched.

## Verification boundaries

api-protection.integration.mjs uses two loopback HTTP servers with separate real
Redis clients to the same disposable Redis 7 service, real JWT/session checks and
migrated PostgreSQL 17. It verifies concurrent shared admission, spoofed forwarding
headers, business-account separation, operation budgets, TTL expiry, blocked real
shipment commands with no persistent effects, Redis disconnection/recovery, raw
signed webhook acceptance and fixed/chunked body rejection. Public/payment handler
counters isolate admission behavior; they do not execute public tracking SQL or
Stripe checkout/retrieval. Shipment commands use their production router and SQL.
The webhook test uses the real signature verifier with a synthetic unrelated event;
it does not claim Stripe sandbox settlement or hosted compatibility.

Fast tests exercise streamed understated lengths, a stalled/cancelled body,
missing/invalid peers, preflight bypass, sanitized errors and invalid Redis replies.
The shared TTL has a short fixture window for expiry tests; production stays at
sixty seconds. Relevant shipment/tracking integration regressions run separately
in the same targeted report. Exact results are recorded in production-readiness.md.
