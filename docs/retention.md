# Retention and bounded cleanup

Apply migration 0015 before running the updated backend. Automatic cleanup defaults
to disabled (`RETENTION_ENABLED=false`). Main and the existing live deployment are
not part of this rollout. Use the development branch and an isolated preview database.

## Agreed policy

The project owner approved these starting periods on 2026-11-05. Retention depends
on purpose; these are product defaults, not universal legal periods. See the
[ICO storage-limitation guidance](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/data-protection-principles/a-guide-to-the-data-protection-principles/storage-limitation/)
for the general principle of defining justified retention schedules.

| Task              | Eligible data                                                       | Preserved                                                                            |
| ----------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| sessions          | Expired more than 7 days ago                                        | Unexpired and recently expired sessions                                              |
| idempotency       | Payloads older than 30 days, with expired keys and no current lease | Permanent hashed tombstones; pending/missing/reviewed payments and guarded checkouts |
| outbox            | Delivered/skipped work completed over 30 days ago                   | Pending, processing and dead-letter notifications                                    |
| account_actions   | Expired over 7 days ago, not processing                             | Current actions and processing email leases                                          |
| account_limits    | Windows over 2 days old, with no future hold                        | Current budgets and future next_at holds                                             |
| delivery_expired  | Unconsumed proofs expired over 7 days ago, not processing           | Current proofs and processing leases                                                 |
| delivery_consumed | Consumed proofs older than 90 days, not processing                  | Recent delivery receipts                                                             |
| invitations       | Unaccepted invitations expired over 30 days ago                     | Accepted invitation evidence and current invitations                                 |
| notifications     | Read, sent notifications created over 90 days ago                   | Unread/recent items and unresolved outbox deduplication records                      |
| shipment_gps      | Current location of a shipment closed over 30 days ago              | Active shipments, unreceived returns and payment-held shipments                      |
| event_gps         | Event-location fields for the same closed shipments                 | Event IDs, messages, statuses and timestamps                                         |

Read-notification age is measured from creation, not the time it was marked read;
the current schema has no read timestamp. GPS uses actual_delivery for delivered
shipments, updated_at for cancelled shipments, and returned_at for received failed
returns. Missing terminal clocks fail closed. GPS scrubbing never resets workflow
versions or the retention clock. Pending payments, payment review, or unresolved
received-money reviews hold GPS retention. Late disputes after deletion cannot
recover erased coordinates; broader dispute/hold policy remains future work.

Shipment rows, addresses, shipment-exception notes, accepted invitations, account
profiles, payments, receipts and financial audit records are not deleted. Driver
profile location, application logs and backups have separate lifecycle requirements;
this is not account deletion, tenant offboarding or a claim of complete anonymisation.

## Operate

Against an explicitly selected isolated database, after applying migrations:

```sh
bun run retention:status
bun run retention:preview
bun run retention:run
```

Status returns task checkpoints and ages. Preview is read-only and reports at most
500 eligible rows per task plus hasMore; it does not count whole tables or reveal
record IDs, contact details, tokens, payloads or coordinates. `retention:run` is an
explicit one-cycle mutation command, even if the automatic scheduler is disabled.
It exits unsuccessfully when any task fails. Do not execute it against the existing
live database as part of development. Preview first, inspect the policy, and retain
appropriate recovery material before enabling a deployment's cleanup.

Set RETENTION_ENABLED=true only on the new preview/deployment when ready. The API
runs one cycle at startup and every 15 minutes. Each of the eleven tasks handles
at most 500 rows per cycle, then yields; there is no unlimited drain loop. Multiple
replicas coordinate each task using a transaction-scoped try-advisory lock and
SKIP LOCKED row selection. A busy task yields immediately. Old manual cleanup
commands also use row locks, but retain their historical 5,000-row batch sizes;
prefer the new operator command and avoid scheduling both systems separately.

Each successful batch and its retention_runs checkpoint commit in the same SQL
statement. A checkpoint-write failure rolls back data changes. Missing checkpoint
configuration prevents mutation and is reported as an error. Empty successful
batches still advance checkpoints. Lost acknowledgements can produce an error even
when the batch committed; inspecting the checkpoint and rerunning is safe because
eligible deletes/scrubs are idempotent. Checkpoints describe the last batch, not an
immutable audit of every removed record.

The Neon adapter wraps each call in a transaction with a 1-second lock timeout,
5-second statement timeout and 8-second HTTP deadline. Those server settings are
local to the transaction. Independent tasks continue after failure; the next cycle
retries. A replica does not overlap its own cycles. Shutdown stops future tasks
and waits for the current batch within the service shutdown budget.

Migration 0015 adds the fixed-size checkpoint table and cleanup selection indexes.
Index creation is transactional; rehearse locks/build time/disk on representative
preview data before production rollout. No existing migration was edited.

## Observe and investigate

Private metrics include isotrack_retention_enabled, isotrack_retention_runs_total
(task/status), and isotrack_retention_affected_total (task). Labels are bounded to
known tasks/statuses. JSON logs contain task, outcome and affected count, never raw
exceptions, SQL, IDs or deleted contents. The durable retention backlog age is the
oldest last-success checkpoint, falling back to migration creation time for tasks
that have never succeeded. Checkpoint records remain present even with no eligible
cleanup work; the age is a scheduling signal, not the age of all expired data.

IsoTrackRetentionOverdue warns when an enabled deployment's oldest checkpoint is
over two hours old for ten minutes. It is suppressed while automatic cleanup is
disabled. IsoTrackRetentionFailures warns after a failed-batch signal persists for
two minutes. Check retention:status, schema version, database availability/deadlines
and repeated full batches. If lastAffected repeatedly equals 500, investigate the
arrival/cleanup rate; a fresh checkpoint alone does not prove the backlog is drained.
Do not increase deletion scope or remove payment/custody safeguards to clear an alert.

Tests use the complete migration journal and disposable PostgreSQL. They cover
read-only preview, batch caps, repeat runs, active-data preservation, payment holds,
notification deduplication, GPS/audit preservation, checkpoint rollback, distributed
ownership, missing checkpoints and locked-row skipping. Fast tests cover runner
failure reporting, overlap and shutdown. Monitoring tests evaluate alert rules and
exercise real local alert delivery. Hosted Neon transport, production-scale cleanup
plans, operational holds, preview activation and remote CI remain separate evidence.

Executed evidence: all 14 final policy cases passed, with the 61-case related
regression run passing and earlier migration/restore cases also passing. The
readiness register preserves exact scope, counts and the initial monitoring-fixture
failure. Fast checks passed 69/69; lint, types and build passed. Remote CI is pending.
