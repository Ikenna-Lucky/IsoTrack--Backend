# Isolated Render preview

Development stays on `isoTrack-dev-branch`, reviewed preview releases go to
`isotrack-preview-branch`, and `main` remains the existing live release.
No hosted deployment or database preparation has been performed by this build.

## Release sequence

<<<<<<< HEAD
1. Commit and test on dev. Promote reviewed work to preview using a merge commit
   (GitHub's Create a merge commit option), giving preview a distinct commit SHA.
2. Backend CI runs quality and integration tests. On preview pushes it also validates
   isolation, builds/boots the Docker image without network access, then migrates
   and prepares synthetic fixtures in the preview database.
3. The final `checks` job requires preparation to succeed on preview pushes.
4. Render's **After CI Checks Pass** auto-deploy builds that preview commit.
5. After deployment, run the separate verification command below and inspect its
   report. Hosted verification is intentionally outside commit CI: waiting for
   Render inside a check that Render itself awaits would deadlock.
=======
The existing quality/integration/checks jobs must pass before the optional preview
job runs on a push to isotrack-preview-branch. That job validates isolation, builds and
boots a network-isolated Docker image, migrates/seeds only the preview database,
triggers the preview service's secret hook with the exact commit, waits for matching
release identity/readiness, and runs deployed smoke checks. Reports contain SHA,
check names/statuses and pass/fail, never credentials or response bodies.
>>>>>>> c012b51267fbef0a1fb797988f55f38c55230b20

There is no deploy hook or Render API token in this flow. Render rebuilds source;
this does not promote the exact image digest tested in CI. Skipped/neutral checks
can count as passing in Render, so missing preparation configuration deliberately
fails the preview job rather than skipping it. See [Render deploys](https://render.com/docs/deploys).

## Prepare the Neon database

A separate Neon preview branch is acceptable. Confirm the branch selector says
**preview**, never production, before creating resources or copying a connection URL.
The user's schema-only copy has seven application tables and zero migration records.
It cannot safely receive the migration sequence as-is: initial migrations would
collide with existing tables. The preparation guard rejects that state before writes.

<<<<<<< HEAD
Preserve the copied database and create an empty database inside the preview branch:

1. Select the ISOTrack project and preview branch in Neon.
2. Under Postgres database, open Databases and select Add database.
3. Name it `isotrack_preview`, choose the existing preview database owner, and Create.
4. Open Connect, explicitly select preview and the new database, and privately copy
   the complete connection URL. Update only preview Render's `DATABASE_URL` and
   GitHub preview environment's `PREVIEW_DATABASE_URL`.
=======
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
>>>>>>> c012b51267fbef0a1fb797988f55f38c55230b20

The database path changes; the preview endpoint hostname can stay the same. Do not
change the live service, delete the copied database, run `db:push`, or invent ledger
rows. Migrations create the new database's application tables and history.
[Neon database instructions](https://neon.com/docs/manage/databases).

`scripts/inspect-preview-schema.sql` contains read-only metadata queries for review.
A nonempty migration ledger still undergoes the migration runner's hash/order checks;
its mere presence does not establish compatibility.

## Render preview settings

Use a separate Free Web Service connected to **isotrack-preview-branch**, Docker
runtime, repository-root Dockerfile/context, blank Docker Command, and
**After CI Checks Pass** auto-deploy. Use health path `/health/ready` once preparation
has completed, before the initial deployment. Do not click the initial Deploy button
until database preparation and CI configuration are ready; service creation can
initiate an initial deployment outside the later auto-deploy sequence.

Use `.env.preview.example` for runtime settings, replacing placeholders privately.
Use separate preview JWT secrets, preview database and separate preview Key Value
URL. Keep notification workers and retention disabled and Stripe credentials blank.
Do not manually set RELEASE_SHA: the Docker entrypoint uses Render's build commit.
Keep TRUSTED_PROXY_IPS blank until exact immediate proxy/header behavior is verified.

<<<<<<< HEAD
The Render Key Value internal URL is used by the hosted app. GitHub preparation
validates its identity but does not connect to it. Live hostnames are comparison
values only; never supply live connection credentials. Hostnames omit scheme,
username/password, port, and path. Neon pooler/direct aliases are normalized.
Guards depend on correctly identifying resources; they cannot establish provenance.
=======
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
>>>>>>> c012b51267fbef0a1fb797988f55f38c55230b20

Render Free sleep and SMTP restrictions mean this preview cannot establish always-on
worker or email delivery reliability. Provider sandbox, frontend journeys and proxy
client-IP separation remain later gates. See [Free limits](https://render.com/docs/free)
and [Key Value](https://render.com/docs/key-value).

## GitHub preview environment

<<<<<<< HEAD
In repository Settings > Environments, configure `preview` with deployment branch
rules permitting only **isotrack-preview-branch**.
=======
In backend repo Settings → Environments → New environment, create `preview`.
Under deployment branch rules, select only isotrack-preview-branch. Keep these secrets
scoped to this environment. Do not place them in pull-request inputs.
>>>>>>> c012b51267fbef0a1fb797988f55f38c55230b20

Environment secrets:

| Name | Value |
| --- | --- |
| PREVIEW_DATABASE_URL | Complete URL for the new empty preview database |
| PREVIEW_REDIS_URL | Separate preview Key Value internal URL |
| PREVIEW_FIXTURE_PASSWORD | Stable random synthetic-account password, at least 32 characters |

Environment variables:

| Name | Value |
| --- | --- |
| PREVIEW_APP_URL | Preview HTTPS origin |
| PREVIEW_APP_HOST | Preview backend hostname |
| LIVE_APP_HOST | Existing live backend hostname |
| PREVIEW_DATABASE_HOST | Preview Neon endpoint hostname |
| LIVE_DATABASE_HOST | Live Neon endpoint hostname |
| PREVIEW_REDIS_HOST | Preview Key Value hostname |
| LIVE_REDIS_HOST | Live Redis hostname |
| PREVIEW_PREPARE_ENABLED | true, only after resource/configuration review |

The former PREVIEW_DEPLOY_ENABLED, deploy-hook secret and Render service ID variables
are unused by this workflow. The fixture password need not be on Render. Existing
fixtures are validated rather than having credentials overwritten automatically.
No new allowed-action entries are needed.

On dev and pull requests, preparation is skipped and normal CI applies. On preview
pushes, absent/false PREVIEW_PREPARE_ENABLED fails preparation and final checks,
blocking automatic deployment. To pause deployments, also turn Render auto-deploy
Off; changing a flag cannot revoke a deployment already triggered.

## Inspect preparation and verify the deployed release

<<<<<<< HEAD
Inspect Backend CI for the preview SHA: quality, every integration shard,
preview_prepare and checks must succeed. The preparation artifact
`backend-preview-preparation` contains `reports/preview-preparation.json` with SHA,
passed status and fixture/migration counts; retention is 14 days. Early container or
configuration failure may precede report creation: inspect the failed job's logs.
A preparation failure may follow a successfully applied migration, so inspect the
ledger before retrying. Do not bypass failed container checks.
=======
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
>>>>>>> c012b51267fbef0a1fb797988f55f38c55230b20

After Render finishes deploying that SHA, use the preview checkout and a private,
ignored `.env.preview` containing the isolation settings, fixture password and the
exact RELEASE_SHA from the reviewed deployment. From the backend directory run:

```sh
bun --env-file=.env.preview run scripts/preview-release.mjs --verify-only
```

The script requires the preview branch, refuses redirects and checks matching
preview environment/SHA plus readiness before submitting fixture credentials.
It verifies four role logins, shipment/history access, foreign-tenant and anonymous
denial, public privacy, body limits and tracking throttling. It creates sessions
and consumes rate budgets but does not charge cards or send messages. Wait at least
one minute between reruns. Reports contain statuses and SHA, not credentials/bodies.
Inspect `reports/preview-smoke.json` for `passed: true` and record the CI run URL,
SHA and Render deploy ID. Hook acceptance or a green build alone is not hosted proof.

Local Docker image verification remains blocked by Docker Desktop DNS resolving
production.cloudfront.docker.com. CI must prove container startup successfully.
Local tests do not establish hosted Neon/Valkey behavior or million-user capacity.

## Stop and rollback

<<<<<<< HEAD
On failure, stop promotion and turn preview auto-deploy Off. Set preparation false
before further preview pushes if preparation must be blocked. Never change main or
the live service to repair preview. Use a recorded compatible preview commit for a
manual application rollback, then verify its identity and smoke behavior separately.
Application rollback does not undo migrations. Review expand/contract compatibility,
retain isolated preview recovery points, and restore into a new preview database
when needed. No automatic down migrations or destructive reset is provided.
Hosted rollback/restore and provider journeys remain unverified release gates.
=======
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
>>>>>>> c012b51267fbef0a1fb797988f55f38c55230b20
