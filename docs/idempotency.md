# Idempotent shipment and checkout requests

Both `POST /api/v1/shipments` and `POST /api/v1/payments/initialize` now require an
`Idempotency-Key`. This is a backend API contract change; frontend adoption is not
part of this build. Missing or malformed keys return 400 before reserving work.

Shipment assignment, status updates and cancellation also require keys and an
expected shipment version. They use a single database transaction rather than
the creation/checkout lease protocol. See [shipment commands](shipment-commands.md)
for their body, conflict, replay and coordinated rollout contract.

## Client contract

Generate a random UUID once for each intended action and retain it with that
action's request body. Reuse both for network retries, double-click prevention and
retry after an ambiguous server/provider error. Do not generate a new key inside
every retry attempt. Do not put personal information in keys.

```js
const operationKey = crypto.randomUUID();
const response = await fetch(`${apiUrl}/api/v1/shipments`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "Idempotency-Key": operationKey,
  },
  body: JSON.stringify(shipment),
});
// If the response is lost, retry this action with operationKey and the same body.
```

Keys accept 16–128 ASCII letters, digits, hyphens and underscores. Scope is the
authenticated user plus operation: another user's key or the same key on the other
operation is independent. The server stores a SHA-256 key hash, not the raw header.
Migration 0009 additionally serializes payment initialization by shipment across
keys and users. An existing uncertain checkout blocks replacement; provider expiry
and reconciliation rules are described in docs/payments.md. This does not promise
that a provider can never collect twice during an external settlement race.

The fingerprint uses validated, normalized data with deterministic object-key
ordering. JSON property ordering does not matter. Email casing, default address
state, trimmed descriptions and equivalent ISO pickup timestamps normalize before
hashing. Meaningful changes with an already reserved key receive 409
`IDEMPOTENCY_KEY_CONFLICT`. Unknown request fields are rejected. Shipment bodies
are limited to 16 KiB and checkout bodies to 4 KiB; fields have explicit bounds.
Customer IDs must resolve to active customer accounts. Unmatched customer emails
remain unlinked, consistent with the existing guest tracking behavior.

Successful replays return the original HTTP status and saved body, with
`Idempotency-Replayed: true`; the first successful result has `false`. Responses use
`Cache-Control: no-store`. Shipment creation remains 201 and checkout initialization 200. A creation replay is a snapshot of the original creation, not the shipment's
latest status; use the detail endpoint for current state. Current resource access
is checked before returning cached data. Ownership changes can therefore deny a
replay instead of exposing an old private response.

Concurrent requests while an owner holds the lease receive 409
`IDEMPOTENCY_IN_PROGRESS` and `Retry-After: 1`. Retry the same key/body with backoff
and jitter, respecting that header; do not poll in a tight loop. CORS permits the
request header and exposes the replay/retry headers to the configured frontend.
Authentication, role, malformed JSON and validation failures do not reserve keys.

## Database boundary and interruption recovery

Migration `0007_request_idempotency.sql` adds durable request records with unique
user/operation/key scope, original parameters/resource IDs, stored responses and
60-second ownership leases. PostgreSQL serializes reservation/claim conflicts.
The original fingerprint and parameters are never replaced by a racing request.

Reservation and claim are separate statements. If a process stops after claiming,
the next caller can reclaim the same reservation when the lease expires. Ownership
tokens fence former owners: an expired or replaced owner cannot commit a resource
or response. Dependency failures remain server errors, and clients must preserve
the original key. Normal failed processing releases its lease; a lost database
acknowledgement can require waiting for expiry.

Shipment insertion, initial history and stored creation result use one SQL
statement/transaction. The existing outbox trigger participates in that transaction.
Capture/history failure therefore rolls back creation and its saved result. A
committed write with a lost response is replayable without a second shipment,
history event or notification set. New tracking IDs use sixteen random characters
after the prefix; older tracking IDs remain supported.

Checkout stores one local payment ID, reference, original email/amount/URLs and full
Stripe parameter set before contacting the provider. Retries use those values and
the same internal Stripe key, including across service instances. Changed email or
return URL configuration does not silently alter an existing provider request.
Current access, payable state and the original price are rechecked before retrying
an incomplete attempt. Provider response validation checks reference, shipment,
amount, NGN currency, mode and HTTPS Stripe-hosted checkout URL. Custom checkout
domains are not enabled by this implementation.

Session attachment and the saved successful response commit atomically. A database
failure before attachment can retry through Stripe's key; a lost acknowledgement
after commit replays locally without another provider request. Signed webhooks and
verification retain their existing payment confirmation behavior. Already-issued
provider links and in-flight calls are not revoked by this mechanism when shipment
ownership or price changes; checkout expiry/cancellation and reconciliation remain
part of the payment lifecycle work.

## Expiry, provider uncertainty and credential rotation

The application key window is 24 hours from reservation. After expiry, the same
key receives 410 `IDEMPOTENCY_EXPIRED` and never starts another operation. Compact
tombstones remain for the account's lifecycle, so cleanup does not turn an old key
into a new create request. A new action needs a new key; an ambiguous payment first
needs reconciliation, not an automatic switch to a new key.

Incomplete checkout creation stops provider retries after 23 hours from reservation,
leaving a conservative margin before Stripe API v1 may prune its keys. It returns
409 `RECONCILIATION_REQUIRED`; a completed cached response can still replay within
the application window without a provider call. The same reconciliation response
applies if the configured Stripe credential/API-version binding changes. This is
conservative: even rotation to another key for the same account requires reviewing
pending attempts. No Stripe credential is stored in the request parameters; only
the binding hash is stored.

A provider/storage failure can occur after Stripe has accepted the request.
Errors for an established payment attempt include its local reference where
available. Preserve that reference, key and body. Verify the payment, inspect the
corresponding local record/Stripe request logs and signed webhook outcomes, and
reconcile before starting a replacement operation. The API now runs a database-backed
reconciliation sweep and provides operator commands (docs/payments.md); an operator
UI is not implemented. A cached Stripe 500 can remain an
ambiguous outcome; the application never rotates its key to escape that result.

These constraints follow Stripe's official
[API v1 idempotency](https://docs.stripe.com/api/idempotent_requests) and
[error/retry guidance](https://docs.stripe.com/error-low-level). Stripe retains
API v1 keys for at least 24 hours and may execute a new operation after pruning.
The local provider fixture tests failure handling; it is not evidence of live
Stripe sandbox compatibility or account configuration.

## Retention and rollout

Run `npm run idempotency:scrub` with Bun and backend environment configuration to
clear request parameters and cached responses older than 30 days, in batches of at
most 5,000. It does not delete key fingerprints or resource identities, remove
shipments/payments, or enable key reuse. Configure scheduling and monitor table
size. Tombstone growth, rate/cardinality controls, partitioning/archival and broader
offboarding/retention decisions need measured production planning.

Apply migration 0007 before running this backend, and coordinate client rollout of
the required header. Stop old write-serving instances during cutover: older code
bypasses this mechanism. Do not fall back to non-idempotent writes when a key is
missing or the database is unavailable. Returning to old code loses this guarantee;
retain the additive schema and prefer forward repair. No new secrets are required,
and no production migration or deployment was performed.

## Verification

The new integration suite applies the actual migration chain in disposable
PostgreSQL and exercises the production Hono command handlers/service/SQL with real
jose signatures and the production session predicate through a psql adapter. A
local HTTP fixture uses the official Stripe SDK, records keys/parameters and can
accept a session while dropping responses. The SDK's built-in first connection-
reset retry is accounted for: both responses are lost to expose the error to the
application, then another service instance recovers with the same provider key.

Cases cover HTTP auth/validation/roles, original result replay, independent user/
operation scopes, concurrent ownership and mismatched fingerprints, transactional
outbox rollback, lost claim/commit acknowledgements, stale-owner fencing, expiry/
scrubbing, checkout contention/replay, immutable provider parameters, failed/lost
attachment, provider retry/configuration cutoffs, current ownership/price and
invalid provider responses. Fixture timestamps accelerate lease/expiry scenarios;
these transport fault injections are not claimed as killed-process tests.

Fast tests cover canonicalization, input normalization, invalid keys, browser CORS
and internal-vs-input error boundaries. Full reports use the existing CI runner.
No external Stripe request, production database or frontend edit was made. Actual
Neon transport, deployed Bun behavior, browser adoption, provider sandbox journeys,
remote CI and workload/cost testing remain separate verification gates.
