# Backend delivery journey verification

`tests/delivery-journey.integration.mjs` starts the actual Bun `src/index.ts`
entrypoint. It exercises the assembled HTTP middleware/routes, Drizzle and Neon
HTTP driver, signed access tokens and persisted sessions, Redis request budgets,
Socket.IO tracking, SQL functions and recipient-code email processor.

## Scenarios

1. Register two businesses through HTTP. Deny direct driver registration, accept
   an owner-created invitation, log in as that driver, reject invitation reuse and
   joining a second fleet, and verify each business's driver directory.
2. Register businesses/customer and invite a driver. Create a shipment, replay the
   request, reject changed data under the same key, concurrently replay assignment,
   deny stale versions and unauthorized reads/writes, pick up and move the shipment
   through transit. Persist a real-time location and deliver it to its authorized
   owner; reject foreign subscriptions/location writes. Issue recipient proof,
   dispatch exactly one email through a local SMTP inbox, reject a wrong code,
   confirm delivery, replay it, and read the final state/history through all roles.
3. Repeat that complete journey with a database HTTP 503 injected **after** the
   confirmation statement commits. Verify the application returns 500, the durable
   delivery already exists, and retrying the same request returns its saved result
   without another event, consumed challenge or notification.

Fresh database reads establish durable outcomes rather than trusting responses.
The suite also verifies tracking privacy, plaintext-code absence from saved retry
records, redacted application events and actual Redis budget keys. Scenarios clear
only their uniquely created disposable services; accounts/memberships/shipments
are established through product APIs, not seeded straight into final states.

## Dependencies and boundaries

The fixture starts uniquely named PostgreSQL 17 and Redis 7 Docker containers with
ports published to loopback. It applies the real migration journal using the `pg`
driver and bound parameters. The Bun child receives a newly generated environment
and `--no-env-file`; it cannot load local/live `.env` credentials. Its fetch wrapper
rejects outbound HTTP except the local SQL adapter. No preview/live service or
database URL is accepted by the fixture.

Neon's remote HTTPS edge is replaced with a loopback HTTP adapter backed by real
PostgreSQL TCP queries and bound parameters. The application still uses its Neon
HTTP/Drizzle client and normal store; SQL, constraints, permissions, transaction
functions and results are not mocked. This does not establish actual Neon TLS,
network latency, connection limits or serverless behavior. The adapter is scoped
to these journey requests, not a general Neon protocol emulator.

Automatic notification workers remain disabled, matching the initial preview.
The test explicitly drains the production delivery-email processor into a real
local SMTP server, then reads the recipient's code from that inbox. This verifies
durable proof processing and SMTP, not scheduler startup, Gmail deliverability or
hosted worker availability. Stripe is disabled: no payment calls or payment
settlement claims are part of this journey. Browser/frontend wiring is not tested.

## Run

Requires Node 24.12, Bun 1.3.12, installed locked dependencies and Docker.
With Bun on PATH, run from the backend repository:

```sh
node --test --test-reporter=spec --test-reporter=junit --test-reporter-destination=stdout --test-reporter-destination=reports/delivery-journey.xml tests/delivery-journey.integration.mjs
```

Create `reports` first if this is a clean checkout. If Bun is supplied through npx
on Windows, set its executable for this terminal before the command:

```powershell
$env:BUN_EXECUTABLE = (& npx.cmd --yes bun -p 'process.execPath').Trim()
```

The standard `test:integration` runner discovers this file automatically. Existing
GitHub CI installs Bun and runs it in one of the three integration shards, retaining
its results in that shard's JUnit/JSON artifacts. No new hosted credentials, GitHub
secrets, paid services or allowed actions are required. A local passing result does
not establish that the new tests have executed remotely before their commit/push.

The fault adapter returns HTTP 503 rather than disconnecting the socket because
Bun can transparently retry a disconnected fetch. A socket-drop experiment's failed
expectation is preserved locally as `reports/delivery-journey-initial-failure.xml`;
it is not treated as passing evidence.
