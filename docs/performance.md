# Backend load baseline

This benchmark measures selected production HTTP handlers and SQL against an
isolated PostgreSQL 17 database. It does not establish full application capacity,
Neon HTTP transport performance, Bun performance or a supported user count.
Millions of registered accounts and simultaneous requests are different workloads.

## Reproduce

Use Node 24.12.0, installed locked development dependencies, and Docker:

```sh
npm run test:load -- smoke
npm run test:load -- baseline
```

The runner creates its own loopback PostgreSQL container, random disposable
credentials and synthetic JWT sessions. No application .env is imported, no target
URL or database URL is accepted, and no real providers or recipients are contacted.
It cleans up its own container after success or failure. Do not run competing heavy
benchmarks at the same time. Keep failed reports before rerunning the same profile;
reports/load-smoke.json and reports/load-baseline.json are overwritten by new runs.

PostgreSQL is limited to two CPU cores and 512 MiB RAM. The test-only pg driver uses
up to 16 TCP connections, five-second connection/statement deadlines and parameter
binding. Bulk fixture setup has a separate 90-second statement deadline and is
excluded from measurements. This avoids measuring docker-exec process startup as
SQL latency. Production continues using its existing Neon transport.

## Data, traffic and targets

The fixture applies the complete production migration journal and creates ten
business fleets, 30 accounts, 50,000 assigned shipments, 5,000 pending write fixtures
and 50,000 historical events. Timestamps span 30 days with ties. Production event
triggers run during seeding; outbox rows are durable, but no workers dispatch them.
SQL statistics are analyzed before measurement. This is a balanced tenant dataset,
not evidence for highly skewed tenants or millions of rows.

The deterministic operation mix is 70% shipment-list reads, 20% driver assignments
with immediate same-key replay, and 10% denied cross-business assignment attempts.
Reads rotate business/driver/customer roles across tenants and alternate first-page
and cursor positions after five pages. Every response checks current scope and expected
status; assignments must replay the identical snapshot. Lists contain 20 rows.
Each assignment operation makes two HTTP requests, so offered operations/s and HTTP
requests/s differ. At the intended mix, 20 operations/s means about 24 HTTP requests/s.

| Phase    | Offered operations/s | Duration   | Purpose                                |
| -------- | -------------------- | ---------- | -------------------------------------- |
| warmup   | 10                   | 5 seconds  | Establish connections and initial work |
| steady   | 20                   | 30 seconds | Repeatable initial baseline            |
| burst    | 100                  | 15 seconds | Five times the steady arrival rate     |
| recovery | 20                   | 15 seconds | Verify normal behavior after the burst |

The smoke profile runs 10 operations/s for five seconds; it verifies the harness,
not sustained capacity. Baseline offers 2,450 operations (about 2,940 HTTP requests).

Thresholds are defined in code before execution. Normal read/denial p95 must stay
at or below 500 ms; assignment plus replay p95 at or below 1,000 ms. Burst limits
are 1,500 ms and 2,500 ms respectively. Every phase requires zero failed operations,
zero dropped arrivals and complete arrival accounting. Each HTTP request has a
five-second deadline. These are engineering starting targets for this loopback
fixture, not published production SLOs. Do not raise limits just to obtain a pass.

Arrivals follow a fixed schedule. The generator allows at most 64 in-flight
operations and records drops instead of silently reducing offered load. Arrivals
more than two scheduling intervals late are dropped rather than sent in a catch-up
storm. Scheduling lag and drops can identify generator saturation too; a failed
load run does not by itself establish the backend's bottleneck. The generator and
API share one Node process, so their CPU/RSS/event-loop measurements are combined.
The burst tests a specified offered rate; it is not a search for maximum capacity
or proof of service behavior under arbitrary overload.

## Evidence and interpretation

JSON reports retain thresholds, workload, environment, timings (p50/p95/p99/max),
completed throughput, failures/drops, peak in-flight work, generator lag, process
CPU/RSS/event-loop delay, pool waiters, query plans with ANALYZE/BUFFERS, final
PostgreSQL statistics and an end-of-run Docker resource snapshot. PostgreSQL
counters include setup work; the Docker snapshot is not peak database utilization.
Local commit is null; CI adds GITHUB_SHA. Reports never include JWTs or database
credentials. Report checks also verify one shipment update, one event and one
saved idempotency response per assignment, with no changes to foreign fixtures.

A nonzero exit means setup, latency, arrival accounting, correctness or cleanup
failed. Read the failures and query plans before changing production code. A short
pass gives evidence only for that data/rate/duration/environment. Host resources,
transport latency, ingress, production middleware and provider costs can change it.

The manual `Backend load baseline` workflow runs on Ubuntu 24.04 with the same
profiles and uploads backend-load-results for 14 days, including failed runs. It
uses the existing allowed action tags, and adds no secrets. After the workflow is
merged into the default branch, open Actions > Backend load baseline > Run workflow,
choose the branch/profile, and inspect the report. It is deliberately separate
from the required Backend CI checks and does not run on every push or PR.

Next capacity work: actual staged Bun/Neon/ingress traffic, global middleware and
abuse budgets, larger/skewed datasets, long soak runs, sustained queue consumers,
GPS fan-out, pool exhaustion/dependency failures and measured recovery. Establish
hosted workload targets and costs before claiming production capacity.

## Executed baseline — 2026-11-05

Windows/Node 24.12.0 on an eight-logical-CPU, approximately 16 GiB host; PostgreSQL
limited to two CPUs/512 MiB. The complete baseline passed: 2,450 operations,
2,940 HTTP requests, zero failed operations and zero dropped arrivals across all
four phases. These are short loopback measurements, not internet response times.

| Phase    | Completed operations | Worst read-role p95     | Assignment + replay p95 |
| -------- | -------------------- | ----------------------- | ----------------------- |
| warmup   | 50                   | 13.3 ms (business only) | 42.3 ms                 |
| steady   | 600                  | 15.3 ms                 | 27.4 ms                 |
| burst    | 1,500                | 117.6 ms                | 133.2 ms                |
| recovery | 300                  | 23.4 ms                 | 21.1 ms                 |

Post-run integrity found exactly 490 assigned shipments, 490 new events and 490
saved command responses, with zero modified foreign shipments. Query-plan samples
used shipments_business_page_idx, shipments_driver_active_page_idx,
shipments_customer_page_idx and shipment_events_page_idx. Sample query execution
was 0.859/3.172/3.227 ms for business/driver/customer. These measurements do not
justify changing application indexes or queries, so no speculative tuning was made.

Observed peak combined API/generator RSS was 206,958,592 bytes; sampled peak pool
waiters was one and event-loop p99 was 34.9 ms. Evidence: reports/load-baseline.json.
The successful smoke run completed 50 operations without failures/drops. Its initial
attempt hit the request-oriented five-second timeout during bulk seeding; that
failed report is preserved as reports/load-smoke-seed-timeout.json. Setup now has
its own deadline without relaxing measured request deadlines or latency limits.
The local reports have commit=null. The new manual workflow has not been run on
GitHub. Hosted transport, longer runs, skewed data and maximum capacity remain open.

## Bounded hosted preview baseline — 2026-11-08

Manual command: `npm run test:load:hosted -- FULL_PREVIEW_RELEASE_SHA`.
Requires Node 24 and the existing ignored .env.preview. It accepts only the known
preview origin, applies resource-isolation guards and checks deployed environment
and exact SHA before authentication or synthetic writes. No provider credentials
are used, no payment endpoint is invoked, and no service settings are changed.
The original local benchmark remains unchanged and accepts no external URL.

This deliberately small profile offers warmup 0.5 operations/s for 10s, steady
1/s for 30s, burst 2/s for 15s and recovery 1/s for 20s, with at most four in flight.
Its ten-operation cycle is seven shipment reads (including one tenant denial),
two public tracking reads and one write operation. Each write creates/replays a
new synthetic shipment and cancels/replays it, making four HTTP requests. Four
serial real fixture logins are sampled separately, not a login-capacity benchmark.
Small phase sizes have mix rounding; inspect actual counts. No backlog is unbounded.
No requests use existing shipments for authorized state changes.

Predeclared targets: login p95 <=3000ms; read/tracking operation p95 <=2000ms;
write operation (four HTTP calls) p95 <=6000ms; no failed operations or dropped
arrivals. Request deadline is 10s. Server errors, 429, transport/timeouts or other
request failures stop further traffic; in-flight requests may finish. Later
phases are omitted after failures/drops. A failing latency result is not relabeled
as a pass. Shared application request budgets are not disabled or reset.

Reports/hosted-load-RUN_ID.json retains release, dataset size, actual request and
operation statistics, generator accounting, latency/error thresholds and created
shipment IDs. Future request records include sanitized route, UTC start and server
request ID where available; no response body, token or password is retained.
Read-only SQL samples database connection counts before/after phases, including
the observer; these are not peaks, connection-pool capacity or saturation evidence.
Render CPU/memory must be recorded separately from dashboard graphs. The user's
reported 0.15 CPU and 512MB are limits, not observed utilization.

Actual run d251e4d2-ad73-4bd2-a4c7-36d937a0a249 against preview release
e1601f41d7245ca4c350db3ed149e43d4b5264f3 FAILED. Dataset at start: six shipments,
two businesses, four users. There were 53 HTTP attempts, including setup, with two
10s GET timeouts during steady 1 operation/s. Warmup: 5/5 operations completed with
no failures/drops. Steady: 30 arrivals, 28 successful operations, two failures,
zero drops. Burst/recovery not run. Four-login p95 3021.9ms exceeded 3000ms.
Successful steady reads p95 907.7ms, tracking p95 1214.2ms, four-call writes p95
2545.5ms. Successful-only percentiles do not erase the failed requests.

Read-only follow-up reports/hosted-load-diagnosis.json confirms all four synthetic
shipments cancelled at version 1 with two events each, and health live/ready both
200. Comparing preview payments with the already restored baseline found only
updated_at/reconcile_after differences on one payment, not financial differences.
The initial full-row financial hash incorrectly counted normal reconciliation
scheduling as drift; the checker now selects durable financial/audit fields.
This correction does not resolve the two actual HTTP timeouts or the login target.
The failed report remains unchanged, and no second hosted load run was performed.

Two load-engine regression tests pass, formatting and ESLint pass. No application
runtime code changed or deployed. Need Render logs/request durations and actual
CPU/memory around Nov 8 15:19–15:21 Africa/Lagos to distinguish endpoint/dependency
latency from runner/network effects. Do not increase load until diagnosed. This
small run establishes neither a passing hosted baseline nor capacity for a
representative dataset, a free-tier ceiling or millions of users.

## Low-rate endpoint diagnosis — 2026-11-08

Run `npm run diagnose:preview -- FULL_PREVIEW_RELEASE_SHA` from the backend.
This separate manual probe reads .env.preview, requires the fixed preview origin,
resource isolation and exact release SHA, and uses one fixture owner login.
It compares /health/live, /health/ready and the authenticated preview-shipment
read: six requests each, sequentially, with 2s gaps and rotating endpoint order.
Each request keeps a 10s deadline; 429 or two timeouts stop further samples.
Release checks bracket sampling. No shipment/payment writes or provider calls.
Login does create a session and auth-budget records; if a refresh cookie is
returned the runner attempts logout with configured trusted Origin. No cookie
was returned in the successful deployed sample, so session revocation was not
attempted or verified. Credentials/tokens/cookies are not saved in the report.

Reports record UTC start time, headers and total duration, HTTP status, response
size and X-Request-Id if received. Match request IDs to structured request_completed
logs for server durationSeconds; a client timeout before headers has no server
request ID. Client duration includes the network, gateway, response transfer and
application. Public health/readiness samples are not independent resource metrics;
readiness can use its 5s cache. Six values per endpoint are descriptive, not a
reliable tail-latency distribution, sustained load or proof of capacity.

First attempt report hosted-diagnostics-49aa0d77-3d43-4d3e-b8fc-d2998b3f5241.json:
release check itself timed out at 10015ms, before login or sampling. This endpoint
does not query database/Redis. The failure is preserved and does not establish
cold start, gateway, local network or process availability as the root cause.

A fresh attempt kept the same deadline and completed all 18 samples, HTTP 200,
with valid expected payloads. Report hosted-diagnostics-3ee7f5ec-58c5-4856-ad39-76c89afe5244.json
checks the same e1601f41d7245ca4c350db3ed149e43d4b5264f3 preview release before/after.
Liveness 295–363ms (median 311); readiness 285–383ms (median 340); shipment
341–540ms (median 358). One fixture login took 2526ms. No database-only latency
pattern was established. Both attempts remain evidence: a passing second sample
does not cancel the original load failures or the failed first release probe.

Formatting and ESLint pass; the two existing percentile/fixed-arrival engine tests
pass. Production code and deployments unchanged. Next attribution work is a probe
from an independent network/runner and correlation with server request durations;
only then repeat bounded load without relaxing its targets. CPU/memory observations
are still unavailable on the user's plan. Hosted capacity gate remains open.

## Independent GitHub runner comparison

Workflow: .github/workflows/preview-diagnostics.yml, display name Preview latency
 diagnostics. It is disabled unless repository variable PREVIEW_DIAGNOSTICS_ENABLED
is exactly true. It runs only on isoTrack-dev-branch, with no PR trigger. Opted-in
pushes changing the workflow or diagnostic/config/load-engine scripts bootstrap
it without merging into main. workflow_dispatch is also defined, but the GitHub
browser Run workflow button normally requires the file on the default branch;
do not merge into main merely to expose that button.

Configure before the first push:

1. Repository Settings > Environments > New environment: preview-diagnostics.
   Restrict deployment branches to isoTrack-dev-branch. This environment stores
   diagnostics credentials; the job does not deploy an application.
2. Add environment secret PREVIEW_FIXTURE_PASSWORD, using the same private
   synthetic-account password already stored in the existing preview environment.
   It is not a JWT, database password, Stripe secret or newly generated password.
   Do not replace the existing fixture password or paste it into logs/chat.
3. Settings > Secrets and variables > Actions > Variables: add repository variables
   PREVIEW_DIAGNOSTICS_ENABLED=true and PREVIEW_DIAGNOSTICS_SHA equal to the full
   SHA currently returned by the deployed preview /health/release endpoint.
   That is the backend release being measured, not the dev commit containing
   these diagnostics. A mismatch stops before fixture login.
4. Commit the new workflow, scripts, tests and docs on dev and push dev. No merge
   into preview or main is needed. Open Actions and select the push run of Preview
   latency diagnostics. Normal Backend CI can run independently on the same push.
5. Inspect the five guard/engine tests and diagnostic step. Download the
   preview-latency-diagnostics-RUN_ID-ATTEMPT artifact; failed diagnostics are also
   uploaded. JSON includes runner=github-actions, harnessSha, expected/deployed
   release SHA, workflow run ID/attempt, statuses, timings and request IDs.
6. Set PREVIEW_DIAGNOSTICS_ENABLED=false after the comparison to stop subsequent
   diagnostic-file pushes from probing the hosted preview. Keep reports locally
   if evidence is needed beyond the 14-day artifact retention window.

The new environment does not widen the existing preview environment's branch rules.
Only the synthetic password is supplied to the HTTP step; DB/Redis/JWT/Stripe
credentials and .env files are unnecessary. The destination is pinned in code,
the job is dev-only and opt-in, and no code runs with credentials on PR events.
No deploy hook, database migration, fixture preparation or Render change exists.
Existing allowed action versions are reused; no new action allowance is needed.

Install is frozen; Ubuntu 24.04/Node 24.12.0/Bun 1.3.12 match the project tooling.
Runs are serialized, not automatically cancelled. Reports from failed attempts
are preserved; use a rerun of the existing push run if available, and do not
silently replace a failed result. Changing the expected SHA cannot revive an old
execution already started; use a fresh run after configuration/release changes.

Comparison: keep the deployed SHA and probe profile identical to a local run.
Compare endpoint ranges/statuses, not only six-sample p95. Correlate received
X-Request-Id with server request_completed.durationSeconds where available.
An absent timeout request ID cannot be correlated solely from the client report.
Two different network locations narrow attribution but do not prove cause.
The independent job is implemented and locally checked; remote execution and
comparison remain pending until the configured dev push actually runs.
