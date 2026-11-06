# Isolated Render preview

Status: tooling prepared; no hosted service, credential, database or deployment was
created or changed by this build. The GitHub preview job is disabled by default.
Main and the existing live service remain separate. Follow these steps yourself
in the dashboards; never paste credentials into chat, commits or screenshots.

## What this preview proves

The existing quality/integration/checks jobs must pass before the optional preview
job runs on a push to isotrack-preview-branch. That job validates isolation, builds and
boots a network-isolated Docker image, migrates/seeds only the preview database,
triggers the preview service's secret hook with the exact commit, waits for matching
release identity/readiness, and runs deployed smoke checks. Reports contain SHA,
check names/statuses and pass/fail, never credentials or response bodies.

The hosted checks cover four fixture logins, owner/driver/customer shipment/history
access, foreign-tenant denial, anonymous denial, public tracking privacy, body size
and public tracking throttling. They create login sessions and consume budgets,
but do not change shipment workflow, charge cards or send email. Fixture preparation
creates four synthetic accounts, two businesses, a private driver and two shipments.
It verifies existing fixture passwords/roles rather than overwriting them.

This initial preview disables notification workers, automatic retention and payment
credentials. Email invitation/recovery/delivery-code dispatch, in-app background
delivery and Stripe checkout/settlement are not established here. No frontend
integration is included. A later provider-sandbox/assembled-journey gate is required.

Render Free sleeps after inactivity and blocks SMTP ports used by this app's Gmail
sender. It cannot demonstrate always-on worker availability. Keep preview synthetic
and on free compute. Sources: [Free limits](https://render.com/docs/free),
[Docker builds](https://render.com/docs/docker),
[deploy hooks](https://render.com/docs/deploy-hooks),
[commit-specific deploys](https://render.com/docs/deploys).

## Branch roles

- `isoTrack-dev-branch`: ongoing backend development and CI.
- `isotrack-preview-branch`: reviewed code selected for the separate preview service.
- `main`: existing live deployment; no promotion is authorized yet.

Configure Render and GitHub environment deployment rules for **isotrack-preview-branch**
only. After committing this branch-policy change, bring it back into dev before
turning on PREVIEW_DEPLOY_ENABLED, so dev no longer carries the older deployment
rule. This does not require merging main. Future reviewed builds can be merged
from dev into preview, then tested/deployed there. Do not force-push or reset a
branch to synchronize it.

## 1. Commit and push only preview, with deployment disabled

Review the changes and commit/push isotrack-preview-branch as usual. Do not merge main.
Leave repository variable PREVIEW_DEPLOY_ENABLED absent/false for now. CI discovers
the new tests; preview is skipped. The workflow lives in existing ci.yml and uses
push events, so no default-branch workflow_dispatch merge is necessary. Existing
allowed actions suffice. All normal CI gates still apply.

Suggested commit: `Add isolated Render preview release workflow`.

## 2. Create isolated free data services

1. In Neon, create a **new empty free project**, not a data-bearing clone of the live
   database. Select PostgreSQL 17 if available to match local verification. Copy its
   connection URL privately. Record its hostname as PREVIEW_DATABASE_HOST. Record
   only the live connection's hostname as LIVE_DATABASE_HOST. Never use the live URL
   as a preview secret. Neon pooler/direct spellings of the same endpoint are treated
   as the same host by the guard.
2. For Redis-compatible storage, use a new free Render Key Value instance in the
   same region as the preview web service, if your account's free allowance permits.
   Name it distinctly, e.g. isotrack-preview-cache. Select Free, no persistence and
   noeviction. Record its **internal** connection URL/hostname. Do not enable public
   access just for CI: preparation only validates this URL; it does not connect to
   Redis from the GitHub runner. The deployed app connects over Render's network.
   Alternatively use a genuinely separate free Redis service you already have.
   Do not upgrade or reuse the live instance to work around a quota.
3. Record the live Redis hostname separately as LIVE_REDIS_HOST. All comparison
   hosts omit scheme, credentials, path and port. Isolation checks compare configured
   hosts; they cannot prove you accurately identified live resources or that a
   database has never contained production data. Confirm the dashboard identities.

New Render Key Value instances currently use Valkey 8. Local limiter evidence is
Redis 7; hosted compatibility must pass the smoke gate. Free storage is ephemeral,
so counter reset after restart is expected. No preview background queue runs.
See [Render Key Value](https://render.com/docs/key-value) and
[Neon free plan](https://neon.com/docs/introduction/plans).

## 3. Create a NEW Render preview web service

1. In Render choose New → Web Service and connect the backend GitHub repository.
   Create a separate service named isotrack-backend-preview (or another distinct
   available name). Do not edit the existing live service.
2. Select branch **isotrack-preview-branch**, runtime **Docker**, compute **Free**, the
   same region as the preview Key Value instance, Dockerfile `./Dockerfile`, context
   repository root. Leave Docker Command blank. Do not set pre-deploy commands or
   the old seed script. Do not attach live environment groups or disks.
3. Turn Auto-Deploy **Off**. The GitHub job will invoke only this service's hook.
4. Configure the variables in .env.preview.example on this new service. Replace
   placeholder app/preview/live hosts accurately. APP_URL is the preview HTTPS
   origin; PREVIEW_APP_HOST is its hostname; LIVE_APP_HOST is the actual live backend
   hostname. If Render assigns a different preview URL, update these values before
   enabling the pipeline. FRONTEND_URL may initially be the preview origin because
   this gate uses API requests rather than a new frontend deployment.
5. Use the new DB/Redis URLs, generate two independent random preview JWT secrets
   (for example `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   twice), and keep NOTIFICATION_WORKERS_ENABLED=false and RETENTION_ENABLED=false.
   Leave Stripe, account-action and delivery-code secrets blank. The supplied Gmail
   placeholder values are inert because workers are disabled. Do not copy real
   SMTP credentials or live JWT/provider secrets.
6. Do not manually set RELEASE_SHA: the Docker entrypoint reads the validated SHA
   baked from RELEASE_SHA (CI) or Render's RENDER_GIT_COMMIT build argument. Only these
   non-secret build arguments are referenced. Application secrets stay runtime-only.
7. For initial bootstrap use health path `/health/live`. This lets the new process
   start before its empty database is migrated; this is **not release readiness**.
   The CI job still requires `/health/ready` after migration. After the first verified
   release, change the Render health path to `/health/ready` for future deploys.
8. Keep TRUSTED_PROXY_IPS blank until exact immediate proxy addresses and header
   overwrite behavior are verified. Never trust arbitrary forwarded headers or all
   networks. Blank safely budgets the socket peer, which can combine Render users
   behind a proxy; the hosted smoke check cannot establish client-IP separation.
9. Copy the new service's service ID and secret Deploy Hook URL from Settings. Also
   record the existing live service ID for the guard, without changing that service.

Render automatically supplies [RENDER_GIT_COMMIT](https://render.com/docs/environment-variables).
It rebuilds the pinned source with the same Dockerfile; this path does **not** promote
the exact CI image digest. Bun image versions and dependencies are locked, but base
image tags can change. Immutable registry-image promotion remains a future upgrade.

## 4. Configure GitHub's preview environment

In backend repo Settings → Environments → New environment, create `preview`.
Under deployment branch rules, select only isotrack-preview-branch. Keep these secrets
scoped to this environment. Do not place them in pull-request inputs.

Environment secrets:

| Name | Value |
| --- | --- |
| PREVIEW_DATABASE_URL | New empty Neon project's connection URL |
| PREVIEW_REDIS_URL | Separate preview Redis/Key Value URL |
| PREVIEW_FIXTURE_PASSWORD | New random password, at least 32 characters; stable across reruns |
| RENDER_PREVIEW_DEPLOY_HOOK | New preview service's secret hook URL |

Environment variables:

| Name | Value |
| --- | --- |
| PREVIEW_APP_URL | Preview HTTPS origin, e.g. https://your-preview.onrender.com |
| PREVIEW_APP_HOST | Preview backend hostname |
| LIVE_APP_HOST | Live backend hostname |
| PREVIEW_DATABASE_HOST | Preview DB hostname |
| LIVE_DATABASE_HOST | Live DB hostname |
| PREVIEW_REDIS_HOST | Preview Redis hostname |
| LIVE_REDIS_HOST | Live Redis hostname |
| RENDER_PREVIEW_SERVICE_ID | New preview service's srv-… ID |
| RENDER_LIVE_SERVICE_ID | Existing live service's different srv-… ID |

Copy preview URL/host/connection settings consistently between Render and GitHub.
The fixture password is for synthetic smoke logins only; it need not be set on
Render. The helper creates those accounts with bcrypt hashes in the preview DB.
The live URL/passwords are never needed. Keep the fixture password unchanged unless
you deliberately reset/update the disposable accounts through a separate process.

In Settings → Secrets and variables → Actions → Variables, add the **repository**
variable PREVIEW_DEPLOY_ENABLED=true only after the above is complete. This flag
must be repository-level because the job's condition is evaluated before loading
the preview environment. No new allowed-action entries are used.

## 5. Run and inspect the first release

1. Push the next reviewed preview commit (an empty preview commit may deliberately trigger
   a run once setup is complete). Do not push main. Existing CI must pass first.
2. Open Actions → Backend CI for that preview SHA. The preview job should run after
   checks. It validates target IDs/hosts before any migration or deployment.
3. Inspect each step: container proof → preview migration/fixtures → hook → hosted
   smoke. Hook acceptance is not deployment success. The script waits up to ten
   minutes for the same SHA and runs all checks before writing passed=true.
4. Open backend-preview-release artifact and verify SHA, environment=preview,
   passed=true and expected check results. Record the run URL/SHA/Render deploy ID.
5. Set Render's health path to `/health/ready` after initial success. Open the preview
   /health/release endpoint and compare the SHA. This endpoint exposes only the
   environment and commit, not dependency URLs/secrets.

No authenticating request is sent until release identity matches. Requests refuse
redirects and live resource/service IDs. Smoke traffic makes up to 65 tracking
requests with at most five in flight to verify 429/Retry-After; it is not a load
benchmark. Wait at least one minute before rerunning to avoid an already exhausted
tracking window. Repeated login tests also consume existing auth budgets. If a
Render build is queued, the hook step fails explicitly so you can inspect it;
do not blindly spam retries. A failed preparation step can have applied a valid
migration before fixture validation failed; inspect history before retrying.

Container/Docker failures stop the job before DB migration. CI Docker boot checks
use no network and prove only release/liveness startup, not Neon/Redis connectivity.
Local Docker Hub DNS was unavailable during development, so this image gate remains
unverified until a successful CI/container run. Do not bypass it to deploy.

## Stop and rollback

Keep PREVIEW_DEPLOY_ENABLED=false until you are ready for another deployment. A
running preview release is not auto-cancelled by a newer preview push; deployments are
serialized. If an unexpected target, real provider traffic, failed smoke or schema
incompatibility appears, stop promotion and inspect the new preview service only.

For application rollback, use the **preview** Render service's Manual Deploy →
Deploy a specific commit with a recorded earlier successful preview SHA. Rebuilding
an old commit may be needed on the free plan; do not assume instant rollback or
reuse a pre-preview commit without its Dockerfile. Confirm /health/release and run
the corresponding read-only/manual smoke checks against its compatible schema.
If no previous preview release exists, disable/pause the preview and repair forward.

Application rollback does not undo database migrations. Take an isolated preview
backup/snapshot before later schema changes, review expand/contract compatibility,
and restore into a new preview database if needed. Do not drop tables, reset the
live database or run down migrations automatically. Synthetic preview data may be
recreated deliberately; live backup/restore remains a separate gate. This runbook
is not evidence that a hosted rollback or restore has been exercised.
