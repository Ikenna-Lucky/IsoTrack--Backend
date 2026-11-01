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
| Private fleets | Invitation-only onboarding, single business membership, database constraints, cross-business denial tests | Planned |
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
