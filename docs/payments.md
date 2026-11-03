# Payment confirmation

`POST /api/v1/payments/webhook` is public and validates the exact request bytes
with HMAC-SHA512 and a timing-safe comparison before parsing or processing. It
requires a configured Paystack secret, limits requests to 256 KiB, rejects invalid
signatures and malformed success events, and ignores unsupported signed events.
Other payment routes require an authenticated business or customer account.

Signature and response behavior were checked against
[Paystack webhook documentation](https://paystack.com/docs/payments/webhooks/).
Provider success verification follows the distinction between transport success
and transaction success in
[Paystack verification documentation](https://paystack.com/docs/payments/verify-payments/).

## Confirmation invariant

Webhook success and manual verification share a PostgreSQL confirmation statement.
It locks the payment and shipment, checks the reference, initialized amount,
current shipment price and supported currency (NGN), then writes payment success
and the shipment paid flag atomically. A storage failure rolls back both writes.
Repeated success preserves the first channel and payment timestamp. Refunded or
failed local payments are not converted back to success by an old callback.
This is repeat-safe confirmation, not a general payment event ledger.

An unmatched successful webhook receives 409; a storage failure receives 500,
allowing provider retry. No success acknowledgment occurs before database commit.
Unknown references and amount/currency mismatches require operational investigation;
monitoring and reconciliation remain required before release.

## Initialization and manual verification

Initialization authorizes the shipment and stores a pending reference before
calling Paystack, avoiding a webhook arriving before the local record exists.
Provider requests have a 10-second deadline and validate response shape/reference.
Provider failure or timeout leaves a pending record for future reconciliation.

Manual verification resolves the local payment and checks shipment access before
contacting the provider. Successful responses require a complete receipt, matching
reference, and successful atomic confirmation. Pending/failed responses do not
require a paid receipt and cannot mark anything paid. A reversed provider response
does not itself implement a refund or reverse local accounting.

## Evidence and limits

Fast HTTP tests cover signatures, byte changes, malformed payloads, user-auth
boundary, body limits and storage/unmatched errors. PostgreSQL tests cover paired
updates, duplicate receipts, mismatches, refunded state, forced rollback, competing
confirmations and signed HTTP webhook persistence/replay.

Tests use locally generated signatures and psql execution of production SQL, not
real Paystack sandbox requests or deployed Neon HTTP. Full initialization/manual
verification HTTP journeys and deployed routing still require verification.

Outstanding release work includes initialization idempotency and duplicate-charge
handling, provider reconciliation, durable event/audit records, refunds/disputes,
abuse controls, alerting, and the payment recipient/settlement product model.
Do not blindly repeat initialization after a timeout: multiple pending references
can represent multiple payment attempts. There is no promise of exactly-once
charging or complete financial accounting. No migration was needed and no live
payment or application database operation was performed during this batch.
