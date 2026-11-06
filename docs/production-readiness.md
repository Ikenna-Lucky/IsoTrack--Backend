# Backend readiness register

## Scope and decisions

This is a portfolio project with a zero-spend infrastructure budget. Use GitHub
Actions for CI. Drivers join by business invitation and belong to one business at
a time. Production readiness is an engineering objective, not a current claim.
Millions of registered users is a growth scenario; supported concurrent traffic
must be established by measurement. Do not use paid services without approval.

Current completion estimate: **8.5/10** after local regression, performance baselines, retention, shipment read privacy, public tracking/history, shared request-protection checks and preview release tooling
(2026-11-06). Update this estimate after each
build as requested. It is a rough planning assessment of the agreed backend scope,
not a measured percentage, capacity claim or release approval. Deployment, full
critical journeys, identity/browser adoption, remaining write controls, provider sandbox/payment policy,
deployed observability, load testing and hosted recovery evidence remain substantial work.

## Release blockers and work order

| Workstream             | Acceptance criteria                                                                                                 | Current status                                                                                                                                                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test and CI foundation | Reproducible build, lint, type checks, unit tests, real database/Redis integration and retained CI reports          | Complete local regression: 191 integration and 64 fast cases pass, lint/types/build pass; CI has three disjoint integration groups, independent reports and a final gate; GitHub/Linux execution and repository merge rules remain unverified                                                                          |
| API request protection | Shared per-address/account budgets, bounded bodies, sanitized retry/failure behavior and cross-instance tests | Redis-backed tracking/shipment/payment budgets and pre-auth API body limits verified locally; signed callbacks remain reachable during Redis failure; hosted proxy/abuse tuning, free-tier budgets and other endpoints remain outstanding |
| Response privacy       | Shipment and analytics relations select approved contact fields; real API regression tests cover all roles          | List, detail and analytics boundaries plus minimal public tracking verified locally through HTTP/PostgreSQL; authenticated event history uses scoped cursor pages; hosted/client adoption and other response surfaces remain outstanding                                                                                                                                                                                                                                     |
| Private fleets         | Invitation-only onboarding, single business membership, database constraints, cross-business denial tests           | New/existing driver enrollment and fleet constraints implemented; existing-driver handler and database tests pass; abuse controls, full JWT/HTTP and legacy reconciliation evidence outstanding                                                                                          |
| Shipment authorization | Every read/write verifies ownership or assignment; denied writes leave data unchanged                               | Detail HTTP and SQL role/ownership/assignment checks verified locally; command HTTP, write-race and fleet denial verified; hosted/full-client verification outstanding                                                                                                                                                 |
| Sessions               | Revocation, refresh reuse detection, concurrent refresh policy, password recovery and verification                  | Server sessions, guarded login/signup/recovery HTTP, atomic signup and credential races verified locally; full app/browser journeys, verified-email policy, hosting ingress, provider and deployed evidence outstanding                       |
| Shipment correctness   | Atomic events, conditional transitions, retry safety, assignment races, delivery proof and returns                  | Creation/update/history/outbox/saved results are atomic; creation and command replay, workflow versions, races, stale cycles and lost acknowledgements verified locally; Recipient-code delivery proof and failed-delivery/return custody verified locally; physical/recipient trust policy, client/hosted adoption and capacity outstanding                                                                                            |
| Payments               | Public signed callbacks, amount/currency checks, idempotency, reconciliation, refunds and sandbox evidence          | Shipment checkout guards, reconciliation, single applied receipts, additional-money review and verified full-refund resolution pass local SQL/HTTP/fault tests; actual Stripe sandbox, partial/applied refunds, disputes, abuse budgets and deployed operations outstanding |
| Tracking               | Authenticated assigned-driver writes, scoped subscriptions, revocation, reconnect and stale-location policy         | Socket authentication, per-event/per-delivery authorization, atomic GPS writes, bounded traffic and real client/PostgreSQL tests verified locally; minimal public-link status/date/event projection verified locally; frontend adoption, distributed adapter/budgets, shared public-read budgets verified locally; public-link lifecycle, hosted edge protection, deployed networking and capacity evidence outstanding            |
| Notifications          | Durable dispatch, preferences enforced, bounded retries and replay, valid links                                     | Atomic outbox capture, deduplicated in-app delivery, email retries/dead letters/replay, configured escaped links, Redis loss and killed-worker recovery verified locally; SMTP ambiguity documented; additional channel/preferences, provider/deployed evidence and alerting outstanding |
| Migrations             | Fresh install and supported upgrade tested; business preference columns included; historical journal handled safely | Production runner core verified with actual 0000–0015 SQL, fresh install, existing-account upgrade, rollback, concurrency and history validation in PostgreSQL; hosted Neon transport, legacy fleet FK reconciliation/validation and deployed upgrade evidence outstanding               |
| Performance            | Agreed peak workload, latency/error targets, representative data, sustained and overload tests                      | Bounded cursor lists, seek plans and a 50,000-row/10-tenant local steady/burst/recovery baseline verified; 2,450 operations passed. Hosted transport, larger/skewed data, soak, workers and saturation remain unverified                                                                                                                                                                                                                                                                               |
| Delivery               | Versioned artifact promoted through staging, deployment checks and tested rollback                                  | Dev-only opt-in Render source release job, isolation guards, Docker proof and hosted smoke tooling prepared; local helper/fixture checks pass; container pull blocked by Docker Hub DNS, hosted configuration/release/rollback unverified                                                                                                                                                                                                                                                                                  |
| Operations             | Redacted telemetry, alert exercise, graceful shutdown, backup restore drill and incident runbooks                   | API/background JSON events, correlation IDs, health probes, private metrics, backlog signals and local Prometheus/Alertmanager drill implemented; 64 fast and 191 complete integration cases passed on 2026-11-05; historical failed/interrupted reports retained; deployed receivers/log retention, local three-case PostgreSQL recovery verified; host monitoring and hosted restore/incident rehearsal outstanding |
| Data lifecycle         | Tenant offboarding, account deletion, financial/location retention and public tracking visibility rules             | Eleven bounded opt-in cleanup tasks, dry-run preview, durable checkpoints, payment/custody safeguards and alerts verified locally; tenant/account deletion, financial/log/backup retention and deployed activation remain outstanding                                                                                                                                                                                                                                                                                  |

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

## Payment lifecycle and duplicate collection — 2026-11-03

PR-06/07/09/10 acceptance: one guarded shipment checkout across different keys
and payers; provider-confirmed closure before replacement; bounded durable
reconciliation; one applied receipt with atomic notification capture; additional
money retained for review; verified full-refund proof and operator audit fields.
Migration 0009 installs shipment guards, receipt uniqueness, lifecycle/review
columns, reconciliation indexes and transactional PostgreSQL functions. Scope is
backend only. No external payment, production migration or deployment was run.

Initialization locks the shipment before allocating a pending payment and guard.
Unknown provider outcomes retain the guard. Cancellation navigation is not proof:
the authenticated endpoint expires through Stripe and validates the resulting
session. Complete/unpaid or processing intents remain reserved. Paid callbacks
serialize on the shipment and either apply one receipt or record review without
another fulfillment notification. A cancelled attempt's late successful receipt
is retained; refunded review balances cannot be resurrected by event replay.

The in-process sweep uses bounded PostgreSQL leases and the original immutable
provider key/parameters only inside the 23-hour safe window. Missing parameters,
changed credentials and older unknown outcomes require operator attachment of a
verified provider session. Operator commands expose pending/review records and
record a successful full Stripe refund only after reference, intent, currency,
amount and session validation. Refund ID uniqueness and operator/timestamp fields
preserve resolution history. Applied-payment refunds, partial refunds and disputes
still need a separate policy and implementation.

Existing pending Stripe attempts quarantine their shipment during migration;
historical successes backfill one receipt and flag additional balances. Review
balances keep their own guard until verified refund resolution. Drain older
instances at cutover, rehearse migration locks/backfill duration and configure the
two additional Checkout webhook event types described in docs/payments.md. No
additional secret or infrastructure dependency is needed.

Local Windows / Node 24.12.0 evidence completed on 2026-11-04 (Lagos): lint,
strict type checks and Bun 1.3.12 build passed (841 modules, 3.35 MB). All 51 fast
tests and 143 integration tests passed with zero failures, skips, todos or
cancellations. The seven-file full integration run took 611.24 seconds with two
files in parallel, ending 2026-11-03T23:01:05.897Z. Validated JUnit/JSON results
are in reports/unit.* and reports/integration.*; local commit=null. Fourteen new
payment cases and two migration cases extend the prior 127-test baseline.

The final refund-atomicity change was then checked separately: one focused
integration case passed and its retained reports/payment-refund.xml validates
as one pass, no skips/failures. It injects a database trigger failure during guard
release and proves refund status/audit fields roll back before successful retry.
This targeted recheck covers the final change after the full suite; it is not an
additional distinct test in the 143-case total.

Tests use disposable PostgreSQL 17, Hono HTTP handlers, official SDK-signed
webhook payloads and a loopback Stripe HTTP fixture. Cases include different-key/
payer contention, cached closed checkout denial, cancellation/expiry, missed
webhooks, lost create responses, provider retry cutoffs and verified operator
attachment, late/competing receipts, cancelled shipments, processing and cancelled
PaymentIntents, lease recovery, invalid provider bindings and full-refund proof.
Existing real Redis/SMTP/socket suites also passed against the updated schema.

An earlier full run hit the old ten-minute suite limit with no assertion failure
reported before termination; its incomplete/failing evidence is retained in
reports/integration-before-payment-timeout.*. The expanded suite remains bounded
at fifteen minutes, two files in parallel, with a twenty-minute CI job allowance.
Report validation still rejects missing/truncated, zero-test, failing or skipped
results. Remote GitHub/Linux execution has not been performed.

These are controlled provider contracts, not a Stripe sandbox, hosted Neon/Bun,
production capacity or deployed timer/alerting validation. Frontend adoption must
use `applied` rather than provider `paid` to acknowledge shipment payment success.
Real provider/browser journeys, migration/backfill rehearsal, operators/alerts,
deploy/CD, restore drills and load evidence remain release gates. Completion is
**8/10**, a scoped planning estimate; production readiness remains unverified.

## Observability and operational health — 2026-11-04

PR-07/08/10/11/14/18/20 acceptance: runtime logs omit credentials/personal payloads;
request IDs correlate HTTP and authentication events without trusting caller IDs;
metric labels stay bounded; liveness is independent of dependencies; readiness
fails on unavailable/outdated database schema and drain; private metrics expose
dependency/transport/backlog state without causing unbounded probe work; real
rules and controlled alert delivery/acknowledgement are exercised.

Implemented JSON request/background events with allowed fields, safe error
responses retaining HTTP status, route templates and AsyncLocalStorage correlation.
Raw request logging and development SQL parameter logging are removed. Metrics
use the maintained pinned @prometheus-io/client 0.16.1 package and the Bun lockfile.
The initial prom-client install was reported deprecated by npm and replaced;
no deprecated direct metrics dependency remains. No clean vulnerability scan is
claimed from installing dependencies; dependency security triage remains a gate.

Liveness remains dependency-free. Readiness caches/single-flights a required-schema
query with deadlines and fails during drain. Redis is observed as asynchronous
degradation, preserving the ability to capture durable work while delivery is
down. Metrics require an independent optional METRICS_TOKEN; missing configuration
disables the endpoint. PostgreSQL/Redis addresses and raw errors are not public.
Neon transport timing/errors, request histograms/in-flight work, process RSS,
background failures and reconciliation outcomes are instrumented. Durable backlog
queries seek indexed oldest records and preserve their last-good timestamp on
collection failure; they do not perform full-table counts. Migration 0010 adds
two partial indexes. Backfill/index lock timing still needs deployment rehearsal.

Optional local Prometheus/Alertmanager configuration includes latency/error,
dependency, dead-letter, overdue-work/lease, review and stale-telemetry alerts.
Monitoring ports bind to loopback, scraper credentials are a secret file, and the
default receiver is unconfigured. A deployed receiver, responder, retention/access
policy and notification drill must be established before release. No external
message, production monitor, frontend edit or live migration was performed.

Initial focused evidence used Prometheus 3.5.0 and Alertmanager 0.28.1. A support
check identified the older Prometheus release as out of support; final configuration
and verification use Prometheus 3.13.5 and Alertmanager 0.34.2 from the projects'
Quay registry. The rule fixture evaluates pending/firing/recovered review state
and repeated reconciliation failures. A real
Prometheus scrapes an actual PostgreSQL review record, waits through the shipped
one-minute hold and delivers through Alertmanager to a local HTTP receiver; an
Alertmanager silence acknowledges the synthetic incident. No provider delivery
is inferred.

Final local verification: lint, type checks, the Bun build (935 modules, 3.53 MB)
and frozen-lockfile installation passed. All 58 fast cases passed without skips.
The latest full integration run finished with 147 of 149 cases passing in 640.896
seconds: all 143 existing integration cases passed, while two monitoring cases
failed because their container images could not be downloaded. The unsuccessful
reports/integration.xml and integration.json are retained without rewriting them
as a green run. After the supported images finished downloading, all six
observability cases passed in 90.149 seconds, without skips or todos; validated
evidence is retained in reports/observability-final.xml and .json. This is split
full-run/recheck evidence, not a single successful 149-case run.

Earlier failed and interrupted full runs are retained in
reports/integration-before-observability-recheck.* and
reports/integration-interrupted-monitoring.*. The two unchanged cases affected by
the earlier shared host stall passed their focused recheck, retained in
reports/monitoring-recovery.xml. CI now prepares all four service images before
the integration phase so image-download failures are reported separately from
test execution. Remote GitHub Actions execution remains unverified.

See docs/observability.md for contracts, thresholds, cardinality/cost constraints,
local setup and response procedures. Complete Bun entrypoint/hosted Neon, ingress,
provider journeys, remote CI, deployed log/alert routing, overhead/load, operating
ownership and restoration remain release gates. Completion remains **8/10** while
those material operational and release checks are outstanding.

## Local database recovery — 2026-11-04

PR-09/19 acceptance: an actual logical backup restores all migrated fixture data
and migration history into a separate PostgreSQL 17 database with the original
source unavailable. Credential/session checks, completed idempotency state,
shipment/history/outbox writes and payment receipt invariants must remain usable.
Corrupt input must fail without application tables, and a populated destination
must be refused. The small-fixture restore plus verification budget is 120 seconds;
this is not a hosted service RTO or production capacity estimate.

Implemented `npm run recovery:drill` using actual pg_dump/pg_restore, two disposable
Docker containers, synthetic data and the production migration runner/SQL. No .env,
live database, external provider or recipient is used. The normal integration
discovery includes the same three cases and CI retains their evidence. Archives
remain bounded fixture memory, not stored backup artifacts. See docs/recovery.md
for exact timing scope, evidence, operator procedure and side-effect reconciliation.

Final verification: all three recovery cases passed without skips, todos or
cancellations in 53.814 seconds, ending 2026-11-04T08:34:06.495Z on Windows/Node
24.12.0 with PostgreSQL 17. The source was stopped/removed before restore. Backup
took 931 ms, producing a 66,354-byte custom archive; restore plus application
primitive verification took 16,041 ms against the 120-second local budget.
Validated JUnit/JSON and detailed measurements are in reports/recovery.* and
reports/recovery-measurements.json; local commit=null. All 58 fast cases and lint
passed again; types passed earlier in this build. Full integration and remote CI
were not rerun for this isolated drill; existing runtime code is unchanged.
The initial three-case pass preceded the source-removal strengthening and is not
used as evidence of that condition. An earlier sandbox-denied Docker run is retained in
reports/recovery-sandbox-denied.* and is not counted as a test pass.

Production backup scheduling, encrypted independent retention, hosting support,
agreed RPO/RTO, realistic restore volume, revoked-session/token handling, external
payment/email reconciliation and a full deployed cutover remain unverified.
Completion remains **8/10**; local recovery evidence does not clear those gates.

## Shipment command retry and concurrency safety — 2026-11-04

PR-07/09/10 acceptance: assignment, status changes and cancellation require a key
and expected workflow version; identical retries return their committed snapshot;
competing keys cannot both change one version; status cycles do not revive stale
requests. Shipment/version/history/outbox/saved-result writes are atomic, including
rollback and lost-acknowledgement recovery. Current identity/fleet access must be
checked before writing or replaying. Invalid input/denied commands do not create
new durable requests. Expired committed keys remain non-reusable tombstones.

Migration 0011 adds a nonnegative integer workflow version and database trigger,
extends the request operation constraint and installs the atomic command function.
The shared HTTP command router replaces all three unversioned public update
handlers. Keys are user/operation-scoped and body fingerprints include shipment,
action, version and normalized inputs. Each lock wait is limited to two seconds;
no external work or committed processing lease occurs inside the transaction.
Readiness requires the new column. See docs/shipment-commands.md for the API
contract, different contention behavior from creation, bounds and rollout.

Eight new integration cases passed through real loopback HTTP, signed JWT/session
checks and PostgreSQL 17, using the production migration runner and SQL. The first
run caught PL/pgSQL CASE syntax during migration; it was fixed, and its failing
report remains in reports/shipment-commands-initial.xml. The focused rerun passed
all eight in 41.216 seconds without skips. Final authorization rechecks after
lock waits and the readiness schema check were included in the full regression.
That run finished 2026-11-04T08:55:27.460Z in 592.415 seconds with 159/160 passing:
all shipment, migration, account, payment, outbox, recovery and tracking cases
passed. One existing live alert-delivery fixture exceeded its 120-second deadline.
The unsuccessful reports/integration.xml and .json remain intact, not marked green.

The alert fixture had a one-second scrape/deadline despite its Docker/psql
transport. It now uses the production 15-second cadence with a ten-second scrape
deadline, retaining the actual one-minute alert hold, local delivery and silence
assertions. Timeout diagnostics now retain target health/error/duration. This
addresses a plausible contention-sensitive fixture cause; the failed run had no
target diagnostic proving its exact cause. No production alert rule was relaxed.

The final parallel focused recheck passed all 15 cases (nine shipment, six
observability) in 95.679 seconds, with zero failures, skips, cancellations or todos.
The added shipment case completes the actual delivery progression, checks pickup/
delivery timestamps and rejects terminal/skipped/unavailable-driver commands
without new reservations. The monitoring delivery case took 75.853 seconds.
Validated reports/shipment-safety-final.xml and .json retain this evidence. This
is a full-run plus focused recheck, not a single green 161-case integration run.
Local commit=null; remote GitHub Actions remains unverified.

All 58 fast cases, lint, types and build (936 modules, 3.53 MB) passed for this build.
The generated schema snapshot is included; no historical migration was edited.

Production Neon/Bun/ingress, frontend contract adoption, deployment-scale locks,
key/traffic budgets, workload/capacity and delivery proof/returns remain separate
gates. Stop old write-serving instances during coordinated rollout; retaining
old handlers bypasses the client-version/key contract. No frontend edit, live
migration or deployment was performed. Completion remains **8/10**.

## Bounded shipment lists — 2026-11-04

PR-07/09/13 acceptance: every authenticated role uses bounded, stable cursor pages;
strict limits/filters/cursors cannot widen access; database timestamp precision
and ID ordering survive traversal; routine mutable updates/newer inserts do not
duplicate earlier rows; a deleted boundary remains usable. Related contacts are
allowlisted and event histories bounded. Deep queries must seek through indexes
without OFFSET/full-count work. No million-user capacity conclusion follows.

Implemented one shared list router/SQL path replacing unbounded driver/customer
lists and business offset/count pagination. Default/max limits are 20/50. Cursors
retain UTC microseconds and use the creation-time/ID C-collation order, bound to
account/role/filter consistency. SQL independently rechecks current identity and
fleet/ownership/customer scope. Lookahead and relations cover at most limit+1
rows; event histories are limited per role. Driver profiles no longer leak
insurance/preferences/private fields. Migration 0012 adds five matching scope/
order indexes and a generated snapshot; historical SQL remains unchanged.

Verification: all 60 fast cases passed (two new), plus all 27 focused integration
cases (seven pagination, eight migration, three recovery, nine commands), without
skips/failures/todos/cancellations. The focused run took 106.839 seconds on local
Windows/Node 24.12.0/PostgreSQL 17. Validated JUnit/JSON evidence is in
reports/shipment-pagination-final.*; local commit=null. Lint, types and Bun build
(939 modules, 3.54 MB) passed. The complete backend suite and remote CI were not
rerun for this read-path/additive-index build; those earlier reports remain as
historical evidence, not a pass for the full current artifact.

The first integration run passed six cases and failed a plan assertion requiring
one specific index on a mostly unique-timestamp dataset. PostgreSQL chose an
existing creation-time index plus a small incremental sort; this was an overly
prescriptive expectation, not a demonstrated sequential-scan defect. The retained
reports/shipment-pagination-initial.xml records that failure. A dedicated
10,000-row batch-import/tied-timestamp dataset now exercises deep ID seeking;
the plan test passed all four scopes/filters with the new composite indexes,
no shipment sequential scan and at most 21 shipment rows examined for a 20-row
page. EXPLAIN ANALYZE JSON is retained in reports/shipment-page-plan-*.json. This
is one workload shape, not a substitute for varied data/load measurements.

See docs/shipment-pagination.md for removed numbered pages/totals, default driver
filter, creation-time ordering, live-list behavior, reduced driver relations and
frontend adoption. No frontend, live migration, new secret or deployment changed.
Hosted Neon/Bun/ingress, production index lock/build costs, detail-history bounds,
other list endpoints and capacity/overload remain gates. Completion stays **8/10**.

## Guest-recipient delivery confirmation — 2026-11-04

Decision: the business supplies a separate recipient email; an IsoTrack customer
account is not required. Recipient email is independent of customer account/payment
linkage. Only the owning business requests/resends; only the active assigned
driver confirms after handover. PR-06/07/09/10/18 acceptance: confirmation cannot
be bypassed by the old status path or new delivered inserts; expiring codes,
durable guessing/resend budgets, current scope/version and atomic proof/history/
notification/result commits withstand replay, races and faults. No absolute
physical-handover, identity or legal-proof assertion is made.

Implemented migration 0013, recipient creation/issuance input, independent keyed
eight-digit code/proof/fingerprint derivation and authenticated metadata/issuance/
confirmation routes. Codes expire after 20 minutes with five wrong attempts;
resends have one-minute spacing, three per rolling shipment hour and sixty per
business clock hour. Failed guesses are saved idempotently and cannot reset by
key rotation. Plaintext codes are not in database request parameters, fingerprints,
API responses or log events. Delivery worker derives them transiently for SMTP;
recipient mail retention is outside server control. Business-selected inbox
possession is the trust boundary; forwarding, premature sharing and collusion
remain possible.

Database proof guards cover public commands and insert/update bypasses. Receipt
consumption records the assigned actor, version and time, and rolls back with
history/outbox failure. Existing delivered history is preserved without inferred
proof. Recipient email advances the version on change and is hidden from driver/
customer list/detail/status/confirmation and public tracking responses. Worker
claims are bounded/fenced, expire and retry at most five sends using existing
SMTP infrastructure, with at-least-once ambiguity documented. Delivery queue
metrics join the existing overdue/dead/expired-lease alerts. Aggregate status and
bounded 7-day unused/90-day consumed cleanup commands are included; retention
defaults require deployment/business review.

Final local verification: all 62 fast cases passed without skips, plus 46 focused
integration cases (13 delivery, 8 migration, 6 monitoring, 3 recovery, 9 shipment
commands, 7 pagination) in 231.763 seconds. These use PostgreSQL 17, actual loopback
HTTP, signed sessions, a real local SMTP sink, worker leases, fault injection,
Prometheus/Alertmanager and restore. Validated reports/delivery-final.xml/.json
retain the result; local Windows/Node 24.12.0, commit=null. Lint, types and final
Bun build (943 modules, 3.55 MB) passed. Malformed-ID validation was checked by the
final fast suite after the main focused run; existing valid-ID behavior is unchanged.

The initial delivery suite passed 8/9; its revoked-code fixture incorrectly
reactivated two challenges, and the unique active-proof constraint correctly
rejected it. That failed evidence remains reports/delivery-initial.xml. The fixed
expanded suite then passed 11/11; later added metrics/insert-guard/retention cases
bring delivery coverage to 13 in the final focused report.

The complete backend run reported ETIMEDOUT/SIGTERM with truncated JUnit; its
failed/incomplete evidence is retained in reports/integration-delivery-interrupted.*
and the canonical integration reports. It is not a full pass. The creation/checkout
recheck initially passed 10/29 and failed 19 with 401 after its email-change case:
that fixture previously omitted migration 0008's real email/session invalidation.
The complete migration chain is now applied; explicit new fixture sessions after
email changes preserve production revocation and immutable-provider-request
assertions. The failed report remains reports/delivery-checkout-stale-sessions.xml.
Final checkout recheck passed all 29 cases in 256.413 seconds with zero failures,
skips, cancellations or todos; validated reports/delivery-checkout.xml/.json
retain the result. Combined with the 46-case focused run, 75 distinct integration
cases passed. No full regression/remote CI success is claimed from focused runs.
Timed-out test-owned containers/network
were identified by exact names/creation times and cleaned up.

See docs/delivery-confirmation.md for routes, trust/retention policies, key rotation,
SMTP ambiguity and rollout. Add independent DELIVERY_CODE_SECRET (64 hex chars)
to API/worker environments, migrate first and stop old write-serving instances.
Missing configuration fails closed. Frontend adoption, real provider delivery,
hosted Neon/Bun/ingress, complete stable regression/CI, migration-scale locks,
restore reconciliation, returns and capacity remain gates. No frontend edit,
configured database migration, real recipient email or deployment occurred.
Completion remains **8/10**; production readiness is unverified.

## 2026-11-05 — Failed deliveries and returns

Implemented migration 0014, structured failure reasons, three-attempt retries,
private version-paginated exception history and owner/driver return commands.
Post-pickup custody cannot be cleared until business receipt; retry retains driver,
pickup time and ordered GPS. Receipt is terminal. Commands atomically revoke old
delivery codes and save history, notifications and idempotent responses. Existing
payment fields are unchanged. Held packages remain on driver worklists and expose
an indexed age metric with a 24-hour/ten-minute Prometheus warning. See
shipment-exceptions.md for contracts, trust assumptions and rollout.

Local evidence uses Windows/Node 24.12.0, disposable PostgreSQL, signed HTTP,
production migration/command/query code, fault injection and local monitoring
containers. The first broad selected run passed 68/70 cases in 302.159 seconds
(reports/shipment-exceptions-before-recheck.xml, also shipment-exceptions-final.xml).
It failed a restore history validation because migration 0014 was edited during
the run; migration files were frozen before recheck. An older command fixture also
attempted to erase custody directly. It now asserts that denial and completes a
business-controlled return before removing assignment and testing replay access.

The affected 30-case recheck passed 29 in 189.799 seconds: all eight migration,
three recovery and ten exception cases passed. One command assertion was accidentally
changed from version three to six while editing the custody fixture; the database
correctly returned three. The assertion is corrected. That failed report remains
reports/shipment-exceptions-recheck.xml; a separate final command rerun records
the corrected result: all nine passed in 64.454 seconds, zero failures/skips/todos
or cancellations (reports/shipment-commands-exceptions-final.xml). Across the
focused runs, all 70 distinct selected integration cases have a passing result.
The broad run also passed all 13 delivery, seven pagination,
14 tracking and six observability cases, including actual local alert firing and
recovery. These are focused results, not a clean full-backend/remote CI run.

Migration 0014 is additive but its transactional index builds need representative
lock/duration/disk rehearsal. Reconcile legacy attempt counts and custody before
launch. No frontend change, configured-database migration, external mail or
deployment occurred. Hosted Neon/Bun behavior, client journeys, real providers,
complete CI, capacity, data lifecycle and deployed operations remain release gates.
Completion remains **8/10**; production readiness is unverified.

Final static checks passed: lint, TypeScript, 62/62 fast tests (7.238 seconds)
and Bun build (945 modules, 3.56 MB). Reports/unit.xml/.json retain fast evidence.

## 2026-11-05 — Complete backend regression and CI gates

PR-09/11/14/15/17/18/19: complete local integration execution passed **191/191**
in 758.923 seconds, with zero failures, cancellations, skips or todos. Command:
`npm run test:integration`; validated `reports/integration.xml` and `.json` cover
all 13 discovered integration files. Runtime: Windows, Node 24.12.0, disposable
PostgreSQL 17/Redis 7, local SMTP/HTTP/Socket.IO and Prometheus/Alertmanager.
Coverage includes migration 0000–0014 installation/upgrade/history/rollback/races,
restore with the source unavailable, tenant denial, invitation/session races,
payment replay/reconciliation, queue recovery, alert delivery, delivery proof,
returns, pagination and authenticated GPS. Stripe failure cases use a local fixture;
this is not real Stripe sandbox verification or hosted Neon transport evidence.

The complete run began against application commit
`0a6a710e0c12f9df0a80b699df6a1277dfb01eef`; report commit is null because this is a
local execution. CI tooling changed during the run, without modifying application
code, migrations or integration fixtures. The ungrouped run used the runner loaded
at startup. Current working-tree tooling is covered separately by fast checks and
a grouped runner smoke check. Do not attribute these local reports to a remote
Actions run or a future commit. Earlier failed/incomplete canonical reports were
copied to timestamped `reports/integration-before-regression-*` before execution.

CI now separates quality from three integration groups. Deterministic file
partitioning covers every integration file exactly once, auto-includes new files,
rejects invalid groups and keeps report names independent. Matrix failure does not
cancel siblings; reports are uploaded after test failures. Final `checks` runs
regardless of dependency outcome and fails unless quality and all integration
groups succeed. No assertion retry, skip or reduced coverage was introduced.
Fast tests passed **64/64** in 3.735 seconds, including group coverage and invalid
configuration cases. Lint, TypeScript, workflow/runner formatting and Bun build
(945 modules, 3.56 MB) passed. Reports remain local/ignored until CI uploads its
own artifacts. See docs/ci.md for group reproduction and required check settings.

GitHub connector lookup for the current commit returned 404. Remote access and the
updated workflow's Linux execution remain unverified; nothing was pushed or
deployed and repository protection settings were not changed. The next remote
gate is a green Backend CI run for the pushed commit with all four test artifacts,
then repository rules requiring `checks`. No live database or recipient was used.

Completion estimate advances to **8.5/10**, a planning judgment rather than a
capacity measurement. Remaining release gates include remote CI, frontend/client
journeys, real provider sandboxes, hosted runtime/ingress and recovery, data lifecycle
controls and representative load/overload testing. Production readiness remains
unverified; the full local pass does not establish support for millions of users.

The current grouped runner was also exercised with
`node scripts/run-tests.mjs integration 9/13`: all **53/53** ownership, invitation,
payment and session cases passed in 77.690 seconds, zero skips/todos/cancellations.
Validated `reports/integration-9-of-13.xml` and `.json` identify exactly
`tests/shipment-access.integration.mjs` and shard 9/13, independently of the complete
run's reports. This smoke run checks the new execution/report path; it is not an
additional 53 distinct cases and does not establish the three remote matrix runs.

## 2026-11-05 — Linux monitoring fixture permissions

User-provided GitHub Actions logs show integration group 2 executed 32 tests:
30 passed and two monitoring cases failed. Rule validation reported
`stat rules-test.yml: permission denied`; the alert drill failed retrieving
Alertmanager's published 9093 port. The latter is a startup symptom; its original
container logs were not available, so its precise cause is not independently proven.
The final `checks` job correctly rejected the failing integration group.

The fixture's mkdtemp directory was owner-only (0700 on Linux) while Prometheus and
Alertmanager use non-root container users. Synthetic configuration now uses a
0755 directory and explicitly 0644 files, with the bind mount still read-only.
Containers retain their default users. Long-lived monitoring containers are retained
until the existing after-hook cleanup, allowing startup failures to save their state
and bounded logs. Readiness is checked before using the services. Diagnostics redact
the synthetic metrics token and are included in integration CI artifacts.

An isolated Linux Docker volume reproduced the exact promtool permission denial
with mode 0700 (exit 1). With directory 0755 and files 0644, the same default-user
Prometheus image passed the production rule tests (exit 0, SUCCESS). Evidence:
reports/monitoring-linux-permissions.json. The disposable probe container and volume
were removed. This establishes Linux filesystem behavior, not a full Linux backend run.

All six monitoring integration cases passed in 96.824 seconds, zero failures,
skips, cancellations or todos (reports/monitoring-ci-fix.xml). This includes rule
pending/firing/recovery evaluation, actual alert delivery/acknowledgement, real
PostgreSQL/Redis readiness and database-loss behavior. Lint passed. Application
code, migration history, test assertions and action versions are unchanged; existing
action allowlist entries still apply. Node-action deprecation warnings remain a
separate maintenance item. No new full regression was needed for this fixture-only
change. Updated remote CI success is pending; completion estimate remains 8.5/10.

## 2026-11-05 — CI action runtime cleanup

The user reports no errors after the monitoring-fixture fix. This is user-reported
remote success; the run URL, commit, artifacts and protection settings have not
been independently inspected through the connector.

CI now selects Ubuntu 24.04 and Node-24 action majors for checkout, setup-node and
upload-artifact (v6). Their official tagged manifests were inspected before editing;
existing inputs remain available. Application runtimes, test discovery, gates and
artifact retention are unchanged. Repository allowed-action entries must include
the new tags before pushing; no GitHub settings were edited here. New remote CI
execution and warning cleanup remain unverified. Completion estimate stays 8.5/10.

## 2026-11-05 — Repeatable load baseline

PR-09/11/13/14: added a bounded fixed-arrival load generator, isolated PostgreSQL
TCP fixture and manual Backend load baseline workflow. No application routes,
indexes, migrations, frontend or deployed settings changed. The pg 8.23.1 development
dependency avoids timing docker-exec startup as query latency. Actual production
routers, JWT/session authentication and SQL execute against the migrated database;
this is not a full production app/Neon/Bun measurement. No target URL is accepted.
Database resources are capped at two CPUs/512 MiB and the pool at 16 connections.

The ten-tenant fixture has 50,000 read shipments, 5,000 write fixtures and 50,000
events with timestamps spanning 30 days. The 65-second baseline offers warmup,
20 operations/s steady traffic, 100 operations/s burst and 20 operations/s recovery.
Normal read/denial p95 limits are 500 ms and assignment+replay 1,000 ms; burst limits
are 1,500/2,500 ms. Every phase requires zero failed/dropped operations. These targets
were defined before execution and were not relaxed in response to results.

Local Windows/Node 24.12.0 baseline passed all 2,450 operations (2,940 HTTP requests),
zero failures/drops. Worst read-role p95: steady 15.3 ms, burst 117.6 ms, recovery
23.4 ms. Assignment+replay p95: 27.4/133.2/21.1 ms. Durable integrity: 490 assignments,
490 events, 490 saved responses and zero changes to foreign fixtures. Query-plan
samples used the expected scope/event indexes. No measured bottleneck justified an
application query/index change. Reports/load-baseline.json retains timings, scope,
thresholds, plans, resource observations and integrity. Local commit is null.

Initial smoke setup timed out while bulk seeding with the five-second request
statement limit (reports/load-smoke-seed-timeout.json). Setup now has a 90-second
limit outside measurements; request statements still have five seconds. The fixed
smoke profile passed 50/50 operations. Lint, TypeScript, frozen dependency install
and Bun build (945 modules, 3.56 MB) passed. Fast tests passed 66/66, including
load-generator drop accounting, bounded concurrency and failing threshold behavior.
The first lint invocation caught an unused fixture variable; it was removed and
final lint passed. Full integration rerun is left to CI for this tooling-only change.

The user reports completing remote CI, artifact review and branch protection through
the PR step. This remains user-reported evidence without independently inspected
run URLs/settings. The new optional performance workflow needs its own remote run;
it reuses the existing action allowlist and needs no application secrets. No push,
deployment, live migration, real provider traffic or recipient messages occurred.
See docs/performance.md for reproduction, interpretation and remaining capacity work.

Completion remains 8.5/10. Initial local performance evidence is now verified, but
maximum capacity, hosted behavior, longer soak runs, heavily skewed/larger datasets,
queue/GPS fan-out, dependency saturation and deployed recovery are not established.

## 2026-11-05 — Retention and cleanup safeguards

PR-08/09/10/11/14/18: owner approved closed-shipment GPS after 30 days, unaccepted
invitations after expiry plus 30 days, and read/sent notifications created over
90 days ago. Existing token/session/outbox policies are preserved, with stronger
payment and active-key safeguards on idempotency scrubbing. Pending/missing/reviewed
payments retain recovery parameters; hashed key tombstones remain permanent.
Financial records, shipment rows and audit history are not deleted. Only eligible
location fields are scrubbed, with payment/custody holds and workflow versions intact.

Migration 0015 adds eleven durable task checkpoints and cleanup indexes. Preview
is bounded/read-only; explicit run and an opt-in API scheduler execute at most
500 records/task/cycle. Per-task advisory ownership, SKIP LOCKED, local SQL deadlines,
atomic data/checkpoint writes and graceful drain bound concurrency and failure
impact. Retention defaults disabled. Metrics/logs expose bounded task/status/count
fields, with overdue-checkpoint and failed-batch warning rules. See retention.md
for the exact policy, operator commands, rollout and remaining lifecycle scope.

Windows/Node 24.12.0 disposable-dependency verification:
- Initial focused run: 27/28 passed in 148.399 seconds. All eight migration, three
  restore and eleven initial retention cases passed; an old monitoring assertion
  incorrectly expected the persistent cleanup checkpoint backlog to disappear.
  The assertion now checks ordinary queues separately and explicitly expects the
  checkpoint records to remain. Failed evidence is retained as reports/retention-initial.xml.
- Final delivery/payment/idempotency/monitoring/retention regression: 61/61 passed
  in 380.646 seconds (reports/retention-final.xml/.json), zero failures, cancellations,
  skips or todos. This includes the corrected monitoring test, actual local alert
  delivery and rule tests for cleanup warning gating/firing, plus 13 retention cases.
- Final expanded policy suite: 14/14 passed in 44.938 seconds
  (reports/retention-policies-final.xml/.json), adding delivered-GPS cleanup with
  delivery proof and workflow version preserved. Other cases cover preview, batch
  caps, repeat runs, active records, payment holds, leases, notification deduplication,
  private GPS/event fields, checkpoint rollback, missing configuration, distributed
  ownership and row-lock skipping.
- Across these runs, 73 distinct targeted integration cases have a passing result;
  repeated cases are not added again. This is not a clean complete backend CI run.
- Fast suite: 69/69 passed in 3.979 seconds, zero skips/todos/cancellations/failures.
  Lint, TypeScript and Bun build (950 modules, 3.57 MB) passed. Test tooling reports
  local commit=null; source base is 433884b with working-tree retention changes.

No historical migration was modified. No live query, deployed cleanup, main-branch
merge, push or frontend change occurred. RETENTION_ENABLED=false remains the default;
apply 0015 and inspect preview on an isolated preview deployment before enabling.
Remote CI for this change, hosted Neon transaction/deadline verification, representative
cleanup query/lock/catch-up measurements and operational activation remain gates.
Current scope does not resolve tenant offboarding, account erasure, driver-profile
GPS, legal/dispute holds, financial retention, logs or backup lifecycle. Completion
remains 8.5/10; production readiness remains unverified.


## 2026-11-05 — Shipment detail and analytics response privacy

PR-identity/tenant/privacy/read-performance scope: explicit shipment, account,
driver, payment and event projections replace full detail graphs and private driver
relations in analytics. Recipient email remains business-only; drivers receive no
payment object. Current active role and ownership/fleet assignment are checked in
the read SQL. Payment command access checks now fetch only shipment identity.
Details return at most 50 latest events with eventsTruncated; recent analytics
returns at most ten shipments. Analytics computes exact counts/quoted-price sums
inside PostgreSQL in one snapshot, and GET no longer creates a missing profile.
The existing totalRevenueKobo field remains quoted value, not settled revenue.
See shipment-response-privacy.md for contracts and limitations.

Local Windows/Node 24.12.0 evidence, source base 307ae81 plus these working changes:
- Initial combined privacy/pagination run: 12/15 passed in 64.501 seconds. All seven
  pagination and first five privacy cases passed. Three later cases failed because
  the fixture reused a session generation after deliberately toggling account
  active state. Renewal is now isolated in beforeEach; production invalidation was
  correct. Original report remains reports/shipment-reads.xml.
- Corrected expanded privacy integration run: 9/9 passed in 44.037 seconds,
  reports/shipment-reads-final.xml/.json, zero failures/skips/todos/cancellations.
  Signed JWT/session authentication, real HTTP and PostgreSQL 17/full migrations
  cover allowed and denied tenants/roles, SQL role/active/assignment rechecks,
  exact private relation fields, events/payment ordering/nulls, aggregate scope,
  missing profiles, storage failure and future-column privacy.
- Across those runs, 16 distinct targeted integration cases have a passing result;
  this is not a fresh full backend integration run. CI discovers the new suite.
- Final fast suite: 70/70 passed in 2.666 seconds with no skips/todos/cancellations.
  The new unsafe-money-total test is a synthetic handler boundary test.
- Lint and TypeScript passed. Bun build passed: 952 modules, 3.57 MB. The initial
  build package resolution was sandbox-blocked; the approved retry succeeded.

No migration, frontend edit, live database/provider request, push, main merge or
live deployment occurred. All work remains on isoTrack-dev-branch. Hosted Neon,
full remote CI and frontend contract adoption are unverified for this artifact.
Older-history HTTP paging, large-tenant analytics rollups/load, public tracking
address/event privacy and other response surfaces remain outstanding. Completion
remains 8.5/10, a planning estimate; production readiness remains unverified.


## 2026-11-05 — Public tracking privacy and paginated event history

PR-06/07/08: anonymous tracking now selects only status/dates and at most 21
status/time event rows, returning twenty with a truncation flag. It no longer
loads or exposes addresses, package description, driver identity/plate, GPS,
payment fields, internal event/shipment IDs or arbitrary event messages. Public
messages are fixed per status. Tracking IDs and query parameters are validated;
route responses use no-store/noindex headers. No link lifecycle or distributed
public-read limiter is claimed.

Authenticated GET /api/v1/shipments/:id/events returns default twenty, maximum
fifty events with one lookahead row and no OFFSET/COUNT. The shared detail/history
SQL rechecks active role, owner/customer linkage or assigned private fleet in the
same snapshot as event selection. Cursors bind shipment/account/role/endpoint,
retain microseconds, and work after deletion of a boundary row. Existing list
cursor format is preserved. No new migration is needed: the event scope/order
index was introduced in 0012. See tracking-history.md for contracts, compatibility
changes and live-list behavior.

Evidence: Windows, Node 24.12.0, source base 3a33035 plus these working-tree changes.
- Local integration command: node --test --test-concurrency=2 with spec/JUnit
  reporters, covering tests/tracking-history.integration.mjs,
  tests/shipment-reads.integration.mjs and tests/shipment-page.integration.mjs.
  All 26/26 cases passed in 121.409 seconds; zero failures/cancellations/skips/todos.
  Reports: reports/tracking-history.xml/.json. This is targeted regression,
  not a new full backend integration/remote CI run.
- The ten new cases use anonymous and signed JWT/session HTTP requests against
  migrated disposable PostgreSQL 17. They cover exact public field keys/private
  markers, standard messages/bounds, input rejection, all-role history traversal,
  tenant/empty/unknown denial, revoked sessions, scoped/malformed cursors,
  microseconds/deleted boundaries, assignment/fleet/active-role rechecks,
  future private columns and sanitized storage faults.
- The large-history case adds 20,000 same-timestamp events. EXPLAIN ANALYZE shows
  public and deep-history event reads using shipment_events_page_idx, without
  event sequential scans and with at most 21 event rows read per tested query.
  Plans: reports/tracking-history-plan.json and reports/tracking-public-plan.json.
  These local plan checks do not establish concurrent hosted capacity.
- Fast suite: 71/71 passed in 3.386 seconds, zero skips/todos/cancellations/failures.
  Lint, TypeScript and Bun build passed (953 modules, 3.58 MB). CI automatically
  discovers the new integration file and existing fast-test changes.

No frontend edits, main merge, push, live deployment, live DB migration or provider
traffic occurred. Work remains on isoTrack-dev-branch. Public response reduction
requires frontend adoption before promotion; hosted Neon/full runtime and remote
CI evidence remain unverified for this artifact. Link expiration/rotation,
distributed public-read abuse protection, full assembled journeys, provider sandbox,
preview/deployment and hosted recovery/monitoring/capacity remain release work.
Completion remains 8.5/10 (planning estimate); production readiness is unverified.


## 2026-11-06 — Shared API budgets and request boundaries

PR-06/07/08: Redis Lua counters now enforce shared address/account budgets for
public tracking and authenticated shipment/payment client routes. Address checks
precede auth DB queries; account checks follow current session/account identity.
Policy is separate per group/read-write operation, with 60-second first-admission
windows and expiring HMAC keys. Denials do not extend TTL; raw IPs/identities/URLs
are not Redis keys. IPv6 /64 and exact trusted-proxy rules reuse existing peer
resolution. Limits, costs, fixed-window bursts and retry semantics are documented
in api-request-protection.md. This is not a universal API/edge abuse protection claim.

Exhausted budgets return JSON 429/Retry-After. Redis/peer failures return sanitized
503/Retry-After without a local allowance or delayed offline queue. Runtime Redis
connect/command deadlines are one second; dependency errors use the bounded
api_budget metric/log operation. Shutdown disconnects the client. Signed Stripe
webhooks precede client budgets and retain their signature/body validation. Global
readiness remains database-based so auth/webhooks can receive requests during
Redis degradation; protected routes independently reject until budget recovery.

The common /api/v1 body boundary runs before auth/provider processing. It enforces
16 KiB ordinary / 256 KiB exact POST webhook sizes by actual byte count, a ten-second
body-read deadline, stream cancellation and unsupported-compression rejection.
Existing tighter route limits remain. No request body is parsed or reserialized
before Stripe signature verification.

Verification: local Windows/Node 24.12.0, base 2e0bde9 plus these working changes:
- Targeted integration run: node --test --test-concurrency=2 with spec/JUnit
  reporters on api-protection.integration.mjs, shipment-commands.integration.mjs
  and tracking-history.integration.mjs. All 26/26 passed in 113.133 seconds,
  zero failures/cancellations/skips/todos (reports/api-protection.xml/.json).
- Seven new cases use two actual HTTP servers/Redis clients, Redis 7, signed JWTs,
  live sessions and fully migrated PostgreSQL 17. A 100-request concurrent burst
  admitted exactly 60 requests across both servers despite spoofed forwarding
  headers; 40 received 429. Further cases cover account/read-write isolation,
  denied real shipment commands leaving rows/events/idempotency unchanged,
  payment-handler suppression, expiry/no-extension, disconnection/recovery,
  valid signed webhook bytes during Redis failure and pre-budget fixed/chunked
  oversize rejection. Public/payment handler counters isolate admission; they do
  not claim real provider checkout/retrieval. The webhook uses the real verifier
  for a synthetic unrelated event, not settlement.
- Nine existing real shipment-command and ten tracking/history regression cases
  pass in the same run. This is targeted regression, not full remote CI.
- Fast suite: 75/75 passed in 4.613 seconds, no failures/skips/todos/cancellations.
  Four new cases verify understated streamed lengths, stalled-body cancellation,
  missing peers/preflight/errors and malformed Redis results. The stalled-stream
  test uses a 25ms fixture deadline, not the production ten-second delay.
- Final lint and TypeScript passed. Initial lint caught an unnecessary type
  assertion, which was removed; its failed invocation is not treated as a pass.
  Bun build passed (956 modules, 3.58 MB). Final changes after the integration run
  were TypeScript-only assertion removal, a health comment and documentation.

No migrations/new secrets, frontend edits, pushes, main merges, live traffic,
paid infrastructure or deployments occurred. Work remains on isoTrack-dev-branch.
Remote CI, hosted Redis/Neon/proxy behavior, provider sandbox, multi-instance hosted
load/free-tier limits and assembled client/preview/recovery remain release gates.
Other driver/business/profile endpoints, edge volumetric/connection controls and
link lifecycle remain outside this batch. Completion remains 8.5/10 as a planning
estimate; production readiness remains unverified.


## 2026-11-06 — Isolated Render preview release preparation

PR-09/11/15/16/17: user confirmed Render as the existing backend host. The existing
CI workflow now has an opt-in preview job after checks, restricted to dev push
and a repository enable flag. It uses a preview GitHub environment, serializes
releases, validates distinct app/database/Redis hosts and Render service IDs before
writes, checks the container, migrates/seeds only synthetic preview data, invokes
a service-scoped deploy hook pinned to the commit, and verifies hosted identity,
readiness and safe role/privacy/request-boundary smoke behavior. No workflow_dispatch
on main is required. The job remains disabled without PREVIEW_DEPLOY_ENABLED=true.

A Bun 1.3.12 multi-stage Dockerfile excludes local secrets by allowlisted context,
runs as bun, and bakes the source SHA. Render rebuilds source; this does not promote
the same tested registry image digest. The public /health/release endpoint contains
only environment/SHA with no-store. Preview startup rejects matching live hosts
(including Neon pooler/direct/trailing-dot forms), enabled workers/retention,
unknown SHA or payment credentials. Other environments preserve worker defaults.
Preview disables SMTP/background delivery and reconciliation because this first
safe, zero-budget environment does not claim provider or always-on worker evidence.

The runbook docs/preview-deployment.md covers separate free resources, Render
bootstrap/readiness settings, GitHub environment secrets/variables, enabling the
job, report review and safe application rollback/forward repair. .env.preview.example
contains placeholders, and all local .env.* copies except examples are ignored.
Host guards depend on accurately supplied live identities; they do not attest
resource ownership/data provenance. No provider account, service, credential,
GitHub setting, preview/live database or main branch was changed. No push/commit,
hosted deploy, real provider call or real recipient message was made.

Verification: Windows/Node 24.12.0, source base 7e2d9ef plus working-tree changes:
- Final fast suite: 81/81 passed in 2.946 seconds, zero failures/skips/todos/
  cancellations (reports/unit.xml/.json). Six new cases cover isolation, service
  hook pinning, minimal release identity, no credential submission before matching
  identity, failing privacy/tenant assertions and redacted successful smoke reports.
  HTTP/provider responses are synthetic here; no hosted smoke success is claimed.
- Preview fixture SQL applied against the full migration journal in disposable
  PostgreSQL 17: final 2/2 passed in 19.058 seconds with no failures/skips/todos/
  cancellations, reports/preview-fixtures-final.xml/.json. Independently seeded
  cases verify current private-fleet/tenant relationships and atomic duplicate
  rejection without credential overwrite. Hosted Neon transport/preparation remains
  unverified. Earlier passing fixture evidence remains reports/preview-fixtures.xml.
- Lint, TypeScript and final Bun build passed (958 modules, 3.59 MB).
- Two approved local Docker builds failed before compiling application code: Docker
  Desktop cannot resolve production.cloudfront.docker.com when pulling the pinned
  Bun base images. The network-isolated container boot check therefore did not run.
  reports/preview-container.json records blocked status; container verification is
  not treated as passing and must not be bypassed in CI.

Outstanding gates: user dashboard setup with actual free quotas, full remote CI,
container startup, Render/Neon/Valkey/proxy behavior, deployed commit/smoke evidence,
rollback/restore rehearsal, provider sandbox and full frontend/worker journeys.
Render Free sleep/SMTP constraints are documented from official docs; this preview
is not a production-availability or million-user capacity claim. Completion remains
8.5/10 as a planning estimate. Production readiness and hosted preview readiness
remain unverified until the missing gates pass.


## 2026-11-06 — Dedicated preview branch

The user selected their existing isotrack-preview-branch for preview deployments,
replacing the earlier dev-deployment plan. It was one commit behind dev and was
fast-forwarded from 7e2d9ef to ed9840d without creating a merge commit. Branch policy
changes are now working-tree changes on preview: CI includes main/dev/preview,
but the preview job, no-cancel release behavior and CLI deployment guard target
only refs/heads/isotrack-preview-branch. The runbook now separates development,
preview and unchanged main/live deployment roles.

Seven targeted release-helper tests pass (0 failures/skips/todos/cancellations),
including explicit denial of dev/main/PR/tag refs. No runtime/database change
requires another integration run for this branch-policy edit. Before enabling
the repository deploy flag, commit this policy and bring it back into dev so its
older workflow does not still request a dev deployment; GitHub environment rules
must allow only preview. No commit, push, remote branch creation, main change or
hosted deployment was performed. Existing container DNS/hosted setup gates and
8.5/10 planning estimate remain unchanged.

## 2026-11-06 — Preview branch and Render-owned deployment correction

Source base ed9840d plus working-tree changes. Preview preparation now runs only
on isotrack-preview-branch; final checks require it to pass before Render's
After CI Checks Pass deployment. Missing preparation switch fails closed.
Removed deployment hooks and separated hosted verification from commit CI to
avoid a Render/check dependency cycle. Main and dev retain normal CI.

User-provided Neon metadata confirms copied application tables and zero migration
records. A read-only baseline guard rejects missing/empty history on copied schemas
before migration writes. Recommended resolution is a new empty database within the
existing preview branch, preserving the copied database. No hosted changes made.

Verification: 81/81 fast tests passed in 8.572 seconds; five preview fixture/baseline
integration tests passed against disposable PostgreSQL 17 in 19.563 seconds, with
zero failures, skips, cancellations or todos. Reports: unit.xml/.json and
preview-render-auto.xml. Lint and TypeScript passed. Integration cases exercise
fresh database acceptance and migrated, missing-ledger and empty-ledger states
without inventing history or changing fixture accounts on rejection.

Hosted preparation/deployment/smoke, full remote CI, Docker startup (previously
blocked by image-pull DNS), provider journeys and rollback remain unverified.
Completion remains 8.5/10 as a planning estimate, not production certification.

## 2026-11-06 — Hosted preview smoke failure

Target: https://isotrack-backend-preview.onrender.com, expected release
2775e05975faf9deb1f1d9ddc252f66646823862. Used private ignored .env.preview;
no secret values, access tokens or response bodies retained in diagnostic output.
Switched clean dev checkout to preview. Preview still contained committed conflict
markers in five tooling/documentation files; resolved locally with the agreed
preparation-only flow. YAML parsing, lint and six helper tests passed. Not committed
or pushed; main/live untouched.

Hosted diagnostic observed release/readiness/liveness 200, anonymous shipment 401,
public tracking 200, fixture owner login 200, then owner shipment detail 500.
Smoke failed; remaining actor/history/isolation/body/rate-limit checks did not run.
The public tracking privacy assertion passed before login. Initial connection
attempts were transiently unsuccessful; later requests reached the exact expected
release. reports/preview-smoke.json records the failed primary run. Root cause
requires corresponding Render logs; no hosted schema or application fix attempted.
Completion remains 8.5/10; preview functional verification is failed/incomplete.
