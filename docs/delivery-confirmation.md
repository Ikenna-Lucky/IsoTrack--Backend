# Recipient delivery confirmation

Businesses can deliver to people without IsoTrack accounts. `recipientEmail` is
independent of `customerId` and `customerEmail`: the latter still links an account
for existing access/payment behavior. Creation accepts optional `recipientEmail`.
The business must supply it when requesting a delivery code, including for older
shipments without recipient details. No account is created for the recipient.

## Handover flow

1. The business/driver progresses the shipment to `out_for_delivery` normally.
2. The owning business sends `POST /api/v1/shipments/:id/delivery-code` with an
   `Idempotency-Key` and `{ "expectedVersion": 4, "recipientEmail": "ada@example.test" }`.
   Only the owning business can set the recipient or request/resend a code. An
   active driver in that private fleet must be assigned. The response contains
   `challengeId`, `version` and `expiresAt`, never the code. Changing the email
   advances the workflow version; use the returned version for confirmation.
3. Durable background email sends the recipient an eight-digit code, with a
   warning to share it only after receiving the package. The code expires 20
   minutes after issuance, not after eventual email delivery. Recipient receipt
   and inbox placement are not guaranteed by SMTP acceptance.
4. The assigned driver reads `GET /api/v1/shipments/:id/delivery-code` for the
   active challenge ID/version/expiry/email-delivery state. This authenticated
   endpoint also supports the owning business. It returns no code/hash/email.
5. At handover, the recipient tells the driver the code. The assigned driver sends
   `POST /api/v1/shipments/:id/confirm-delivery`, an `Idempotency-Key` and
   `{ "expectedVersion": 5, "challengeId": "...", "code": "12345678" }`.
   Only a valid current challenge changes status to delivered, sets delivery time
   and records confirmation. Responses are no-store and omit the recipient email
   for drivers; list/detail/status projections expose it only to the business.

The ordinary status endpoint now returns 422 `DELIVERY_CONFIRMATION_REQUIRED`
for new delivered commands. A database trigger also rejects unconfirmed delivered
updates and new inserts already marked delivered, including internal helper
writes. Existing delivered history is retained without inventing proof. Already
committed old status requests can replay their old response, not create a new
delivery. No business override or anonymous confirmation endpoint is provided.

This records possession of a code sent to a business-selected email. It does not
establish legal identity, location or physical handover, and cannot prevent a
recipient sharing early, forwarding mail, a compromised inbox or business/driver
collusion. It is one operational confirmation method, not a signature/photo or
absolute proof. Wrong addresses and unavailable email require a business resend;
the driver cannot bypass confirmation.

## Retry, guessing and resend boundaries

Keep the same key and body when retrying an uncertain request. Issuance and
confirmation have separate user/operation scopes, 24-hour key windows and durable
tombstones. Replays return `Idempotency-Replayed: true`. Confirmation fingerprints
are keyed, so the low-entropy code cannot be guessed offline from a database
fingerprint. Plaintext codes never enter SQL parameters, stored request bodies,
API responses or log events. They exist transiently in validation/email memory
and in the recipient's email; the server cannot control that mailbox's retention.

Wrong-code results are saved too: a same-key replay does not count another guess.
A newly entered code is a new confirmation attempt and requires a new key.
Changing a body under an existing key returns 409 `IDEMPOTENCY_KEY_CONFLICT`.
Five distinct wrong attempts lock that challenge; new keys cannot reset its
counter. Expired/revoked/locked challenges return 409
`DELIVERY_CODE_UNAVAILABLE`; stale workflow versions return 409
`SHIPMENT_VERSION_CONFLICT`. An inaccessible shipment returns 404; unsupported
roles return 403. Malformed IDs, bodies, codes and keys receive 400; body size is
limited to 2 KiB. Codes must be eight decimal characters, preserving leading zeros.

Resends wait at least one minute, permit at most three issuances per shipment
in a rolling hour, and share a durable business budget of 60 issuances per clock
hour. Budget denials return 409 `DELIVERY_RATE_LIMIT`. A resend revokes the old
challenge atomically. Status, driver or recipient changes invalidate its version/
assignment binding. An SMTP send already in progress may still deliver an old
email, but its revoked code cannot confirm delivery. Refresh challenge metadata
after a resend rather than relying on an old issuance replay.

Request record, code issuance/recipient update or successful consumption, shipment
version/status/time, history event and captured notifications commit in one
PostgreSQL transaction. Wrong guesses commit only their counter/result. Outbox/
history errors roll back a successful confirmation, allowing same-key recovery.
Same-key races replay; distinct keys competing for delivery produce one success.
Locks wait at most two seconds each; dependency errors remain safe server errors.

## Delivery worker and operations

The existing Gmail SMTP transport and dispatcher lifecycle host the new worker.
No new paid service is used. It claims up to five records, leases for two minutes,
retries with bounded exponential delays (maximum five attempts), marks exhausted
work dead and fences old workers. Every send rechecks status/version/driver/
recipient/expiry/consumption/revocation and the configured key's proof. Secret
rotation skips obsolete queued codes; issue fresh challenges after reconciliation.
SMTP is at least once: losing acknowledgement after acceptance can duplicate the
same email. A stable Message-ID is provided, not a deduplication guarantee.

Pending, dead and expired processing work appear in `delivery_emails`,
`delivery_email_dead` and `delivery_email_leases` metrics. Existing overdue,
dead-letter and expired-lease alert rules cover them. Configure and test the
deployed alert receiver before launch. `npm run delivery:status` prints aggregate
state counts without recipient/code data; schedule `npm run delivery:purge` to
delete at most 5,000 expired, unconsumed records older than seven days and consumed
records older than 90 days per invocation, excluding processing work. These are
documented engineering defaults; approve retention/legal/support requirements
before deployment. Idempotency bodies use the existing separate scrub schedule;
shipment recipient retention follows the remaining shipment lifecycle policy.

## Configuration and rollout

Apply migration 0013 and deploy updated API and worker together. Add an independent
`DELIVERY_CODE_SECRET` containing 32 random bytes encoded as 64 hex characters.
Generate locally with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`
and copy it into your private environment file. Never commit the value or put it
in frontend configuration. Existing Gmail credentials/EMAIL_FROM remain in use.
Missing delivery secret returns 503 for issuance/confirmation and does not permit
the old delivered status path. Restore this secret with the database during
recovery, or rotate and issue fresh challenges; deployment must arrange secret
backup/access and rotation without exposing it.

Coordinate frontend recipient entry, issuance, metadata refresh and driver code
entry. Stop old write-serving instances; retain the additive schema on rollback
and prefer forward repair. Never disable the proof trigger to bypass a failed
handover. Real provider delivery, browser/ingress adoption, migration locks,
restore reconciliation and capacity remain deployment gates. No configured
database migration, real email, frontend edit or deployment was performed.

Tests use disposable PostgreSQL, production signed JWT/session and HTTP code,
the actual SMTP transport to a local sink, durable worker/SQL and injected commit/
outbox failures. They cover guest recipients, retry/race/expiry/revocation/limits,
authorization, direct SQL bypass, rollback, resend, SMTP exhaustion/lease recovery,
secret rotation, private fields, metrics and retention. This is not evidence of
Gmail inbox delivery, deployed Bun/Neon behavior or physical receipt. See the
readiness register for actual run results, incomplete runs and remaining gates.
