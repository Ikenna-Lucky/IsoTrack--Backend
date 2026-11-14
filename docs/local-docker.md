# Local Docker development

Run the API and frontend on the host, with PostgreSQL 17 and Redis 7 in Docker
Desktop. These are dedicated local services, not a connection to Neon. Both ports
bind only to 127.0.0.1: PostgreSQL 15432 and Redis 16379. Named volumes preserve
data when containers stop or are recreated. No hosted data is copied.

From the backend repository on isoTrack-dev-branch:

```powershell
bun install --frozen-lockfile
bun run local:setup
bun run local:up
bun run db:migrate
bun run dev
```

The setup generates independent local secrets and writes ignored `.env` and
`.env.docker.local` files without printing credentials. It refuses to overwrite a
non-loopback DATABASE_URL. Stop an existing API first; its in-memory environment
does not necessarily change when a file changes. Shell environment overrides
must also be removed if they point elsewhere. Do not copy preview/live secrets.

On subsequent starts, use local:up followed by dev; rerun db:migrate after pulling
new migrations. local:setup is not needed on every start. It preserves existing
local credentials on reruns. Keep `.env.docker.local` with its associated volumes;
regenerating passwords will not change an initialized PostgreSQL volume's password.

Open http://localhost:8000/health/ready; expect status ready. This probe checks
database readiness; protected API smoke tests also exercise the local Redis budget.
Use `bun run local:status` to check both containers, and `bun run local:stop` to
stop them without deleting data. Ctrl+C stops the API separately. Do not use
`docker compose down -v` unless deliberately discarding all local development data.

Frontend `.env.local` must contain:

```dotenv
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_API_URL=http://localhost:8000
NEXT_PUBLIC_WS_URL=http://localhost:8000
```

Then run npm run dev in the frontend repository and open
http://localhost:3000/register. Register a business account to view /business.
Accounts from Neon do not exist in this independent database. The legacy db:seed
script is not part of this setup; it predates current fleet/proof constraints.

## Adapter and feature boundaries

DATABASE_DRIVER defaults to neon. Preview/live retain Neon HTTP; local:setup
selects postgres. The PostgreSQL adapter refuses non-loopback hosts, production
NODE_ENV and non-local DEPLOYMENT_ENV. Both raw SQL stores and Drizzle use the
same selected connection. Migrations and retention transactions use one checked-out
PostgreSQL client per transaction; cancellation discards its connection.

Local email workers, Stripe and automatic retention start disabled. Ordinary
dashboard reads and account registration/login work. Delivery-code email, account
recovery email and Stripe journeys require a separately configured local mail
delivery/sandbox setup; no fake payment or delivery-proof bypass is supplied.

The Docker adapter integration test uses a separate disposable container to check
all migrations, repeat migration runs, rollback, parameterized queries and cancelled
transaction recovery. Existing journey tests explicitly select Neon with their
loopback HTTP test transport so developer .env choices cannot change that evidence.
Neither test proves a new hosted deployment; no hosted resources are modified.

## Verification on 11 November 2026

- Both persistent local containers are healthy; all 18 checked-in migrations
  applied to the new Docker database.
- The running API reports ready. Local-only HTTP smoke checks passed registration,
  refresh-cookie rotation, business profile/analytics, cursor shipment/fleet/
  notification reads and a business preference update. A separately named local
  smoke-test business was created for these checks, not a shared login account.
- TypeScript, lint and the Bun build passed. All 92 fast tests passed.
- A focused run of database-transport.integration.mjs and
  delivery-journey.integration.mjs passed all four tests, without skips or todos.
- The broader unsharded integration run exceeded its 15-minute runner limit and
  is **incomplete**, not a passing suite. The failed/incomplete report is retained
  at reports/integration.json; completed checks before interruption reported no
  assertion failure. Use the documented CI shards for a complete release regression
  run; this local environment setup does not certify a hosted release.
