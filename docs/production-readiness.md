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
| Test and CI foundation | Reproducible build, lint, type checks, unit tests, real database/Redis integration and retained CI reports | Initial GitHub workflow added; not executed remotely; lint and integration gates outstanding |
| Response privacy | Shipment and analytics relations select approved contact fields; real API regression tests cover all roles | Query projection implemented; integration unverified |
| Private fleets | Invitation-only onboarding, single business membership, database constraints, cross-business denial tests | New/existing driver enrollment and fleet constraints implemented; existing-driver handler and database tests pass; abuse controls, full JWT/HTTP and legacy reconciliation evidence outstanding |
| Shipment authorization | Every read/write verifies ownership or assignment; denied writes leave data unchanged | Detail lookup now requires actor scope; PostgreSQL predicate tests passed; HTTP, write-race and fleet isolation verification outstanding |
| Sessions | Revocation, refresh reuse detection, concurrent refresh policy, password recovery and verification | Planned |
| Shipment correctness | Atomic events, conditional transitions, retry safety, assignment races, delivery proof and returns | Planned |
| Payments | Public signed callbacks, amount/currency checks, idempotency, reconciliation, refunds and sandbox evidence | Existing webhook blocked by auth; release blocker |
| Tracking | Authenticated assigned-driver writes, scoped subscriptions, revocation, reconnect and stale-location policy | Missing; release blocker |
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
