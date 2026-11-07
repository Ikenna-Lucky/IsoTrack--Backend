# Stripe Checkout

IsoTrack uses Stripe-hosted Checkout for one-time NGN shipment payments. The
backend creates the session and the frontend redirects to its hosted URL. No
publishable key, Stripe.js script, product ID or price ID is needed for this flow.
Amounts remain NGN minor units (kobo); no currency conversion is performed.

## Portfolio payment policy

The public portfolio deployment will continue to use Stripe sandbox payments.
Public hosting and `NODE_ENV=production` do not imply real-money processing.
`STRIPE_MODE` defaults to `disabled`; credentials alone do not activate payments.
Selecting `sandbox` requires a test server key (`sk_test_` or `rk_test_`) and its
webhook signing secret (`whsec_`). Live keys and live-mode configuration are
rejected in local, preview and production environments. The client, Checkout
validation, payment reconciliation and signed callbacks require `livemode=false`.
Key prefixes validate configuration shape, not key authenticity or sandbox identity;
actual provider verification remains necessary. The API key and webhook secret
must belong to the same sandbox and destination.

Sandbox mode also enables the existing bounded payment reconciliation loop in
preview. Notification workers and automatic retention remain disabled. The loop
uses PostgreSQL leases and at most two provider operations concurrently per process.
CI preview preparation stays disabled for Stripe and needs no provider secrets.

## Dashboard and environment setup

Select a Stripe sandbox and obtain a secret API key from
[API keys](https://dashboard.stripe.com/apikeys). Configure the backend `.env`:

```dotenv
STRIPE_MODE=sandbox
STRIPE_SECRET_KEY=sk_test_REPLACE_ME
STRIPE_WEBHOOK_SECRET=whsec_REPLACE_ME
FRONTEND_URL=http://localhost:3000
```

In Workbench / Webhooks, add an event destination for **your account**, using
snapshot events and API version **2026-10-28.endive** (the installed SDK's version).
Subscribe to:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.expired`
- `checkout.session.async_payment_failed`

For deployment set its public HTTPS URL to
`https://YOUR_API_HOST/api/v1/payments/webhook`. Reveal that endpoint's signing
secret and set `STRIPE_WEBHOOK_SECRET`. This secret is separate from the API key.
Use keys and webhook destinations from the same sandbox.

For the existing Render preview, first deploy this configuration build with Stripe
still disabled. Then save these three values together on the preview Web Service:
`STRIPE_MODE=sandbox`, the private test `STRIPE_SECRET_KEY` and that destination's
`STRIPE_WEBHOOK_SECRET`. Save/redeploy and confirm `/health/ready` and the release
SHA. Do not add these provider secrets to GitHub preview preparation or its smoke
configuration; preparation and read-only smoke do not require them.

The public portfolio service can use the same sandbox mode later, with a webhook
pointing to that service. Keep its Stripe sandbox separate from preview where
available so testing cannot modify demo payment records. No Connect, subscriptions,
live activation or live keys are required for this portfolio payment policy.

## Actual provider verification (pending)

After deployment/configuration, create Checkout through the application's payment
endpoint for a synthetic shipment, preserving the Idempotency-Key on retries.
Open the returned Stripe-hosted URL and use Stripe's documented test card values.
Check the corresponding sandbox event delivery reaches the registered preview
webhook with HTTP 200, then read the shipment/payment state and confirm exactly one
applied receipt. Repeat delivery of the same event through Stripe Dashboard and
verify no duplicate effects. A fabricated CLI event without the application's
session/reference does not establish settlement correctness.

Also exercise a declined test payment, unpaid session expiration, reconciliation
and the supported review/refund path. The current operator refund command only
handles additional-money review balances; applied-payment/partial refunds and
disputes still require their own product policy. Record the release SHA, synthetic
reference/session/event IDs, HTTP results and receipt counts without secrets,
card data, login tokens or Checkout URLs in shareable reports. Reconciliation or
`/verify` can also settle a payment, so a paid database flag alone does not prove
successful provider webhook delivery: inspect the actual Stripe delivery record.

Official [sandbox test cards](https://docs.stripe.com/testing) simulate payments
without moving money. This provider exercise is not a load test.

For local development, install the Stripe CLI, log in, and run:

```sh
stripe listen --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.expired,checkout.session.async_payment_failed --forward-to localhost:8000/api/v1/payments/webhook
```

Use the **whsec_ printed by this CLI command** locally, not the Dashboard endpoint's
secret. Restart the backend after changing `.env`. The CLI forwards events to the
local backend; Dashboard destinations cannot directly reach localhost. Test with
Stripe's documented test cards in the actual Checkout flow after setup.

## Migration and API

Apply `0004_stripe_checkout` before running the updated application. It renames
the legacy reference column/index/constraint without losing values, marks existing
records `legacy`, defaults future rows to `stripe`, and adds unique session IDs.
Historic migration SQL and snapshots retain the former provider names because
rewriting applied migrations would corrupt the migration history. No live migration
was performed during development.

- `POST /payments/initialize` requires `Idempotency-Key`, authorizes the business/
  customer's shipment, saves one durable pending reference/parameter set per key,
  creates Checkout with a stable Stripe key and atomically saves the session/result.
  Returns `reference`, `authorizationUrl`, `sessionId`, `amountKobo`. Apply migration
  0007 as well; see docs/idempotency.md for retry, expiry and client requirements.
- `GET /payments/verify/:reference` checks ownership, retrieves the stored Checkout
  Session using the server key, and confirms only paid, complete, correctly bound
  sessions. A redirect parameter alone never proves payment.
- `POST /payments/webhook` is public, verifies the raw body with the official SDK,
  checks timestamp tolerance and environment mode, and handles the four supported
  Checkout events. Unpaid completion is acknowledged without marking paid.

Webhook confirmation and verification share an atomic, locked PostgreSQL statement
checking provider, reference, session binding, amount, NGN currency and local state.
Current shipment price/status determine whether a valid receipt applies or needs
review. Duplicate confirmations preserve the first receipt; legacy/refunded
payments cannot be confirmed as new Stripe payments. Provider binding/amount
mismatches return non-success for investigation/retry. The stored paid timestamp represents
the first confirmed success event or server verification, not a card settlement date.

## Verification and release limits

Official SDK test signatures and disposable PostgreSQL verify webhook behavior,
atomic writes, concurrency, migration preservation and replay. Stripe network calls,
actual Checkout UI, redirects in a browser and dashboard event delivery still need
a sandbox run after the keys are configured. Type checks do not prove those flows.

Migration 0009 adds a shipment checkout guard, a single applied-payment receipt,
provider reconciliation and additional-payment review. See the lifecycle runbook
below. Provider sandbox journeys, disputes, payment abuse controls and operational
alerts remain release work. Private-fleet settlement recipients/Stripe Connect
remain a product decision, not an implemented marketplace payout system.

## Checkout lifecycle and operator recovery

Apply the complete migration journal through **0009_payment_lifecycle** before
starting this version. Drain older write-serving instances during cutover; older
code does not acquire the shipment guard. The migration takes ordinary table
locks and backfills existing records; rehearse its duration on representative data.
Existing pending Stripe attempts quarantine their shipment with a legacy guard
until all uncertain attempts have been reconciled. No automatic deletion or
assumption that an unattached provider call failed is made. Historical successes
retain their status; the earliest receipt wins and additional successes are flagged.

Different keys and payers now contend for one guard per shipment and receive 409
`CHECKOUT_ALREADY_ACTIVE` without another payer's reference or URL. Same-key
replays require an active, payable checkout at the original price; closed keys
return 409 `CHECKOUT_CLOSED`. Preserve ambiguous attempts rather than rotating keys.

`POST /api/v1/payments/:reference/cancel` requires current shipment access. The
server asks Stripe to expire an open session, then records the authoritative
result. Following `cancel_url` only navigates the browser; it does not cancel a
payment. A complete/unpaid or processing PaymentIntent keeps the guard until a
provider-confirmed cancelled intent proves it cannot collect. A failed
async payment event also keeps the guard until terminal provider state proves
replacement is safe. Network uncertainty keeps the attempt reserved.

The API process runs a PostgreSQL-backed sweep every 30 seconds, claiming at most
ten attempts with five-minute leases and two provider operations in flight. Due
attempts are retried after five minutes. Replicas coordinate through row leases;
the timer requires a continuously running API process. No Redis queue is required.
Attached sessions are retrieved. Missing create responses recover using the exact
saved parameters and original Stripe key only within 23 hours and the same
credential context. Beyond that window, scrubbed parameters or rotated credentials
require operator recovery. The worker never invents a new provider key to escape
an unknown outcome. Failures emit count-only structured events; wire collection,
alerts and operator ownership before release.

Successful confirmation locks the shipment, applies at most one receipt, marks it
paid and captures notifications in one transaction. Extra receipts, changed prices
or no-longer-payable shipments retain `received_at`, `checkout_state=review` and a
`review_reason`, without another fulfillment notification. Verification returns
`paid` (provider observation), `applied` (accepted local receipt), `checkoutState`
and `requiresReview`; clients must use `applied` for shipment payment success.
An already-open provider payment can finish during cancellation, so duplicate
collection is recorded and reviewed rather than claimed impossible.

With Bun and the backend environment configured:

```sh
npm run payments:status
npm run payments:reconcile -- IST-PAY_REFERENCE
npm run payments:attach -- IST-PAY_REFERENCE cs_KNOWN_SESSION
```

Status lists the oldest 100 pending/review records. Use Stripe Dashboard request
logs/reference metadata to find an unknown session; `attach` retrieves it and
validates reference, shipment, amount, currency, mode and existing session binding.
Do not manually clear guards or rerun an old unknown create with a new key.

For an additional payment, review the local receipt and Stripe Dashboard, issue
the appropriate full refund in Dashboard, wait for `succeeded`, then record proof:

```sh
npm run payments:record-refund -- IST-PAY_REFERENCE re_REFUND operator-identity
```

This command retrieves the refund and Checkout session, checks their PaymentIntent,
full NGN amount and success state, and records a unique refund ID, operator and
timestamp. It does not initiate refunds. Failed, partial, unrelated or repeated
resolutions are rejected. Review reasons remain as audit history. Applied-payment
refunds, partial refunds and disputes need a separate product/accounting policy;
this command deliberately resolves only flagged review balances. Access to these
commands is backend operator access, not a public admin endpoint.

Local fixtures exercise the official Stripe SDK over loopback HTTP and real
PostgreSQL. They do not prove Stripe sandbox behavior, payment-method eligibility,
Dashboard configuration, Neon transport, deployed scheduling or browser adoption.

Provider contracts: [expire Checkout](https://docs.stripe.com/api/checkout/sessions/expire),
[API idempotency](https://docs.stripe.com/api/idempotent_requests),
[retrieve refund](https://docs.stripe.com/api/refunds/retrieve).

Sources: [Checkout fulfillment](https://docs.stripe.com/checkout/fulfillment.md?ui=full-page),
[webhook signature verification](https://docs.stripe.com/events/manage-webhook-endpoints#signature-errors),
[API keys](https://docs.stripe.com/keys).
