# Retrying shipment updates safely

Apply migration `0011_shipment_commands.sql` before this backend serves writes.
This is a coordinated API change for three routes:

| Route | Required JSON body |
| --- | --- |
| `PATCH /api/v1/shipments/:id/assign` | `{ "driverId": "...", "expectedVersion": 0 }` |
| `PATCH /api/v1/shipments/:id/status` | `{ "status": "picked_up", "expectedVersion": 1, "note": "Collected" }` |
| `DELETE /api/v1/shipments/:id` | `{ "expectedVersion": 1 }` |

All require authenticated access and `Idempotency-Key`. Existing shipment
responses now include `version`, initially zero. Read the current shipment before
starting an action; copy its version into `expectedVersion`. Keep one random key
and the same body for retries of that action. Do not refresh the version or change
the key automatically after an uncertain network/server failure.

Successful commands return 200, the updated shipment and
`Idempotency-Replayed: false`. A retry returns the original shipment snapshot and
`Idempotency-Replayed: true`, even if later commands changed the shipment. Reload
the detail endpoint for current state. Cancellation now returns its updated
shipment rather than null. All command responses use `Cache-Control: no-store`.

The version increases when shipment status or driver assignment changes. GPS,
payment flags and unrelated timestamp updates preserve it. A database trigger
also advances the version for older internal transition helpers, so cycling from
pending to assigned to failed to pending cannot revive a stale command. This is
a workflow version, not optimistic concurrency for every shipment field.

Missing/malformed keys or version/body fields receive 400. Versions are integers
from zero through 2,147,483,646. Bodies are bounded to 4 KiB, notes to 1,000
characters and IDs to 128 characters; unknown fields are rejected. Note/driver-ID
whitespace is trimmed before fingerprinting. Assignment uses its dedicated route;
status changes cannot set assigned directly. Drivers can progress only assigned
shipments and cannot assign, retry or cancel. A business can update only its own
shipments and assign an active driver in its private fleet.

## Conflicts and retry rules

Keys are hashed and scoped by authenticated user plus `shipments.update`. The
fingerprint includes the shipment ID, action, expected version and normalized
body. Reusing one key for a different shipment/action/body receives 409
`IDEMPOTENCY_KEY_CONFLICT` when current access permits inspecting that request.
A stale version receives 409 `SHIPMENT_VERSION_CONFLICT`; reload and let the user
decide whether to create a new action. An invalid transition receives 422;
unavailable/cross-fleet drivers receive 409 `DRIVER_UNAVAILABLE`. Inaccessible
shipments receive 404 and unsupported roles/actions receive 403.

Only successful results are retained. Validation, authorization, stale-version and
invalid-transition failures do not leave a new command reservation. Committed
keys expire after 24 hours and return 410 `IDEMPOTENCY_EXPIRED`; tombstones are
retained, and the existing scrub command clears old bodies without enabling key
reuse. Current access is checked before replay, including after waiting for a
concurrent request; cached results cannot restore lost membership/access.

The database function serializes identical keys, then locks the shipment.
Distinct keys competing on the same version cannot both change it. Same-key
requests can wait for the first transaction and replay its result. Unlike the
creation/checkout lease protocol, there is no committed processing lease for
these commands. A two-second lock timeout bounds each lock wait; lock/storage
failures remain server errors. Preserve the same key/body and retry with bounded
backoff. There is no guarantee of a 409 in-progress response under contention.

Shipment change, version increment, history event, triggered notification capture
and saved successful snapshot commit in one PostgreSQL transaction. A failure
rolls all of them back. Losing the database acknowledgement after commit can
return a server error despite a successful action; the same key recovers its
saved result without repeating events or notifications. This protects database
effects, not exactly-once external email/provider delivery.

## Rollout and verification

Existing rows receive version zero; no historical version is inferred. The
additive migration also expands the request-operation constraint and installs the
version trigger/command function. Readiness now requires the version column.
The schema change/constraint scan and locks need rehearsal at deployment scale.

Stop old write-serving instances during cutover: old handlers accept writes
without keys or client versions, even though the trigger advances their version.
Coordinate frontend adoption of the required header and JSON body, especially
DELETE bodies through ingress. Reverting to old write handlers loses these
guarantees; preserve the additive schema and prefer forward repair. Older cached
creation results can lack a version; read the current detail before updating.
No live migration, deployment or frontend edit was performed.

`tests/shipment-commands.integration.mjs` uses an actual loopback HTTP server,
signed jose tokens, production authentication/session predicates and command
router, the production migration runner and disposable PostgreSQL 17. Its psql
fixture adapter replaces Neon transport, not SQL behavior. Tests cover invalid
inputs/roles/tenants, original-result replay, same/different-key contention,
status cycles, post-commit acknowledgement loss, notification-trigger rollback,
driver permissions/current-access replay, expiry and version scope. The complete
integration suite checks compatibility with existing boundaries. Hosted Neon,
the full Bun entrypoint, browser adoption, actual proxy behavior and load remain
separate release gates. See the readiness register for execution results.
