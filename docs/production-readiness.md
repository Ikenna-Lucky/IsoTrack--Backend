# Backend readiness register

## Scope and decisions

This is a portfolio project with a zero-spend infrastructure budget. Use GitHub
Actions for CI. Drivers join by business invitation and belong to one business at
a time. Production readiness is an engineering objective, not a current claim.
Millions of registered users is a growth scenario; supported concurrent traffic
must be established by measurement. Do not use paid services without approval.

Current completion estimate: **7.5/10** after identity recovery and login/signup abuse protection
(2026-11-03), unchanged by the latest control-focused build. Update this estimate after each
build as requested. It is a rough planning assessment of the agreed backend scope,
not a measured percentage, capacity claim or release approval. Deployment, full
critical journeys, identity/browser adoption, remaining write idempotency/versioning, payment lifecycle,
observability, load testing and recovery evidence remain substantial work.

## Release blockers and work order

| Workstream             | Acceptance criteria                                                                                                 | Current status                                                                                                                                                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test and CI foundation | Reproducible build, lint, type checks, unit tests, real database/Redis integration and retained CI reports          | Lint/types/build, report validation, PostgreSQL/Redis/BullMQ/Socket.IO/local SMTP suites pass locally; earlier clean Windows install recorded; GitHub/Linux verification and repository merge rules outstanding                                                                          |
| Response privacy       | Shipment and analytics relations select approved contact fields; real API regression tests cover all roles          | Query projection implemented; integration unverified                                                                                                                                                                                                                                     |
| Private fleets         | Invitation-only onboarding, single business membership, database constraints, cross-business denial tests           | New/existing driver enrollment and fleet constraints implemented; existing-driver handler and database tests pass; abuse controls, full JWT/HTTP and legacy reconciliation evidence outstanding                                                                                          |
| Shipment authorization | Every read/write verifies ownership or assignment; denied writes leave data unchanged                               | Detail lookup now requires actor scope; PostgreSQL predicate tests passed; HTTP, write-race and fleet isolation verification outstanding                                                                                                                                                 |
| Sessions               | Revocation, refresh reuse detection, concurrent refresh policy, password recovery and verification                  | Server sessions, guarded login/signup/recovery HTTP, atomic signup and credential races verified locally; full app/browser journeys, verified-email policy, hosting ingress, provider and deployed evidence outstanding                       |
| Shipment correctness   | Atomic events, conditional transitions, retry safety, assignment races, delivery proof and returns                  | Creation/transitions/history are atomic; creation idempotency, rollback/replay and assignment races verified locally; remaining command idempotency/versioning, proof and returns outstanding                                                                                            |
| Payments               | Public signed callbacks, amount/currency checks, idempotency, reconciliation, refunds and sandbox evidence          | Signed webhook/atomic confirmation and same-key initialization retries verified locally; reconciliation, distinct-attempt lifecycle, refunds and actual provider sandbox evidence outstanding                                                                                            |
| Tracking               | Authenticated assigned-driver writes, scoped subscriptions, revocation, reconnect and stale-location policy         | Socket authentication, per-event/per-delivery authorization, atomic GPS writes, bounded traffic and real client/PostgreSQL tests verified locally; frontend adoption, distributed adapter/budgets, deployed networking, public-link privacy and capacity evidence outstanding            |
| Notifications          | Durable dispatch, preferences enforced, bounded retries and replay, valid links                                     | Atomic outbox capture, deduplicated in-app delivery, email retries/dead letters/replay, configured escaped links, Redis loss and killed-worker recovery verified locally; SMTP ambiguity documented; additional channel/preferences, provider/deployed evidence and alerting outstanding |
| Migrations             | Fresh install and supported upgrade tested; business preference columns included; historical journal handled safely | Production runner core verified with actual 0000–0008 SQL, fresh install, existing-account upgrade, rollback, concurrency and history validation in PostgreSQL; hosted Neon transport, legacy fleet FK reconciliation/validation and deployed upgrade evidence outstanding               |
| Performance            | Agreed peak workload, latency/error targets, representative data, sustained and overload tests                      | Unverified                                                                                                                                                                                                                                                                               |
| Delivery               | Versioned artifact promoted through staging, deployment checks and tested rollback                                  | Planned                                                                                                                                                                                                                                                                                  |
| Operations             | Redacted telemetry, alert exercise, graceful shutdown, backup restore drill and incident runbooks                   | Planned                                                                                                                                                                                                                                                                                  |
| Data lifecycle         | Tenant offboarding, account deletion, financial/location retention and public tracking visibility rules             | Planned                                                                                                                                                                                                                                                                                  |

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
Its reports and lockfile hash are saved under reports/clean-install\*. The temporary
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
or cancellations. Reports are retained in reports/unit._ and reports/integration._.
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
JSON results were retained in reports/unit._ and reports/integration._. The new
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
migration or environment secrets are required beyond existing session migration 0005. No production database, deployment or external account was modified. See
docs/tracking.md for the full contract and evidence boundaries.

## Notification outbox — 2026-11-03

Added migration 0006 with channel-specific durable notification records and capture
triggers on shipment history and payment success. Capture failure rolls back the
business change. Removed route fire-and-forget delivery and the old worker/queue
helpers. Business and registered customer in-app notifications now complete
atomically with their outbox record; customer milestone/payment emails have
independent durable delivery state. Current recipient account, role and shipment
relationship are checked before delivery.

PostgreSQL owns a five-attempt retry budget, timed backoff, two-minute ownership
leases and dead letters. Redis carries IDs only; a bounded non-overlapping
dispatcher republishes pending/expired work after queue loss. Deterministic
BullMQ IDs and database completion prevent duplicate in-app delivery. Email uses
stable Message-IDs and bounded SMTP timeouts but remains at least once: a crash
after acceptance can cause another send. The actual crash test observes that
window; no exactly-once SMTP claim is made. Added operator status/replay/purge
commands, indexed retention/foreign-key paths and a bounded API shutdown drain.

Evidence: lint, types, Bun build and 39 fast tests passed locally. All 77 integration
tests passed (including 11 new outbox cases) with zero failures/skips/todos/
cancellations. Reports are retained under reports/unit._ and reports/integration._.
The new suite runs actual PostgreSQL migrations, Redis 7.4, BullMQ workers and a
local SMTP protocol sink. It verifies atomic shipment/payment capture and rollback,
duplicate confirmations/publication, Redis timeout/data loss, lease fencing,
bounded retries/dead-letter replay, stale/disabled recipients, retention and a real
child process killed after SMTP acceptance, followed by replacement-worker recovery.
Fixture timestamps accelerate lease/backoff waits; real stalled-job recovery runs.

Remaining gates: controlled legacy-queue cutover and production migration; deployed
Neon/Bun and Gmail TLS/provider verification; channel/preferences and guest delivery
decisions; lag/dead-letter alerts and durable operator audit; cleanup scheduling;
provider quotas, distributed budgets and measured capacity. SIGTERM runtime closure
and the killed worker are covered at component boundaries; full deployed entrypoint
shutdown is not rehearsed. No live credentials, external email, production database
or deployment were used. CI discovers the suites and retains reports, but remote
Actions has not run. Integration timeout is seven minutes and CI job budget fifteen
minutes to accommodate the added real services. See docs/notifications.md.

Completion estimate after this build: **6.5/10** toward the agreed production-ready
backend, subject to the outstanding gates above and the release register.

## Request idempotency — 2026-11-03

Shipment creation and checkout initialization now require a client Idempotency-Key.
Durable reservations bind the authenticated user/operation/key to normalized input,
original resource IDs and response snapshots. Unique scope and fenced 60-second
leases handle concurrent attempts and interrupted claims. Shipment/history/outbox
and the saved creation result commit atomically. Replays return the original status
and body after current ownership checks, without repeating those effects.

Checkout initialization retains one payment reference and immutable Stripe request
parameters/key across service instances. Session attachment and response storage
commit together. Amount/currency/mode/reference/shipment/redirect validation precedes
completion. Unknown provider outcomes can retry within a conservative 23-hour
window; pending attempts beyond that window or with a changed credential binding
require reconciliation. Application keys expire after 24 hours and cannot be reused.
Sensitive payloads can be scrubbed after 30 days while compact tombstones remain.
Distinct keys/users can still create distinct attempts; global payment lifecycle
and duplicate-charge protection are not claimed by this mechanism.

Local Windows evidence: lint, types, Bun build and 43 fast tests passed; all 92
integration tests passed with zero failures/skips/todos/cancellations. Validated
JUnit/JSON reports remain in reports/unit._ and reports/integration._. Fifteen new
cases apply migration 0007 in disposable PostgreSQL and use real Hono handlers,
signed JWT/session authentication, production service/SQL and the official Stripe
SDK against a loopback HTTP fixture. They verify replay, key scope/conflicts,
concurrency, outbox rollback, lost claim/commit acknowledgements, lease fencing,
expiry/scrubbing, checkout replay/contention, accepted-but-lost provider responses,
immutable parameters across service instances, attachment failure/lost response,
safe retry/configuration cutoffs, current ownership/price and invalid provider data.

The provider fixture drops both the original and SDK connection-reset retry
responses, then verifies recovery with one provider session and unchanged key/body.
Database transport faults and accelerated lease timestamps are explicit injections,
not a claim of killed-process or actual Stripe sandbox coverage. Fast tests cover
normalization/canonicalization, key validation, CORS and input/internal error
boundaries. The current complete local suite also includes PostgreSQL/Redis/BullMQ/
Socket.IO/SMTP tests from prior batches. Remote Actions has not run.

Rollout requires migration 0007, coordinated client header adoption and stopping
old write-serving instances. No frontend files, new secrets, production database or
external provider account were changed. Remaining work includes automatic payment
reconciliation, lifecycle control across distinct attempts, other command versioning,
idempotency-table growth/cardinality controls, scheduling of scrubbing, deployed
Neon/Bun/browser/provider verification and capacity/cost evidence. See
docs/idempotency.md for contracts, expiry, credential rotation and retention limits.

Completion estimate after this build: **7/10** toward the agreed production-ready
backend. This remains a planning estimate, not release approval.

## Atomic migration runner — 2026-11-03

PR-09/PR-17 acceptance: install all checked-in migrations on an empty database,
upgrade the initial schema while preserving existing accounts, rerun without
duplicate effects, roll back pending SQL and history together on failure, reject
changed/unknown/duplicate/gapped history, serialize concurrent plans and recover
after a lost commit acknowledgement. The production runner now uses an atomic
Neon batch transaction, advisory lock, locked history recheck and full hash-based
history validation. The historical settings omission is the sole allowed repair;
existing migration SQL/timestamps remain unchanged. Lock, statement and HTTP
deadlines are bounded. See docs/migrations.md for rollout and failure procedures.

Local Windows / Node 24.12.0 evidence: lint, type checking and Bun 1.3.12 build
passed; 43 fast tests and 99 integration tests passed, with no failures, skips,
todos or cancellations. The complete integration run took about 337 seconds.
Seven new cases execute the production runner core and all eight actual migration
files against disposable PostgreSQL 17 using a psql adapter. Reports are retained
in reports/unit.* and reports/integration.*; local artifact identity is commit=null.

The first complete run failed during PostgreSQL fixture startup: readiness could
observe the image's temporary Unix-socket initialization server before its restart.
The shared fixture and older shipment suite now probe the final TCP listener.
The original failure reports remain in reports/integration-before-startup-fix.*;
the full rerun passed after this correction. No failure was hidden by test retries.

Hosted Neon HTTP, the Bun migration CLI against a hosted database, remote Actions,
large-data lock timing, deployed upgrade/rollback and backup restoration remain
unverified. Legacy fleet reconciliation and FK validation remain outstanding.
No production database, credentials, frontend or deployment changed. No new schema
migration is introduced by this batch. Completion remains **7/10**: this closes a
specific migration safety gap, while the other release gates above still apply.

## Password recovery and email verification — 2026-11-03

PR-05/06/07/09/10 acceptance: generic request responses, hashed single-use expiring
links, strict bounded inputs, current-email/credential binding, distributed peer
and resend limits, atomic reset/token consumption/session invalidation/security
notice, durable email retries and real HTTP/database/SMTP tests. Migration 0008
adds the action outbox and budgets, and extends credential invalidation to email
changes. Reset links expire after 30 minutes and verification after 24 hours.
Tokens use random 256-bit identifiers and domain-separated HMAC proofs; the
database stores only the full token hash. Pending email proofs are reconstructed
with the independent ACCOUNT_ACTION_SECRET. No plaintext token is stored in SQL
or Redis. Gmail SMTP remains the transactional sender; Resend is unused.

Password reset and its security notice commit together. Current-session predicates
reject old credentials after reset; other reset/verification links become invalid.
Concurrency tests cover one token, different reset tokens and repeated verification.
Account/email state is rechecked at send time, ownership leases fence completion,
and SMTP retries stop at five attempts. Duplicate email after ambiguous acceptance
remains possible and is tested with injected completion loss. A separate bounded
PostgreSQL dispatcher lets identity emails operate without Redis. Status/purge
commands expose aggregate counts; scheduling and alerts remain deployment work.

Local Windows / Node 24.12.0: lint, types and Bun 1.3.12 build passed; 48 fast tests
passed. The full six-file integration run passed 114 cases with zero failures,
skips, todos or cancellations in about 425 seconds. Reports remain in
reports/unit.* and reports/integration.*. Fifteen new cases exercise the production
migration runner/SQL, actual PostgreSQL 17, a Hono HTTP server with the real socket
peer adapter, jose JWT/session checks, bcrypt and a local SMTP sink. Fixtures use
synthetic accounts; hosted Neon transport and Gmail are not contacted.

The initial focused reset test failed because the test supplied incorrect auth
dependency names; corrected the harness and verified signed-session denial. The
first full run subsequently passed 111/114, with three Docker command timeouts
during a long host delay in identity and unchanged outbox/payment tests. Its
reports are preserved in reports/integration-before-resource-limit.*. Integration
files now run at most two at a time, retaining in-suite concurrency tests and
per-command deadlines. The report runner's total integration budget is ten minutes
for the expanded suite; CI retains its fifteen-minute job budget. No assertion,
skip or automatic retry was used to hide these failures.

After the full pass, a final review tightened rate-window monotonicity so delayed
older statements cannot rewind an advanced peer/account counter. Reran all fifteen
identity integration cases, including new SQL/HTTP regressions for that boundary:
15 passed, zero failures/skips/todos/cancellations. Validated separate JUnit/JSON
evidence is in reports/account-actions-final.*. The final bundle also passed.
All local reports explicitly use commit=null; remote Actions remains unverified.

Rollout requires migration 0008, ACCOUNT_ACTION_SECRET and trusted frontend/proxy
configuration. Missing configuration disables only these new endpoints/dispatcher.
Registration does not automatically request verification yet: the frontend must
call the request endpoint and implement fragment-link confirmation pages. Verified-
email authorization rules, existing-account rollout, login/register abuse controls,
edge/provider-wide budgets, real Gmail delivery, browser journeys, deployed Bun/
Neon, telemetry and recovery/capacity evidence remain release gates. See
docs/account-recovery.md for exact contracts and limitations. No frontend, live
database, external email account or deployment was modified. Completion estimate:
**7.5/10**, a scoped planning estimate rather than release approval.

## Login and registration abuse protection — 2026-11-03

PR-04/05/07/09 acceptance: shared pre-bcrypt limits, bounded JSON input, consistent
login failures, temporary rather than account-wide permanent lockouts, explicit
proxy trust, redacted security events and real HTTP/SQL concurrency tests. Login
now admits 30 attempts per peer/ten-minute window and ten per peer/email pair;
registration admits five per peer/hour. PostgreSQL conditional UPSERT counters
in the existing migration 0008 table enforce budgets across instances. Denials
do not extend windows or deactivate accounts. Keys are purpose-separated HMAC
pseudonyms derived with JWT_SECRET; IPv6 authentication peers share a /64 budget.
No new migration, dependency, additional secret or Redis requirement was added.

The shared resolver defaults to socket peers. Only explicitly allowlisted exact
TRUSTED_PROXY_IPS may supply one valid X-Real-IP; missing/malformed values fail
closed, and other forwarding headers are ignored. Recovery routes use the same
resolver. Real ingress header rewriting and network restrictions remain unverified.
Unknown, wrong-password and inactive accounts share one 401 body, with a cost-12
dummy comparison and minimum response window for short paths. These controls do
not establish constant-time HTTP or distributed bot resistance. Structured events
contain only operation/outcome/requestId; the correlation header is exposed by CORS.

Signup now creates the user and business profile atomically in one SQL statement.
Concurrent duplicate emails create one account/profile, failed profile insertion
rolls back the user, and public driver creation remains blocked. Session issuance
is subsequent: a failure can leave a complete account that recovers through login.
Duplicate signup still returns 409; full registration enumeration resistance is
not claimed. Successful token/cookie shape and the public user projection remain
compatible. No frontend files were changed; existing request shapes were inspected.

Local Windows / Node 24.12.0 evidence: lint, type checks and Bun 1.3.12 build passed.
51 fast tests and all 127 integration tests passed with zero failures, skips,
todos or cancellations. The full seven-file integration run took about 446 seconds
with two files in parallel. Validated JUnit/JSON evidence remains in reports/unit.*
and reports/integration.*; commit=null locally. Thirteen new integration cases
run actual PostgreSQL 17 with the complete migration journal, independent Hono
HTTP servers, the real socket adapter, bcrypt, session statements and jose-signed
fixture credentials. They cover shared last-slot contention, peer and pair limits,
expiry/no extension, SQL races/stale windows, different trusted peers, generic
failures, signup races/rollback/session-failure recovery, credential invalidation,
proxy spoofing/outages and oversized bodies. Three new fast tests cover proxy/IP
normalization, IPv6 grouping, strict inputs and secret-free failure/event fields;
the CORS regression also checks X-Request-Id exposure. The initial lint run caught
an unused legacy cookie-helper import; removed it and passed the required checks.

Production env-bound signing, complete entrypoint and hosted Neon/Bun transport,
browser journeys, real ingress, remote GitHub Actions, edge/global budgets,
compromised-password screening, MFA and measured auth CPU/SQL capacity remain
release gates. Existing account-actions:purge also removes old authentication
counter windows; scheduling and security-event collection/alerts remain deployment
work. No live database, external account, frontend or deployment was modified.
See docs/auth-abuse-protection.md for policy, rollout and limitations. Completion
remains **7.5/10**: payment lifecycle, deployment, operational recovery and capacity
evidence are still substantial blockers to the production-readiness objective.
