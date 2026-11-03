# Stripe Checkout

IsoTrack uses Stripe-hosted Checkout for one-time NGN shipment payments. The
backend creates the session and the frontend redirects to its hosted URL. No
publishable key, Stripe.js script, product ID or price ID is needed for this flow.
Amounts remain NGN minor units (kobo); no currency conversion is performed.

## Dashboard and environment setup

Select a Stripe sandbox and obtain a secret API key from
[API keys](https://dashboard.stripe.com/apikeys). Configure the backend `.env`:

```dotenv
STRIPE_SECRET_KEY=sk_test_REPLACE_ME
STRIPE_WEBHOOK_SECRET=whsec_REPLACE_ME
FRONTEND_URL=http://localhost:3000
```

In Workbench / Webhooks, add an event destination for **your account**, using
snapshot events and API version **2026-10-28.endive** (the installed SDK's version).
Subscribe to:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`

For deployment set its public HTTPS URL to
`https://YOUR_API_HOST/api/v1/payments/webhook`. Reveal that endpoint's signing
secret and set `STRIPE_WEBHOOK_SECRET`. This secret is separate from the API key.
Use keys and webhook destinations from the same sandbox or live environment.

For local development, install the Stripe CLI, log in, and run:

```sh
stripe listen --events checkout.session.completed,checkout.session.async_payment_succeeded --forward-to localhost:8000/api/v1/payments/webhook
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
  checks timestamp tolerance and environment mode, and handles both supported
  Checkout events. Unpaid completion is acknowledged without marking paid.

Webhook confirmation and verification share an atomic, locked PostgreSQL statement
checking provider, reference, session binding, amount, NGN currency, shipment price
and local payment state. Duplicate confirmations preserve the first receipt;
legacy/refunded payments cannot be confirmed as new Stripe payments. A mismatch
returns non-success for investigation/retry. The stored paid timestamp represents
the first confirmed success event or server verification, not a card settlement date.

## Verification and release limits

Official SDK test signatures and disposable PostgreSQL verify webhook behavior,
atomic writes, concurrency, migration preservation and replay. Stripe network calls,
actual Checkout UI, redirects in a browser and dashboard event delivery still need
a sandbox run after the keys are configured. Type checks do not prove those flows.

Application idempotency now protects retries of the same user's operation/key,
including interrupted SDK calls. Distinct keys/users can still create distinct
attempts; this is not global double-charge prevention. Reconciliation, refunds/
disputes, event/audit history, abuse controls and operational alerts remain release
work. Pending provider outcomes require reconciliation once the safe retry window
ends or credentials change. Private-fleet settlement recipients/Stripe Connect
remain a product decision, not an implemented marketplace payout system.

Sources: [Checkout fulfillment](https://docs.stripe.com/checkout/fulfillment.md?ui=full-page),
[webhook signature verification](https://docs.stripe.com/events/manage-webhook-endpoints#signature-errors),
[API keys](https://docs.stripe.com/keys).
