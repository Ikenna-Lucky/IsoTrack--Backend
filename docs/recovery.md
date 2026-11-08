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

## Hosted preview rehearsal preparation — 2026-11-08

Status: planned; no hosted backup or restore executed. Source is the isolated
preview database. Destination must be a new empty recovery-only database on a separate Neon branch or project,
with matching PostgreSQL major version and no Render service or application
workers attached. Never select the production database or restore into preview.
Direct/unpooled TLS connection strings belong only in ignored
.env.recovery-hosted, under RECOVERY_SOURCE_DATABASE_URL and
RECOVERY_TARGET_DATABASE_URL. No provider secret belongs in the evidence report.

Before executing: verify source identity against the private preview configuration,
verify target host differs from both preview and live hosts, verify PostgreSQL
versions and an empty target, and bound backup size/runtime to the small portfolio
fixture. Abort on unexpected application tables. Never use --clean or silently
replace an existing target. The existing recovery:drill command remains local-only;
these URLs must not be passed to that fixture suite.

Hosted acceptance: custom-format archive with checksum/size and snapshot identity;
consistent snapshot comparison for all public/drizzle tables; restored migration
history, foreign keys and payment receipt/refund invariants; app checks with outbound
email/payment/reconciliation/retention disabled and isolated Redis if required.
Measure backup, restore and validation separately. Keep recovered credentials,
sessions and pending side effects isolated; no traffic cutover is part of this
exercise. Do not mutate restored rows before content equality is verified.

A successful rehearsal establishes recovery from this archive and dataset only.
It does not establish scheduled backups, encrypted independent retention,
provider point-in-time recovery, live payment reconciliation or production RPO/RTO.

## Hosted operator command

Run `node scripts/hosted-recovery.mjs check` for read-only isolation and empty-target
checks. Run `node scripts/hosted-recovery.mjs restore` for the explicitly authorized
rehearsal. It reads only `.env.recovery-hosted` and `.env.preview`; never pass a URL
as a command-line argument. PostgreSQL 17 native tools must be installed; override
their directory with `RECOVERY_PG_BIN` if necessary. The target database name must
be `isotrack_recovery`, on a different Neon endpoint from preview and live.

The source stays in a read-only repeatable-read transaction while an exported
snapshot is shared with pg_dump. Sorted row-content hashes and counts therefore
refer to the same snapshot as the archive, even if preview receives later writes.
The archive is bounded to 32 MiB for this portfolio drill. Native tools have time
limits, and restore uses a single transaction without --clean. The destination
must have no other clients; do not attach a service or use it during the drill.

Archives are saved as AES-256-GCM ciphertext under ignored `.verification/`, with
a separate per-run key file in that directory. Restore reads and authenticates
the saved ciphertext and checks its plaintext checksum before using it. Keeping
the key beside the archive is local drill convenience, not independent secure
backup storage. Protect both files; do not commit or upload either. A new run does
not overwrite prior archives/reports and refuses a populated destination.

Each run writes `reports/hosted-recovery-RUN_ID.json`, including failure stage,
table counts/hashes, constraint and migration checks, archive identity and measured
durations. Provider errors and record values are deliberately not printed.
Validation checks foreign-key rows even for NOT VALID constraints and verifies
the restored preview owner's password hash with the private fixture password.
No HTTP login, workers, Stripe request, SMTP delivery, failover or DNS switch is
performed by this command. Restored sessions/tokens/outbox rows remain isolated;
they must be reviewed before any later traffic cutover.

## Hosted result — 2026-11-08

Scoped snapshot recovery passed for 19 preview tables, 95 constraint definitions,
24 foreign-key row checks and 16 migrations. Restored owner credential verifies;
receipt/refund consistency checks pass. Backup took 33.037s and restore 54.456s.
Read-only follow-up validation took 29.104s after checker diagnosis; no uninterrupted
RTO claim. See production-readiness.md for report identities, failed attempts,
CRLF journal diagnosis and scope limits. One historical fleet FK remains NOT VALID
in both databases, with zero observed row violations. No normal service is attached
to the restored database. Keep it isolated; the populated-target guard now refuses
another restore. Use a newly provisioned empty destination for any future rehearsal.
