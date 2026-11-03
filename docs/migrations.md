# Database migrations

Run `bun run db:migrate` with DATABASE_URL set for the intended database. Use a
dedicated migration job and stop older write-serving instances when a release
changes contracts. Never run db:push as a substitute: it omits SQL triggers and
other migration-only behavior. No migration is run by API startup.

The runner reads the checked-in Drizzle journal and SHA-256 file hashes. It keeps
the existing `drizzle.__drizzle_migrations` table format. It checks every recorded
hash/timestamp, rejects unknown or duplicate records and unexpected gaps, and
applies missing migrations in journal order. Applied files must remain immutable.
The historical 0001 settings migration has a timestamp earlier than 0000; it is
the sole allowed gap and is safely reapplied when absent, using its original
ADD COLUMN IF NOT EXISTS statements. No historical file or timestamp was changed.

Pending SQL and its history entries execute in one PostgreSQL transaction. A
transaction-scoped advisory lock serializes cooperating runners; the history is
checked again after acquiring it. If another runner changed history, the waiting
runner fails without applying its stale plan. Rerun it to obtain a fresh plan.
Do not mix the old Drizzle migrator, schema-push commands or manual DDL with this
runner: they do not share its coordination protocol.

The production adapter uses the installed Neon driver's non-interactive
transaction API ([official driver documentation](https://github.com/neondatabase/serverless/blob/main/CONFIG.md#transaction-function)).
Each migration file is executed as a PL/pgSQL block, preserving function bodies
and supporting historical files with multiple statements but no breakpoints.
Only transactional SQL belongs in this runner. CREATE INDEX CONCURRENTLY and
similar nontransactional operations need a separately designed rollout. Large
backfills must be bounded and staged separately from schema installation.

Lock waits are limited to ten seconds, individual statements to ninety seconds,
and each HTTP request to two minutes. A client timeout is an unknown outcome:
the server may have committed. Inspect the durable history and rerun with the
same release; do not delete ledger entries or assume that a timeout rolled back.
The runner logs no connection strings or raw driver errors. For diagnosis, use
restricted database-side logs and inspect hash/created_at in the migration ledger.
Unknown/changed history requires investigation against the deployed artifact;
never update hashes just to bypass validation. Previously partial deployments
from the old runner may require reviewed reconciliation before proceeding.

Before deployment, take and verify an appropriate backup, rehearse the supported
upgrade on a copy, and coordinate application compatibility. Rollback of a failed
pending transaction is covered here; reverting a successfully committed release,
backup recovery, and destructive schema changes need their own release plan.
The existing legacy fleet foreign key remains NOT VALID pending reconciliation.

## Local evidence

The migration suite runs the production runner core against disposable PostgreSQL
17 through a psql adapter. It covers all eight actual migration files, reruns,
upgrade from the initial schema with an existing account, historical settings
omission, failure after pending DDL with full batch rollback, altered/unknown/
duplicate/gapped history, synchronized concurrent plans and injected loss of a
successful commit acknowledgement. It does not load application credentials or
contact an application database. The API entrypoint and actual hosted Neon HTTP
transport are not exercised; deployed Bun/Neon verification and a live upgrade
rehearsal remain release gates. CI discovers this suite automatically.
