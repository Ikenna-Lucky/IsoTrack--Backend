# Durable notification delivery

> Current transport: [Outlook Microsoft Graph HTTPS](microsoft-graph-email.md). SMTP-specific setup below is superseded; historical SMTP test evidence is retained as history.

Shipment and payment changes now capture notification work in PostgreSQL. Redis
is a delivery transport; losing queued Redis data does not erase pending work.
The dispatcher and worker start with the API process. They need a running process
to make progress; free hosting that sleeps will delay delivery. No paid service is
introduced, and this change does not establish a production delivery SLA.

## Transaction boundary and recipients

Migration `0006_notification_outbox.sql` installs triggers on new shipment history
events and payment transitions into success. Capture shares the business write's
transaction. If outbox insertion fails, the shipment/payment change rolls back.
No interactive Neon transactions are required. Application shipment creation and
transitions already write history atomically. Direct status updates that bypass
shipment history are not a supported notification path.

Each event captures the shipment, original business/owner/customer identities,
tracking ID, status and amount. Channel-specific rows have deterministic IDs:

- Business owner and linked registered customer: an in-app notification for shipment
  creation/status changes and confirmed payments.
- Linked registered customer: email for assignment, pickup, delivery, failed
  delivery and confirmed payment.

There is no historical backfill or guest email delivery. SMS, driver alerts and
additional owner-email channels remain separate features. Existing business/driver
preference settings describe those other channels; this worker does not send them
or apply one business's preferences to another customer's account. Customer email
preference management remains future work; current shipment emails are operational
messages, not marketing. Provider quotas still constrain actual sending capacity.

Before delivery the worker rechecks the recipient's active account, current role
and shipment relationship against the captured business. Work is marked skipped
if access was lost. In-app insertion rechecks this inside its completion statement.
An email already being sent can finish after an account/permission change. SMTP
address ownership/email verification remains part of the outstanding identity work.

## Delivery and recovery

The non-overlapping dispatcher runs every five seconds and selects at most 100 due
rows. Only outbox IDs go into Redis. SHA-256 job IDs avoid reserved-character issues
and prevent duplicate queued jobs while that Redis job exists. Completed/failed
queue jobs are removed; durable state and retry history live in PostgreSQL.

The dispatcher checks a 1,000-job queue watermark before publication. This is a
soft admission bound, not a distributed hard limit: multiple dispatchers can race
and overshoot by their admitted batches. Worker concurrency is five per process.
Horizontal deployments need measured provider capacity and distributed budgets.

Workers atomically claim an outbox row with a random ownership token and a two-
minute lease. Only the current, unexpired owner can complete/fail it. Duplicate
queue deliveries cannot claim an active lease or already completed row. Expired
leases become eligible again. An exhausted expired lease becomes a dead letter.

Each row has a five-attempt database budget. Failures wait 5, 10, 20 and 40 seconds
before another attempt, plus polling/queue time. The fifth failure becomes `dead`.
Worker crashes consume an attempt; neither Redis loss nor a fresh job resets that
budget. Poison payloads also exhaust the budget. Provider error details are not
persisted in job failures or `last_error`; stable diagnostic codes avoid copying
recipient addresses or credentials into Redis and operational logs.

For in-app delivery, notification insertion and outbox completion are one SQL
statement. A deterministic notification primary key prevents duplicates. Completed
work stays completed even if a customer later deletes that notification.

SMTP delivery is **at least once**, not exactly once. If SMTP accepts a message and
the process dies before PostgreSQL records completion, recovery may send it again.
Emails carry a stable Message-ID, which does not guarantee mailbox deduplication.
The crash integration test intentionally observes two SMTP acceptances with that
same ID. Stronger external duplicate prevention needs a provider-supported
idempotency contract or a different product policy for ambiguous sends.

Neon operations have five-second fetch timeouts. Production SMTP requires TLS and
uses connection/greeting/socket timeouts. The two-minute lease is not a global
execution deadline; prolonged SMTP exchanges can exceed it and contribute to the
documented duplicate window. SIGTERM/SIGINT stops HTTP/socket admission and drains
the dispatcher/worker, with a 30-second process shutdown deadline. Forced shutdown
relies on durable lease recovery. The full deployed shutdown path is not yet
rehearsed; tests exercise runtime closure and an actual killed worker process.

## Operator commands

Run with Bun and the backend environment configured:

```text
npm run notifications:status
npm run notifications:replay -- <dead-outbox-id>
npm run notifications:purge
```

Status prints counts and oldest creation time by state. Inspect pending age, expired
leases and dead rows when investigating lag. Replay is an explicit operator action
for a dead row only; it resets that row's attempt budget and logs its ID. It cannot
replay delivered work. Investigate the cause and possible SMTP acceptance before
replay. Commands require trusted database credentials; no public replay API exists.
Central alert routing and a durable operator audit trail remain operational work.

Purge removes at most 5,000 delivered/skipped rows completed more than 30 days ago.
Pending, processing and dead records are retained. Schedule this command in the
deployment environment and measure table growth; scheduling is not configured here.
Foreign-key indexes support account/shipment deletion. Related outbox records are
deleted if their recipient or shipment is deleted; broader offboarding and legal
retention policy remain separate decisions. In-app history is not deleted by purge.

## Rollout

1. Pause writes and drain/inspect the legacy `notifications` queue using the old
   worker before cutover. Do not run the old fire-and-forget notification path and
   the new outbox worker together: they can send duplicates.
2. Stop old application/worker instances, back up the database and apply migrations
   through `npm run db:migrate` with Bun. Do not substitute `db:push`; schema push
   does not install the capture functions/triggers.
3. Deploy the new backend, which uses `notification-outbox-v1`. Keep its Redis and
   SMTP configuration. No new secrets are required. Verify capture, worker delivery,
   status and a safe retry in the target environment.
4. Configure cleanup scheduling, monitor lag/dead letters/provider quotas, and keep
   a process running when timely delivery is required.

This is a controlled cutover, not a zero-downtime mixed-version rollout. Historical
events are not reconstructed. Rolling back to the old application reintroduces its
non-durable path and can duplicate outbox work; prefer forward repair, with writes
paused while reconciling. No production migration or deployment was performed.

## Test boundaries

The integration suite uses actual PostgreSQL 17 migrations, Redis 7.4, BullMQ and a
loopback SMTP sink. It verifies transactional capture/rollback, duplicate payment
confirmation, duplicate queue publication, Redis publication timeout and queued
data loss, lease contention/fencing, bounded retries/dead-letter replay, disabled
and changed recipients, cleanup, and a child process killed after SMTP accepts.
Tests accelerate lease expiry/backoff by updating synthetic fixture timestamps;
real BullMQ lock/stalled recovery still executes. External Gmail delivery and
provider quotas are not simulated as verified compatibility.

The SQL transport in tests is a psql adapter; deployed Neon HTTP and Bun process
networking/shutdown, provider TLS behavior, remote CI and representative load remain
unverified. Fast tests check HTML escaping, configured links and stable identifiers.
CI retains validated JUnit/JSON reports through the existing runner.

Queue deduplication and removal behavior follow the installed BullMQ contracts;
see the official [job ID documentation](https://docs.bullmq.io/guide/jobs/job-ids)
and [idempotent job guidance](https://docs.bullmq.io/patterns/idempotent-jobs).
