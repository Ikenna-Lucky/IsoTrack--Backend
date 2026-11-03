# Password recovery and email verification

These are transactional emails, delivered through the existing Gmail SMTP
configuration. Resend is installed but unused; marketing campaigns, subscriptions
and unsubscribe workflows are outside this feature.

## Setup and rollout

Apply migration 0008 with the migration command before deploying the updated API
and worker. It adds account action/outbox rows and distributed request budgets.
It also extends the credential trigger: changing an email clears verification and
invalidates existing sessions and links. Existing account verification flags are
preserved; no account is marked verified by this migration.

Set `ACCOUNT_ACTION_SECRET` to an independent random 32-byte hex key, identical on
every API/worker instance. Generate it locally:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Keep the generated value in your environment/secret store; do not commit it.
There is no dashboard key to obtain for this setting. Without it, these endpoints
return 503 and the account email dispatcher stays disabled. Other authentication
routes continue operating. Existing Gmail settings are still needed. No secrets
were generated into the repository or sent to an external provider in development.

`FRONTEND_URL` supplies the trusted link origin, never Host or forwarding headers.
When this feature is configured, production requires HTTPS without URL credentials;
development permits HTTP localhost/127.0.0.1. Frontend subpaths are discarded.

## HTTP contract

All endpoints are under `/api/v1/auth`, accept only bounded JSON bodies (4 KiB),
and respond with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
They use no existing session or cookies for authorization.

| POST endpoint           | Body                                       | Successful response                          |
| ----------------------- | ------------------------------------------ | -------------------------------------------- |
| `/forgot-password`      | `{ "email": "person@example.com" }`        | 202 with a generic eligibility message       |
| `/reset-password`       | `{ "token": "...", "newPassword": "..." }` | 200, refresh cookie cleared; log in normally |
| `/verification/request` | `{ "email": "person@example.com" }`        | 202 with the same generic message            |
| `/verification/confirm` | `{ "token": "..." }`                       | 200, current account email marked verified   |

Unknown, inactive, already-verified and resend-suppressed accounts do not reveal
their status through the request response. Both eligible and ineligible requests
execute the same statement and share a minimum 300–350 ms response window.
Network/database latency can exceed it; constant-time HTTP and resistance to
statistical timing analysis are not claimed. SMTP delivery is always asynchronous.
Storage errors are 503, not false success. Malformed inputs return 400, oversized
bodies 413, and exhausted peer budgets 429 with Retry-After: 600.

Reset links expire after 30 minutes; verification links after 24 hours, using the
database clock. Invalid, expired, consumed, wrong-purpose and superseded links
return the same 400 error. A successful reset changes the bcrypt hash, increments
the credential version, invalidates all sessions and outstanding action links,
consumes its token and queues a password-change notice in one SQL transaction.
It does not automatically log in or mark an email verified. Notice insertion
failure rolls the whole reset back. A lost successful reset response may cause a
retry to return invalid-token; try normal login with the new password before
requesting another reset. A reset is not a general compromised-account recovery
process for changed/lost mailboxes or future MFA.

Passwords keep the existing minimum/uppercase/number rules, with a shared maximum
of 72 UTF-8 bytes for registration, authenticated changes and resets to avoid
bcrypt truncation. Driver invitation acceptance already enforces that boundary.
Login still accepts existing passwords for compatibility.

## Frontend integration

No frontend files changed. After registration, explicitly call verification/request;
it is also the resend endpoint for existing customers, owners and invited drivers.
Verification is not automatically queued by registration in this batch. The
isEmailVerified flag can be read through existing account responses. Login and
business operations do not yet require the flag; product-specific verification
gates and rollout for existing accounts remain release work.

Links point to `/reset-password#token=...` or `/verify-email#token=...`. Build those
frontend pages before exposing these emails to users. Read the fragment into
memory and remove it with history.replaceState; keep it out of storage, analytics,
logs, URLs sent to APIs and third-party scripts. Require explicit user confirmation
before POSTing; GET never consumes a link, including mail-scanner visits. The
reset form should ask the user to confirm the new password locally. The token is
a bearer secret and proves control of its bound email; no user ID is accepted.

## Tokens, budgets and delivery

Each action has a 256-bit random identifier plus a domain-separated HMAC-SHA256
proof made with ACCOUNT_ACTION_SECRET. Only the full token's SHA-256 hash is
stored. The worker can reconstruct the proof from the identifier and secret;
there is no plaintext token in the database, notification payload or Redis.
Keep database access separate from access to this secret. Changing the secret
makes pending old-key email proofs fail their stored hash check and get skipped.
Already-delivered old links remain usable until consumption, credential change
or expiry; rotation alone does not revoke them. For suspected compromise, revoke
outstanding actions in a reviewed operational procedure as well as rotating keys.

PostgreSQL UPSERT counters enforce limits across instances: 30 submissions per
10-minute fixed window per socket peer, shared across all four endpoints; at most
one issuance per minute and five per clock hour per account/purpose. Requests do
not invalidate prior unexpired links, so an attacker cannot cancel a legitimate
link merely by repeatedly requesting another. Only eligible accounts get account
budget records. Peer identifiers are HMAC hashes, not raw IPs. Fixed-window bursts
across a boundary are possible; these are not complete edge abuse controls.

The adapter deliberately uses the direct socket address and ignores X-Forwarded-For.
Behind a proxy, users may share its limit. Before deployment, define the trusted
proxy/edge topology and enforce appropriate limits there; do not blindly trust
forwarded headers. Login/register abuse protection, IPv6 subnet policies, global
mail-provider budgets and distributed bot attacks still need release work.

Older delayed statements cannot move either budget back to an earlier window;
regression tests simulate an already-advanced counter and verify denial.

Account rows double as a separate durable outbox, independent of Redis. A
non-overlapping five-second poll claims at most five emails with SKIP LOCKED,
two-minute leases and fenced completion. Five concurrent sends use the existing
Gmail SMTP TLS/connection/socket timeout configuration. SMTP timeouts are not an
absolute end-to-end deadline. Expired leases recover after process loss; up to
five attempts use bounded backoff, then dead-letter. Current activity, email,
expiry, credential version and verification state are checked before link sends.
An already-authorized send can complete after an account change. Password-change
notices still require the same active account/current email, but survive later
credential-version changes.

SMTP is at least once: acceptance followed by loss of the completion write can
cause duplicates. Stable Message-IDs help correlate them but do not guarantee
mailbox deduplication. No expired-link replay command is provided; request a fresh
link. Gmail quotas and deliverability are unverified and must be measured; the
project does not yet support large-scale mail traffic.

Inspect aggregate state with `bun run account-actions:status`. Schedule
`bun run account-actions:purge`: it removes at most 5,000 non-processing rows
expired more than seven days ago and 5,000 budget rows older than two days per
invocation. It emits counts only. Scheduling, dead-letter/lag alerting, provider
verification and deployed shutdown/recovery rehearsal remain operational gates.

## Verification boundaries

Real local tests use PostgreSQL 17 with the production migration runner, a Hono
HTTP server and socket peer adapter, jose-signed JWT/session checks, bcrypt and a
local SMTP protocol sink. They cover generic responses, stored hashes/fragment
links, durable notices and rollback, expired/replayed/tampered/wrong-purpose
links, same/different-token concurrency, repeated verification, old sessions,
email changes, disable/reactivate cycles, resend/peer budgets, SMTP exhaustion,
lease fencing, injected lost completion and retention. Fast tests cover strict
inputs, Unicode password bytes, missing configuration, redacted failures,
origin/link construction and dispatcher drain.

The SMTP ambiguity is an injected failure at the completion boundary, not a
new killed-process test. Gmail TLS/account delivery, hosted Neon HTTP, deployed
Bun behavior, remote Actions, browser pages and end-to-end user journeys remain
unverified. The wider suite retains its existing real PostgreSQL/Redis/BullMQ/
Socket.IO/SMTP coverage. Design reference: [OWASP password recovery guidance](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html).
