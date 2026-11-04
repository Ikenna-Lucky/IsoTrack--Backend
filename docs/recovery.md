# Database recovery drill

Run `npm run recovery:drill` from the backend with Node 24 and Docker available.
The PostgreSQL 17 image must be available locally or downloadable. No application
environment file, database URL, provider account or external recipient is used.
The same cases are automatically included in `npm run test:integration` and CI.

## Acceptance and evidence

This is a local logical-backup rehearsal, not a production backup scheduler.
It creates independent `isotrack-recovery-source-test-*` and
`isotrack-recovery-target-test-*` containers without publishing database ports.
The source is migrated using the production migration runner and checked-in SQL.
Synthetic users, private fleet membership, shipment history, payment receipt,
checkout guard, session, completed idempotency response and notification outbox
records exercise the recovered schema.

The drill creates a custom-format `pg_dump` archive, then commits a source record
after the backup and stops/removes the source container. The restored database
must match every public/drizzle table's row count and deterministic content hash.
The later source record must be absent. Migration history must require no repair.
It then checks bcrypt verification, the production active-session predicate,
saved idempotency response, an atomic shipment assignment and its notification
trigger, payment/receipt linkage, receipt uniqueness and credential-change session
invalidation. These are database/application primitives, not a full HTTP login,
Stripe reconciliation, SMTP delivery or deployed Bun journey.

Negative cases reject a truncated archive without leaving application tables and
refuse to overwrite a populated target. Restore uses `--single-transaction`,
`--exit-on-error`, `--no-owner` and `--no-privileges`; it does not use `--clean`.
The fixture has no concurrent clients. The empty-target check is a drill guard,
not permission to restore over a live application database.

Local acceptance requires recovery plus verification under 120 seconds for this
small fixture, complete content equality and no failed/skipped tests. The timer
starts immediately before restore and ends after the application checks; Docker
startup, migrations, backup creation, source shutdown and cleanup are excluded.
This budget is a regression check, not a promised production recovery time.
The local recovery point is the dump snapshot: all seeded records are retained,
and the deliberately later commit is lost. No elapsed-time production RPO is
claimed without backup scheduling and off-host retention evidence.

Reports are `reports/recovery.xml`, `recovery.json` and
`recovery-measurements.json`. Measurements include backup duration, archive size/
SHA-256, recovery duration, table counts/content hashes, environment and cleanup
status. JUnit plus the runner result determine success; measurements alone do
not override a failing test or cleanup. Full integration execution also writes
the measurements and retains its own integration report. CI uploads reports for
14 days; test evidence retention is not database-backup retention.

The archive stays in process memory, is bounded to 32 MiB for this fixture and is
discarded when the process exits. It is not exported into reports or committed.
Both containers are removed by cleanup. A failed backup/restore exits nonzero.
Do not adapt the in-memory fixture transport into a large-database backup job.

## Deployment recovery procedure and remaining gates

Before launch, agree production RPO (permitted lost work), RTO (time to restore
service), backup frequency, encrypted independent storage, retention, access and
an owner. Confirm actual hosting support and quotas within the zero-spend budget.
No provider retention/PITR capability is assumed. Database dumps do not preserve
cluster roles, TLS/domain configuration, application secrets or external assets.

For a real recovery:

1. Record incident time, selected backup identity and last known recoverable point.
   Stop write traffic, workers and reconciliation timers; preserve the old system
   and evidence. Account for actions that committed after the backup snapshot.
2. Verify backup integrity and provenance. Provision a separate empty destination
   with compatible PostgreSQL/extensions and a restricted recovery identity.
   Restore only trusted archives; restore executes database code from the backup.
3. Restore schema/data/history, establish the intended owners and grants, run
   `ANALYZE`, and verify content, foreign keys, receipt/idempotency invariants and
   migration history. Validate legacy fleet constraints explicitly: the historical
   NOT VALID fleet foreign key still needs reconciliation before release.
4. Keep external side effects paused. Restoring an older database can resurrect
   revoked sessions, consumed recovery tokens, pending emails and stale payment
   state. Establish a session/token invalidation policy, reconcile Stripe receipts/
   refunds and uncertain attempts against the provider, and review outbox replay
   before enabling workers. Already-sent email cannot be unsent by database restore.
5. Restore required config/secrets independently; verify login, tenant isolation,
   shipment changes, provider state and health/metrics against the candidate.
   Switch traffic only after checks and record achieved RPO/RTO. Monitor recovery
   and keep a documented route back while the old database remains preserved.

The actual hosted-provider restore, off-host encrypted backup, credentials recovery,
side-effect reconciliation, full application smoke checks, realistic data volumes
and traffic cutover remain unverified. A passing local drill closes none of those
deployment gates automatically.

The commands and snapshot limitations follow PostgreSQL 17's
[logical backup documentation](https://www.postgresql.org/docs/17/backup-dump.html)
and [pg_restore documentation](https://www.postgresql.org/docs/17/app-pgrestore.html),
checked 2026-11-04.
