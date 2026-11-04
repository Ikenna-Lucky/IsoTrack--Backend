# Backend tests

`npm run test:unit` and `npm run test:integration` now generate and validate JUnit
and JSON reports in `reports/`. They fail on missing/empty results, failures,
cancellations, skips or todos. CI uses these same commands. See `docs/ci.md` for
required checks, artifact details and current evidence.

Run `npm run test:unit` with Node 24.12.0 or the CI-pinned version.

Run `npm run test:integration` with Docker running. Database fixtures pull
`postgres:17-alpine`, create uniquely named temporary containers, and stop them
after the run. Those PostgreSQL containers publish no host ports; Redis and
HTTP/SMTP/socket/monitoring fixtures use ephemeral local ports as described below.
Fixtures use synthetic data and never read the application `.env` or connect to
the application database. Test passwords are deliberately non-secret and confined
to disposable services.

The ownership suite executes the production SQL authorization predicate against
PostgreSQL. It checks permitted reads, foreign reads, null assignments, rejected
writes with fresh verification, unknown roles and injection strings.

The suite also applies the actual application migrations in a separate schema and
tests invitation enrollment, atomic shipment history, Stripe payment confirmation
and revocable sessions. Selected Hono handlers run with real jose/Stripe signatures
and PostgreSQL through a psql adapter. Session tests cover replay, concurrent
rotation, logout/password races, deactivation/reactivation, ownership, expiry and
cleanup. Fast session tests cover origins, cookie attributes and storage failures.

This is not full application integration: deployed Neon HTTP, the complete auth
router's login/password flows, external provider calls, deployed worker/socket
networking, browser refresh coordination and ORM relation serialization remain
separate gates.
A passing SQL or handler test must not be presented as proof of those layers. See
docs/sessions.md for the strict refresh policy and migration requirements.

If a test process is forcibly terminated, Docker may retain its running container.
Inspect containers named `isotrack-access-test-*` before manually stopping the
specific abandoned test container. Do not remove unrelated containers.

The tracking suite separately creates an `isotrack-socket-test-*` PostgreSQL
container and an HTTP/Socket.IO server on a random loopback port. Real clients test
WebSocket and polling, active-session authentication, shipment participant access,
assigned-driver writes, reassignment, revocation, reconnect, transport/packet bounds
and credential changes. It uses the production handlers/options/SQL and real jose
signatures with a psql transport adapter. It does not prove deployed Neon/Bun
networking, frontend behavior or horizontal delivery. The application .env is not
read. The client dependency is test-only. See docs/tracking.md for the contract.

If forcibly interrupted, inspect the `isotrack-socket-test-*` prefix as well and
stop only the particular abandoned test container.

The outbox suite adds `isotrack-outbox-test-*` PostgreSQL and
`isotrack-outbox-redis-test-*` Redis containers, plus a local SMTP protocol sink.
It executes real BullMQ workers and intentionally kills a child worker after SMTP
acceptance, then starts a replacement to verify recovery and the duplicate-send
window. It also verifies rollback, Redis timeout/data loss, leases, retries,
dead-letter replay, recipient checks and cleanup. Synthetic timestamps accelerate
lease/backoff expiry; BullMQ stalled-job handling is real. No external email is
sent and application credentials are not loaded. See docs/notifications.md.

The report runner allows ten minutes for all integration files together and runs
at most two integration files concurrently. In-suite request races remain concurrent.
Docker must have capacity for their isolated services. If interrupted,
inspect only the exact test-container prefixes above before manual cleanup.

The idempotency suite creates `isotrack-idempotency-test-*` PostgreSQL and a loopback
HTTP Stripe fixture. It uses production command handlers/service/SQL, real JWT and
session checks and the official Stripe SDK. It covers concurrent/replayed/mismatched
keys, scope, transaction rollback, injected lost database acknowledgements, lease
fencing, retention/expiry, checkout parameter preservation and accepted-but-lost
provider responses across service instances. The fixture accounts for the SDK's
automatic first connection-reset retry. It does not contact Stripe or establish
provider sandbox compatibility; see docs/idempotency.md for boundaries and rollout.
Fast tests include canonicalization, validation, CORS and error boundaries.

The migration suite creates `isotrack-migration-test-*` PostgreSQL and runs the
production migration core with all checked-in SQL files. It covers fresh install,
existing-account upgrade, historical settings omission, atomic rollback,
concurrent plans, history tampering/gaps and a lost commit acknowledgement.
Temporary journals are isolated under the system temp directory and cleaned up.
The psql adapter verifies PostgreSQL semantics; actual Neon HTTP and the Bun CLI
entrypoint against a hosted database remain unverified. See docs/migrations.md.

The account-action suite creates `isotrack-identity-test-*` PostgreSQL, applies the
complete migration journal through the production runner, starts a real Hono HTTP
server and a local SMTP sink, and uses the actual socket peer adapter. It verifies
recovery/verification, bcrypt changes, signed JWT/session revocation, concurrent
tokens, PostgreSQL resend/peer limits, rollback on notice failure, SMTP exhaustion,
lease fencing, injected completion loss and cleanup. No application credentials
or external mail provider are used. See docs/account-recovery.md for boundaries.

The public-auth suite creates `isotrack-auth-test-*` PostgreSQL, applies the full
migration journal and starts independent loopback Hono servers sharing the same
database. A third server tests explicitly trusted proxy handling. It exercises
real bcrypt, SQL budgets, signup/profile atomicity, concurrent HTTP requests and
signed fixture sessions. No production credentials or hosted database are used.
See docs/auth-abuse-protection.md for policy, boundaries and rollout requirements.

The observability suite additionally uses `isotrack-monitor-*` disposable
PostgreSQL/Redis/Prometheus/Alertmanager resources. It exposes ephemeral local test
ports and a local-only synthetic alert receiver; the receiver listens on host
interfaces so containers can reach it through Docker's host gateway. No real
recipient or application credential is used. It checks schema/outage readiness,
private scrapes, indexed durable backlog values, production rule evaluation and
actual alert delivery/acknowledgement. The alert hold deliberately takes about a
minute. Temporary configurations, Docker network and containers are cleaned up.
The runner limits file concurrency to two and the full suite to fifteen minutes.
Cold image downloads need a working Docker registry connection. See
docs/observability.md for exact metric and deployed-verification limits.

The recovery suite creates two independent, unexposed PostgreSQL containers with
`isotrack-recovery-source-test-*` and `isotrack-recovery-target-test-*` names. It
backs up synthetic migrated data with actual pg_dump, removes the source, restores
with pg_restore and verifies content plus application database primitives. It also
rejects corruption and a populated target. Run `npm run recovery:drill` for focused
JUnit/JSON and timing evidence; these cases also run in the normal integration
suite. No application environment or external service is used. See docs/recovery.md
for scope, local time budget and remaining deployment recovery requirements.

The shipment-command suite uses `isotrack-shipment-command-test-*` PostgreSQL and
an ephemeral loopback HTTP server. It applies the complete production migration
chain and checks signed authentication, fleet access, workflow versions, command
replay, competing requests, lost commit acknowledgements and transactional outbox
rollback. It is discovered by the standard integration runner; no external
provider, application environment or frontend is used. See docs/shipment-commands.md.

The shipment-page suite creates `isotrack-shipment-page-test-*` PostgreSQL and an
ephemeral loopback HTTP server. It applies the migration journal and exercises
all-role traversal, privacy, scope/filter validation, live-list changes and exact
timestamp boundaries. A 10,000-row tied-timestamp batch checks deep seek plans;
actual EXPLAIN ANALYZE JSON is retained in reports/shipment-page-plan-*.json.
The standard unit/integration discovery includes these cases. See
docs/shipment-pagination.md for contract and workload limits.
