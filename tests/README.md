# Backend tests

Run `npm run test:unit` with Node 24.12.0 or the CI-pinned version.

Run `npm run test:integration` with Docker running. The integration suite pulls
`postgres:17-alpine`, creates a uniquely named temporary container, and stops it
after the run. It publishes no host ports, uses synthetic data, and never reads
the application `.env` or connects to the application database. The test password
is deliberately non-secret and confined to that disposable container.

The ownership suite executes the production SQL authorization predicate against
PostgreSQL. It checks permitted reads, foreign reads, null assignments, rejected
writes with fresh verification, unknown roles and injection strings.

This is not full application integration: its minimal fixture schema does not
apply the project's migrations or exercise Hono routing, JWT middleware, payment
providers, queue workers or ORM relation serialization. Those require separate
suites. A passing predicate test must not be presented as proof of those layers.

If a test process is forcibly terminated, Docker may retain its running container.
Inspect containers named `isotrack-access-test-*` before manually stopping the
specific abandoned test container. Do not remove unrelated containers.
