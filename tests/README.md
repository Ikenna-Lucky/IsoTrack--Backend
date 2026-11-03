# Backend tests

`npm run test:unit` and `npm run test:integration` now generate and validate JUnit
and JSON reports in `reports/`. They fail on missing/empty results, failures,
cancellations, skips or todos. CI uses these same commands. See `docs/ci.md` for
required checks, artifact details and current evidence.

Run `npm run test:unit` with Node 24.12.0 or the CI-pinned version.

Run `npm run test:integration` with Docker running. The integration suite pulls
`postgres:17-alpine`, creates a uniquely named temporary container, and stops it
after the run. It publishes no host ports, uses synthetic data, and never reads
the application `.env` or connects to the application database. The test password
is deliberately non-secret and confined to that disposable container.

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
router's login/password flows, provider network calls, queue workers, Socket.IO,
browser refresh coordination and ORM relation serialization remain separate gates.
A passing SQL or handler test must not be presented as proof of those layers. See
docs/sessions.md for the strict refresh policy and migration requirements.

If a test process is forcibly terminated, Docker may retain its running container.
Inspect containers named `isotrack-access-test-*` before manually stopping the
specific abandoned test container. Do not remove unrelated containers.
