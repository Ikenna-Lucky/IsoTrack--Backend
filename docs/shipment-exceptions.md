# Failed deliveries and returns

Migration `0014_shipment_exceptions` adds a private exception workflow. A return keeps
shipment status `failed` and records a separate `returnState`; this avoids changing
the PostgreSQL status enum and preserves existing payment rules. This build does
not issue refunds, calculate return charges or change the delivery address.

## Commands and permissions

Send `POST /api/v1/shipments/:id/exceptions` with a fresh `Idempotency-Key`
(16–128 characters) and JSON `{ action, expectedVersion, reason?, note? }`.
Use the current shipment version; a conflicting concurrent command returns 409.
Matching keys replay the original result, changed requests conflict, and keys expire
after 24 hours without becoming reusable. Denied commands leave no workflow writes.

| Action           | Actor                                   | Result                                                        |
| ---------------- | --------------------------------------- | ------------------------------------------------------------- |
| `fail`           | Business owner or assigned fleet driver | Assigned/picked-up/in-transit/out-for-delivery becomes failed |
| `retry`          | Business owner                          | Failed shipment starts another attempt, maximum three total   |
| `return_request` | Business owner                          | Requests return of a picked-up failed package                 |
| `return_start`   | Assigned fleet driver                   | Requested return enters transit                               |
| `return_receive` | Business owner                          | Confirms receipt from requested or in-transit return          |
| `cancel_failed`  | Business owner                          | Cancels a failed shipment that was never picked up            |

Failure requires one of `recipient_unavailable`, `recipient_refused`,
`address_incorrect`, `recipient_code_unavailable`, `package_damaged`, `vehicle_issue`
or `other`. Notes are at most 1,000 characters; `other` requires an explanation.
Customers cannot execute commands or read exception notes. Cross-business access
is denied, and authorization is checked again after waiting for shipment locks.

Before pickup, retry clears assignment and returns to pending. After pickup, retry
keeps the driver, original pickup time and latest GPS sample, returning to picked-up.
Every retry advances the attempt count, including failures before pickup. Once a
return is requested, retry is unavailable. Receipt completes the return permanently;
a later delivery requires a new shipment. Business receipt is an accountable
attestation, not independent proof of physical handover.

Database guards prevent clearing custody, resetting pickup, cancelling a package
in custody or bypassing attempt limits with direct updates. Each exception command
atomically saves the shipment, event, private audit, notification outbox and replay
result. Existing unconsumed delivery codes are revoked. Issue a fresh code when a
retried delivery reaches the confirmation stage.

## Audit, driver work and monitoring

`GET /api/v1/shipments/:id/exceptions` is restricted to the owner and current assigned
driver. Results descend by version; use `limit` (default 20, maximum 50) and the
returned `nextBeforeVersion` as `beforeVersion` while `hasMore` is true. Private
notes and actor details stay out of public shipment events and notification text.

Failed packages remain in the driver's default list while in custody. GPS writes
resume during `returnState=in_transit` and stop at receipt. Existing sample-order,
session, fleet and traffic checks still apply. Retrying with the same driver does
not reset GPS ordering.

Notifications use the durable outbox and existing account preferences, with titles
for delivery retry, return request, return transit and return receipt. This does
not introduce general status emails to guest recipients.

The `held_packages` backlog measures failed packages still in custody. The
`IsoTrackHeldPackageOverdue` warning fires after age exceeds 24 hours for ten minutes.
Age starts at `failed_at`, unaffected by GPS updates. Legacy rows without a failure
time use creation time conservatively; this does not establish the historical
failure date. Reconcile legacy custody and attempt counts before launch: historical
rows default to attempt one and return state none.

## Rollout and verification

Apply the complete journal through 0014 before serving new code, and stop old
write-serving instances. Generic status commands for new failed/pending transitions
now require the exception endpoint; completed matching historical keys can replay.
Frontend adoption is required. No new secret is needed. Transactional index builds
need lock/disk/time rehearsal on representative data; this is not an online migration
claim. No configured database migration or deployment was performed here.

`tests/shipment-exceptions.integration.mjs` exercises real PostgreSQL and signed
HTTP requests: permissions, retries, custody, concurrent commands, lost acknowledgements,
rollback, private history, GPS, outbox processing, backlog age and key expiry.
See the readiness register for executed results and retained failures. Local tests
do not establish hosted Neon/Bun behavior, real provider delivery, remote CI success
or capacity for millions of users.
