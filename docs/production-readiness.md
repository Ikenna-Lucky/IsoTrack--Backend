# Backend readiness register

## Scope and decisions

This is a portfolio project with a zero-spend infrastructure budget. Use GitHub
Actions for CI. Drivers join by business invitation and belong to one business at
a time. Production readiness is an engineering objective, not a current claim.
Millions of registered users is a growth scenario; supported concurrent traffic
must be established by measurement. Do not use paid services without approval.

## Release blockers and work order

| Workstream | Acceptance criteria | Current status |
| --- | --- | --- |
| Test and CI foundation | Reproducible build, lint, type checks, unit tests, real database/Redis integration and retained CI reports | Lint/types/build, report validation and PostgreSQL suites pass locally and clean Windows install; GitHub/Linux verification, Redis integration and repository merge rules outstanding |
| Response privacy | Shipment and analytics relations select approved contact fields; real API regression tests cover all roles | Query projection implemented; integration unverified |
| Private fleets | Invitation-only onboarding, single business membership, database constraints, cross-business denial tests | New/existing driver enrollment and fleet constraints implemented; existing-driver handler and database tests pass; abuse controls, full JWT/HTTP and legacy reconciliation evidence outstanding |
| Shipment authorization | Every read/write verifies ownership or assignment; denied writes leave data unchanged | Detail lookup now requires actor scope; PostgreSQL predicate tests passed; HTTP, write-race and fleet isolation verification outstanding |
| Sessions | Revocation, refresh reuse detection, concurrent refresh policy, password recovery and verification | Server sessions, strict single-use rotation, replay/logout revocation, password/deactivation invalidation and PostgreSQL races verified locally; full login/password HTTP journeys, recovery, verification, browser coordination and deployed evidence outstanding |
| Shipment correctness | Atomic events, conditional transitions, retry safety, assignment races, delivery proof and returns | Creation/transitions and history are atomic; status-conflict, rollback and assignment-race tests pass; durable idempotency, versioning, proof and returns outstanding |
| Payments | Public signed callbacks, amount/currency checks, idempotency, reconciliation, refunds and sandbox evidence | Public signed webhook and atomic repeat-safe confirmation tested; initialization idempotency, reconciliation, refunds and provider sandbox evidence outstanding |
| Tracking | Authenticated assigned-driver writes, scoped subscriptions, revocation, reconnect and stale-location policy | Socket authentication, per-event/per-delivery authorization, atomic GPS writes, bounded traffic and real client/PostgreSQL tests verified locally; frontend adoption, distributed adapter/budgets, deployed networking, public-link privacy and capacity evidence outstanding |
| Notifications | Durable dispatch, preferences enforced, bounded retries and replay, valid links | Incomplete |
| Migrations | Fresh install and supported upgrade tested; business preference columns included; chronological journal repaired safely | Failed inspection |
| Performance | Agreed peak workload, latency/error targets, representative data, sustained and overload tests | Unverified |
| Delivery | Versioned artifact promoted through staging, deployment checks and tested rollback | Planned |
| Operations | Redacted telemetry, alert exercise, graceful shutdown, backup restore drill and incident runbooks | Planned |
| Data lifecycle | Tenant offboarding, account deletion, financial/location retention and public tracking visibility rules | Planned |

## Evidence policy

Each substantive change needs acceptance criteria and relevant tests before merge.
Use actual PostgreSQL for SQL, constraints, transactions and migration tests; use
actual Redis for queue behavior. Local stubs cover deterministic provider faults;
provider sandboxes establish external compatibility. Never claim mocks prove
integration or report unexecuted tests as passing.

Record commands, timestamp, tested commit/artifact, environment, pass/fail/skip
counts and limitations. Preserve CI reports. Review negative authorization cases,
duplicate requests, concurrent writes, dependency failures and recovery as well
as successful journeys. No universal coverage percentage substitutes for this.

## Next design decisions

Confirm business staff roles, driver workload rules, delivery proof, payment
recipient/settlement model, retention periods and recovery objectives before
implementing those domains. Choose free deployment tools after measuring their
constraints; free hosting does not establish production availability or capacity.

## Initial local evidence — 2026-11-01

Node 24.12.0, existing installed dependencies, local Windows workspace:

- `npm.cmd run type-check`: passed after correcting three missing response data fields.
- `npm.cmd run test:unit`: 1 passed, 0 failed, 0 skipped. This verifies the contact
  column allowlist only, not SQL execution or endpoint serialization.
- GitHub workflow added for frozen Bun install, type checking, unit report and
  build. It has not been pushed or executed. Bun is unavailable locally, so the
  build and clean dependency installation remain unverified.
- Lint remains failing from the baseline; no passing lint gate is claimed.
- Private fleet enforcement, ownership checks, PostgreSQL/Redis integration,
  security scans and CD are outstanding. This is not a release-ready baseline.

## Shipment ownership batch — 2026-11-01

Acceptance: business owners can fetch only shipments belonging to their business;
drivers only their assigned shipments; customers only linked shipments. Foreign
IDs return the same not-found response as absent IDs. Require actor scope in the
query signature so a new caller cannot silently omit authorization.

Applied the scoped lookup to detail, status, assignment, cancellation and payment
initialization. Assignment must use the assignment endpoint; driver status updates
cannot retry or cancel shipments. Driver-to-business membership is not implemented
yet, so this does not establish complete private fleet isolation. Update/event
atomicity and concurrent assignment changes remain separate release blockers.

Executed `node --test tests/shipment-access.integration.mjs` with Node 24.12.0 and
Docker 29.2.0 using disposable PostgreSQL 17: **7 passed, 0 failed, 0 skipped**.
Tests execute the production authorization predicate and verify foreign writes
affect zero rows and leave status unchanged. The database uses a minimal fixture
schema; actual migrations, HTTP authorization, provider calls and relation
serialization are not covered. Added this suite and its JUnit report to GitHub
Actions; remote execution remains unverified.

## Private fleet foundation — 2026-11-01

Added business membership, unique driver account constraint, fleet discovery
predicate, assignment membership checks and a composite assignment foreign key.
Driver shipment access now requires matching fleet membership as well as assignment.
Existing unlinked drivers are quarantined rather than arbitrarily assigned; public
driver registration is blocked pending invitation acceptance implementation.

Executed PostgreSQL suite: **10 passed, 0 failed, 0 skipped**. Added checks for
fleet discovery, excluded legacy memberships, actual initial-plus-forward migration
SQL with skipped settings migration, repaired columns, unique driver accounts,
cross-business assignment rejection and final FK validation on reconciled fixtures.
Migration execution uses psql, not the application migration runner. No live
database changes were made. See `docs/private-fleets.md` for migration prerequisites,
legacy reconciliation, and outstanding release gates. Schema generation metadata
is updated in `0002_snapshot.json`.

## Driver invitation batch — 2026-11-01

Added owner-scoped issue/list/revoke endpoints and new-account acceptance. Tokens
contain 256 random bits, are returned only at creation, stored as SHA-256 hashes,
and expire after 48 hours using the database clock. Acceptance binds the invited
email and creates the user/profile/membership and consumes the invitation in one
locked SQL statement. Passwords are never changed on existing accounts. Account
email verification is not implied by an owner-issued invitation.

Local evidence: Node 24.12.0, disposable PostgreSQL 17 via Docker:

- `npm.cmd run type-check`: passed.
- `npm.cmd run test:unit`: 2 passed, 0 failed, 0 skipped.
- `node --test tests/shipment-access.integration.mjs`: 18 passed, 0 failed,
  0 skipped. Includes actual invitation migration, acceptance/replay, expiry,
  revocation, recipient mismatch, rollback, existing-account protection,
  concurrent acceptance, competing invitations and revoke/accept races.

The production SQL statement is exercised directly through psql; the HTTP driver,
Hono routing, provider wiring and deployed environment remain unverified. Existing
CI discovers the expanded suite; no remote execution is claimed. No live database
migration or invitation email was performed. Tokens are manually shared for now.
See `docs/driver-invitations.md` for contracts and remaining release blockers.

## Existing-driver enrollment — 2026-11-02

Added authenticated `/driver-invitations/accept-existing`, accepting only a token.
The signed-in identity supplies the user ID; the database enforces active driver
role, matching invitation email, unlinked profile and reconciled shipment history.
Membership update and invitation consumption are atomic. Credentials remain
unchanged, fleet transfer is rejected, and new membership starts offline.

Evidence on Node 24.12.0 / disposable PostgreSQL 17:

- Type checking passed.
- 7 fast tests passed, 0 failed/skipped, including HTTP authorization boundaries,
  validation, identity spoofing rejection, success and conflict serialization.
- 23 PostgreSQL integration tests passed, 0 failed/skipped, including existing
  identity mismatch, inactive/wrong-role/linked accounts, unavailable invitations,
  unchanged credentials, competing fleet invitations, legacy history denial, and
  HTTP handler enrollment with persistence and replay checks.

HTTP tests inject controlled identities. Production JWT verification, the parent
router wiring, deployed Neon transport and remote CI are not established by these
results. No migration is needed for this batch and no live data was changed.

## Authentication validation — 2026-11-02

Production authentication now uses shared access-token verification and a tested
middleware factory. Access and refresh tokens must use HS256 and contain subject,
issued-at and expiry claims with the correct token type. Access roles must be
known strings. Current identity, active state and role are loaded from the user
store rather than granting permissions from stale token roles. User-store and
handler failures remain server failures; only verification failures become 401.

Evidence: type checking passed; 15 fast tests and 23 PostgreSQL integration tests
passed, with 0 failures/skips. Fast tests use real jose signatures for expiry,
claim omissions, invalid roles/types, wrong algorithms/signatures, inactive or
deleted accounts, current roles, and error classification. The enrollment HTTP
integration uses the production middleware factory and token verifier with a real
PostgreSQL user lookup, then verifies durable enrollment and replay rejection.

The test adapter uses psql, not the deployed Neon transport. Full parent router,
environment/secret configuration and deployed behavior remain unverified. Session
revocation, refresh rotation/reuse detection, issuer/audience policy, browser
session defenses and distributed abuse controls remain release work. No migration
or live data change was required.

## Atomic shipment writes — 2026-11-02

Creation, progress changes, assignment and cancellation now write shipment state
and history in one PostgreSQL statement. Transition SQL rechecks authorization,
expected status, action roles and active same-fleet driver assignment. A stale
status yields no write/event and the route returns 409. Failed shipment retry
clears prior driver/pickup/delivery state. Removed unused standalone update/event
query helpers. Notification dispatch remains separate from the commit.

Evidence: type checking and 15 fast tests passed. Final PostgreSQL run: 32 passed,
0 failed/skipped, including a Drizzle-generated creation fragment, history-failure
rollback, competing assignment/cancellation, denied writes without events, active
fleet checks and retry cleanup. An earlier run exposed invalid parentheses around
the Drizzle insert; corrected composition and reran successfully. The creation
rollback assertion now checks the intended unique-constraint error specifically.

Tests execute the production SQL statement builders through psql. Shipment HTTP
routes, raw-response conversion and deployed Neon transport need further contract
verification. Expected-status checks do not replace version-aware updates or
idempotency; status cycles and post-commit notification failures remain documented
risks in `docs/shipment-transitions.md`. No migration or live database change was
required.

## Payment confirmation — 2026-11-03

Moved the signed webhook ahead of user authentication while protecting other
payment routes with business/customer authentication. Added raw-byte HMAC-SHA512
verification, bounded bodies, schema validation, fail-closed missing configuration
and non-success acknowledgment for unrecorded successes. Initialization now stores
a pending reference before contacting the provider and validates its response.
Manual verification checks local ownership before contacting previous provider. Provider
requests have a bounded deadline.

Webhook and verification share a locked, atomic PostgreSQL confirmation statement
checking reference, amount, shipment price, NGN currency and permitted local state.
Duplicates preserve the original receipt. Refunded payments cannot be resurrected.

Evidence: type checking and 24 fast tests passed, 0 failed/skipped. PostgreSQL suite:
38 passed, 0 failed/skipped. Payment cases include signed HTTP persistence/replay,
amount/currency/reference mismatch, refunded state, forced shipment-write rollback
and competing webhook/verification confirmation. A fast-test harness initially
mapped Hono's body-limit HTTPException to 500; aligned its exception handling with
the application and verified the intended 413 response.

Official previous provider webhook/verification docs were consulted. Test signatures and
provider response fixtures are local; no sandbox or live transaction was made.
The SQL adapter uses psql, not deployed Neon HTTP. Initialization and verification
full HTTP/provider journeys, reconciliation, refunds, duplicate-charge handling,
initialization idempotency, operational alerts and remote CI remain unverified or
outstanding. No migration or live application database change was required.

## Stripe Checkout replacement — 2026-11-03

Replaced the active provider integration with official Stripe SDK 23.1.0 and
Stripe-hosted Checkout, pinned API version 2026-10-28.endive. Backend configuration
now uses STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET. Removed the former popup and
public key from the frontend; it redirects to hosted Checkout and verifies the
returned local reference through the backend. Redirect destinations are restricted
to the HTTPS Stripe checkout origin. Active source, tests and docs use Stripe.

Migration 0004 renames the reference column/index/constraint, preserves old values
as provider=legacy, defaults new rows to Stripe and adds a unique session ID.
Historical migrations/snapshots retain their old names deliberately. Confirmation
binds session ID/reference/amount/currency/provider and refuses legacy records.
Official SDK signature verification checks raw bytes, timestamp tolerance and
sandbox/live mode. Both paid completion events are handled; unpaid completion
cannot mark a shipment paid. Frontend redirects alone are not trusted.

Evidence: backend/frontend type checks passed; 23 backend fast tests and 2 frontend
checkout-URL tests passed. PostgreSQL integration: 40 passed, 0 failed/skipped,
including actual migration preservation, session binding, signed Stripe HTTP event
replay, rollback and concurrency. Backend production bundle passed with Bun 1.3.12;
CI runtime now matches that version. Frontend production build passed again after the final redirect-validation change.

No Stripe network payment or live database migration was performed. API keys are
blank in local/example configuration pending user setup; no credentials were copied
from the prior provider. Stripe Dashboard/CLI sandbox delivery, actual Checkout UI,
full browser return journeys and deployed Neon transport remain unverified. See
docs/payments.md for exact Dashboard settings, env values and migration requirements.
Initialization still needs application-level retry idempotency, reconciliation,
refund/dispute handling, operational alerting and fleet settlement decisions.

## Backend CI and report integrity — 2026-11-03

Added a working ESLint flat configuration with declared/locked TypeScript tooling,
recommended rules and type-aware promise/assertion checks. Fixed nine reported
issues: an unhandled migration-runner rejection, redundant assertions and unused
worker imports. No lint rules were disabled to suppress those findings.

CI now requires lint, types and build and uses the same report-generating test
commands as local development. Runners reject zero discovery, nonzero child exit,
missing/truncated reports, failures, cancellations, skips and todos. JUnit and JSON
metadata are retained as Actions artifacts; report validation has regression tests.
Local JSON records commit=null explicitly; CI supplies GITHUB_SHA. Branch protection
and deployment configuration were not changed.

Evidence: lint/types passed, 27 fast tests and 40 real PostgreSQL integration tests
passed with no failures/skips/todos. Main reports were generated and validated.
A separate Windows copy with no .env/Git/existing node_modules installed all 263
packages from the frozen lockfile and passed lint/types/build plus 27 fast tests.
Its reports and lockfile hash are saved under reports/clean-install*. The temporary
source/dependency copy was removed after verification.

A clean Linux Docker attempt failed before installation because the registry host
could not resolve. Linux behavior and actual GitHub Actions execution remain
unverified; no clean Linux pass is claimed. Full release work still includes
repository required-check rules, security scans, Redis tests, deployed verification
and CD/recovery gates. Only backend files changed in this batch.

## Revocable sessions — 2026-11-03

Added indexed PostgreSQL sessions, signed session identifiers and refresh
generations. Every protected HTTP request checks the session against the current
user credential version and expiry. Rotation is a conditional single-statement
update; reusing a generation revokes that device's session, including its access
tokens. Clients must serialize refreshes; concurrent reuse and lost responses can
force reauthentication. Session expiry remains absolute across rotation.

The new migration installs a credential-version trigger for password and active
status changes. This invalidates every device and prevents reactivation from
resurrecting old sessions. Password writes use the previously verified hash as a
compare-and-set condition. Logout persists revocation before clearing its cookie;
storage failures remain server errors. Cookie session endpoints enforce the
configured frontend Origin and no-store responses. A bounded cleanup command
removes records expired more than seven days ago; deployment scheduling is still
required. See docs/sessions.md for rollout and client contracts.

Local Windows evidence: lint, type checking and Bun build passed. 35 fast tests and
52 real PostgreSQL 17 integration tests passed, with zero failures, skips, todos
or cancellations. Reports are retained in reports/unit.* and reports/integration.*.
The database suite executes the actual migration and production statements,
including duplicate/concurrent refresh, ownership, logout, password/deactivation
invalidation, reactivation, expiry, deletion, cleanup and password/logout races.
An HTTP test combines the production session router and authentication middleware
with real jose signatures and PostgreSQL through a psql adapter. Fast tests also
verify that the origin guard does not affect unrelated routes.

No production migration, deployment, remote Actions run or capacity test was
performed. Full login/password HTTP flows, actual Neon transport, browser refresh
coordination, credential recovery, email verification and socket revocation remain
unverified or missing. Existing tokens will be rejected after rollout; users must
log in again. Backend-only change; no new environment secrets required.

## Real-time tracking security — 2026-11-03

Replaced anonymous room joins and unauthenticated GPS broadcasting with signed
access-token/session authentication. Shipment ownership, current database role,
private fleet and driver assignment are verified server-side. Joins require
participant access; location updates require the assigned driver and active
delivery status. Session, assignment, sample order, freshness and one-write-per-
second limits are enforced in the same PostgreSQL update. Accepted locations are
persisted to the shipment before best-effort delivery.

Every event checks its session and every broadcast checks intended recipients'
current session and shipment access. Queries batch at most 100 identities; room
lookup visits only local shipment subscribers. Idle sessions are rechecked on a
non-overlapping 15-second interval plus database/processing time. Five-second Neon
fetch timeouts bound individual tracking requests. Failures deny access/disconnect.
In-flight already-authorized work can finish after a permission change.

Added 8 KiB transport bounds, five connections/user/process, twenty subscriptions/
socket, ten handled events/second/socket and one in-flight event/socket. Volatile
delivery avoids GPS backlogs. Recovery is disabled: reconnects authenticate again
and rejoin. Public HTTP projections now return null for live shipment/driver GPS;
broader public tracking privacy remains open. No frontend files were changed.

Evidence: local Windows lint, types and Bun build passed; 38 fast tests and 66
integration tests passed with zero failures/skips/todos/cancellations. JUnit and
JSON results were retained in reports/unit.* and reports/integration.*. The new
tracking suite applies actual migrations in a separate PostgreSQL 17 container and
uses real Socket.IO clients over WebSocket and polling, real jose signatures,
production handlers/options and production SQL via a psql adapter. Tests cover
anonymous/expired/revoked/legacy credentials, cross-business/role access, assigned
driver persistence, spoofed identity fields, malformed/stale GPS, reassignment,
logout, idle expiry, reconnect, outages, concurrent writes, burst/frame/origin
limits, live password/deactivation invalidation and stale JWT role claims. Fast
tests cover location bounds and public GPS projection. CI discovers these suites
through the existing report runner; remote execution has not been performed.

Remaining gates: frontend token/refresh/rejoin implementation; actual Neon HTTP
and deployed Bun networking; shared socket adapter and distributed budgets before
horizontal deployment; edge handshake/connection protection; public-link privacy
and retention; representative load and revocation-latency measurements. No new
migration or environment secrets are required beyond existing session migration
0005. No production database, deployment or external account was modified. See
docs/tracking.md for the full contract and evidence boundaries.
