# Backend observability

The backend writes JSON events, exposes bounded Prometheus metrics, and separates
process health from the ability to accept durable work. These controls help detect
and diagnose failures; they do not establish an availability or capacity claim.
No production monitor or external notification destination was deployed.

## Rollout and configuration

Apply the full migration journal through `0010_operational_indexes` before
starting this version. Its two partial indexes support dead account email and
unresolved payment review probes. Ordinary transactional index creation takes
table locks: rehearse lock duration on representative data and schedule the
cutover. Earlier migrations and their hashes are unchanged.

`METRICS_TOKEN` is an optional independent secret: 32–128 URL-safe letters,
digits, hyphens or underscores. Blank disables `/metrics` with 404. A configured
endpoint requires `Authorization: Bearer TOKEN`; session/JWT credentials do not
grant scraper access. Never put the token in a URL or Prometheus labels.

For local monitoring, generate an ignored token file from the backend directory:

```sh
node --input-type=module -e "import {randomBytes} from 'node:crypto'; import {writeFileSync} from 'node:fs'; writeFileSync('monitoring/metrics-token.txt',randomBytes(32).toString('base64url'));"
```

Copy its contents into the backend `.env` as `METRICS_TOKEN`, then restart the API.
The file and `.env` must not be committed. Start the optional local monitors:

```sh
docker compose -f monitoring/compose.yml up -d
```

Prometheus is on `http://localhost:9090`, Alertmanager on `http://localhost:9093`.
Both are bound to loopback. The API target defaults to
`host.docker.internal:8000`; adjust it for your topology. Docker consumes the
token through a secret file. Prometheus stores up to seven days/512 MB locally;
allow additional disk/RAM for the services themselves. These are free,
open-source tools, not a promise that free hosting can run them continuously.

Images are pinned to Prometheus 3.13.5 (the supported 3.13 LTS line) and
Alertmanager 0.34.2, checked against official release metadata on 2026-11-04.
The configuration and tests use the project's Quay registry after Docker Hub
download failures on the development machine. Review patches before upgrades;
see the [Prometheus support policy](https://prometheus.io/docs/introduction/release-cycle/).

The shipped Alertmanager receiver is deliberately **unconfigured**. Alerts can
be inspected locally, but it sends no email, Slack message or page. Before a
release, the maintainer must select a private destination, configure credentials,
name a responder and coverage hours, and drill delivery/acknowledgement. Do not
expose either monitoring UI publicly. Remote scrapes require HTTPS and network
restrictions as well as the token. Rotate the API token and scraper secret
together; restart/reload the affected processes and confirm scrapes recover.

## Health contracts

| Endpoint            | Meaning                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| `GET /health`       | Compatibility liveness alias; process is responding.                                             |
| `GET /health/live`  | Liveness only; never calls external dependencies.                                                |
| `GET /health/ready` | 200 when the required database schema can be queried; 503 on database failure or shutdown drain. |
| `GET /metrics`      | Private Prometheus text exposition; 401 for a bad token, 404 when disabled.                      |

Readiness performs a small PostgreSQL query resolving required tables/columns.
It does not assert that every query, migration index, provider or user journey is
healthy. Public responses contain no dependency addresses, errors or credentials.
Checks share in-flight work, cache for five seconds, and have a 1.5-second
deadline. PostgreSQL fetches receive an abort signal; the dedicated Redis probe
has a one-second connect/command timeout and no offline command queue.

Redis failure is a degradation metric, rather than a reason to remove every API
replica from traffic: shipment writes and notification capture are durable in
PostgreSQL. Existing dispatchers retry/rebuild delivery when Redis recovers.
Stripe and Gmail are not called by health probes. Their failures surface through
reconciliation, background failure events and durable backlog age. Point a
restart probe at **liveness**, and a load-balancer probe at **readiness**; using
dependency readiness for restarts can cause a restart storm during an outage.
Shutdown marks readiness false before draining sockets/workers.

## Logs and correlation

Request events contain UTC timestamp, level, generated UUID request ID, bounded
HTTP method, registered route template, status and duration. Incoming request ID
headers are ignored. Authentication security events reuse the same request ID;
the response exposes it through `X-Request-Id` and CORS. AsyncLocalStorage keeps
concurrent requests separate. Pass the ID when reporting a failure.

The logger projects allowed fields. It never serializes request/response bodies,
headers, query strings, raw resource paths, error objects/stacks, SQL, token
values, email addresses or IP addresses. Unknown routes use `unmatched`; arbitrary
methods use `OTHER`. Development SQL parameter logging is disabled. Five-hundred
responses use safe generic text while explicit HTTP status codes are retained.
Background events contain a bounded operation name; counters use the same names.
This policy covers the API/background runtime, not the intentional fake account
output from the developer seed command or all manual operator CLI output.

Structured stdout is the integration point for a host log collector. A persistent
collector, access policy, retention and disk limits still need deployment setup.
No third-party log exporter is enabled. The events are diagnostic/security signals,
not a replacement for durable business audit history. Do not add raw exceptions or
user-supplied values to approved string fields when extending instrumentation.

## Metrics and scaling rules

| Metric                                                        | Interpretation                                                                                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `isotrack_http_request_duration_seconds`                      | Histogram/count/sum by method, route template and status. Measures response preparation, not streaming completion or client network time.   |
| `isotrack_http_inflight`                                      | Currently executing requests in this process.                                                                                               |
| `isotrack_database_request_duration_seconds`                  | Neon HTTP time to response headers, success/error; transaction batches are one transport operation. No SQL labels or execution-plan timing. |
| `isotrack_background_failures_total`                          | Dependency/dispatch/worker failures by bounded operation; includes failures outside delivery attempts.                                      |
| `isotrack_payment_reconciliation_total`                       | Attempt outcomes from completed reconciliation sweeps.                                                                                      |
| `isotrack_dependency_ready`                                   | Most recent database/Redis probe result.                                                                                                    |
| `isotrack_backlog_present`, `isotrack_backlog_oldest_seconds` | Presence and overdue age of durable work, expired leases, dead letters and unresolved payment reviews.                                      |
| `isotrack_backlog_snapshot_timestamp_seconds`                 | Last complete successful backlog observation; zero until one succeeds.                                                                      |
| `isotrack_process_*`                                          | Process start time and resident memory.                                                                                                     |

Backlog observations are shared/cached for fifteen seconds per process and have
the same probe deadline. SQL seeks the earliest row through indexed predicates;
it does not count or materialize whole tables. Ages use the database clock,
clamped at zero for future-scheduled work. Dead-letter age is measured from its
last available-at time, not a separate failure timestamp. Snapshot failure keeps
the previous values and timestamp; freshness alerts prevent treating stale zero
values as healthy. Failed scrape authentication does not execute collection SQL.

Scrape **each API process directly**, not an arbitrary load-balancer target.
Request counters/histograms are process-local and reset on restart; use `rate`
and histogram bucket aggregation. Do not sum durable backlog values across
replicas: each replica observes the same database. Use `max by(queue)` for an
aggregate view. Never add business/user/shipment IDs, reference numbers, IPs,
request IDs, query text or arbitrary exception names as metric labels.

Useful PromQL examples:

```promql
sum by(route,status)(rate(isotrack_http_request_duration_seconds_count[5m]))
histogram_quantile(0.95,sum by(le)(rate(isotrack_http_request_duration_seconds_bucket{route=~"/api/v1/.*"}[5m])))
max by(queue)(isotrack_backlog_oldest_seconds)
rate(isotrack_background_failures_total[5m])
```

## Alerts and response

`monitoring/alerts.yml` defines initial engineering thresholds. The two-second
p95 and five-percent 5xx rules require at least twenty requests in five minutes
and persist for five minutes before firing. These thresholds are starting points,
not business-approved SLOs or measured million-user capacity.

| Alert                      | First action / runbook                                                                                                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scrape down                | Check process reachability, token pairing, TLS/network policy and Prometheus target errors. Do not disable authentication to fix scraping.                                          |
| Database down              | Check database availability, credentials, schema rollout and transport latency; keep liveness separate. Repair forward or follow the deployment recovery plan.                      |
| Redis degraded             | Inspect Redis connectivity/limits and queue consumers; preserve PostgreSQL outbox rows. See `docs/notifications.md` and the notification operations commands.                       |
| Snapshot stale             | Treat backlog state as unknown; inspect SQL availability, missing indexes and probe deadlines. An empty-looking dashboard is not evidence of no pending work.                       |
| Work stuck / lease expired | Check dispatcher/worker processes and database leases; inspect `notifications:status`, `account-actions:status` and `payments:status`. Avoid manually clearing financial guards.    |
| Dead letters               | Investigate recipient/configuration/provider failure before bounded replay. Use the notification/account-recovery runbooks; account action expiry may require a fresh user request. |
| Payment review             | Follow `docs/payments.md`: reconcile, inspect actual provider receipt, then record verified refund proof if appropriate. Never mark money resolved based on an alert alone.         |
| API errors / latency       | Correlate request IDs, database transport, in-flight work, RSS and dependency signals; pause rollout if it caused the regression. Diagnose before adding replicas.                  |

Repeated reconciliation failures also warn after at least three failures in
fifteen minutes persist for two minutes. This covers uncertain payments that are
continually rescheduled by a working dispatcher, keeping their due-age small.
Investigate provider/configuration and original retry-window state with
`payments:status`; follow the payment runbook rather than clearing guards.

The release responder is still to be explicitly assigned by the repository
maintainer. Alert grouping, repeat intervals, maintenance silences and thresholds
need a deployment rehearsal. A silence acknowledges/suppresses a signal; it does
not fix the underlying condition. Monitoring availability and storage also need
their own host-level checks. Distributed tracing and SQL profiling are deferred
until a concrete diagnostic need justifies them.

## Evidence and limits

Fast tests exercise request isolation, projection/privacy, cardinality, safe
errors, probe timeouts/single-flight behavior, metrics authorization and database
transport outcomes. Integration tests use actual migrated PostgreSQL, Redis and
TCP HTTP handlers, including schema failure and complete database container loss.
They assert durable backlog contents, not invented queue responses.

The pinned Prometheus `promtool` validates/evaluates the shipped rules. A real
Prometheus and Alertmanager scrape a PostgreSQL review record, wait for the
production one-minute alert hold, deliver it to a local fixture webhook and accept
an acknowledgement silence. No external email, chat, page or payment is sent.
This proves a controlled local chain, not delivery through a deployed receiver.

Full results belong in the readiness register and validated reports. Hosted Neon,
the complete Bun entrypoint, real ingress, provider dashboards, remote CI,
production notification routing, log retention, overhead/load and host-monitor
capacity remain separate release gates.

References: [Prometheus client](https://github.com/prometheus/client_js),
[exposition format](https://prometheus.io/docs/instrumenting/exposition_formats/),
[alert rules](https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/),
[rule testing](https://prometheus.io/docs/prometheus/latest/configuration/unit_testing_rules/).
