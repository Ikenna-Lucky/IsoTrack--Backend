# Isolated Render preview

Development stays on `isoTrack-dev-branch`, reviewed preview releases go to
`isotrack-preview-branch`, and `main` remains the existing live release.
No hosted deployment or database preparation has been performed by this build.

## Release sequence

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

Preserve the copied database and create an empty database inside the preview branch:

1. Select the ISOTrack project and preview branch in Neon.
2. Under Postgres database, open Databases and select Add database.
3. Name it `isotrack_preview`, choose the existing preview database owner, and Create.
4. Open Connect, explicitly select preview and the new database, and privately copy
   the complete connection URL. Update only preview Render's `DATABASE_URL` and
   GitHub preview environment's `PREVIEW_DATABASE_URL`.

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

The Render Key Value internal URL is used by the hosted app. GitHub preparation
validates its identity but does not connect to it. Live hostnames are comparison
values only; never supply live connection credentials. Hostnames omit scheme,
username/password, port, and path. Neon pooler/direct aliases are normalized.
Guards depend on correctly identifying resources; they cannot establish provenance.

Render Free sleep and SMTP restrictions mean this preview cannot establish always-on
worker or email delivery reliability. Provider sandbox, frontend journeys and proxy
client-IP separation remain later gates. See [Free limits](https://render.com/docs/free)
and [Key Value](https://render.com/docs/key-value).

## GitHub preview environment

In repository Settings > Environments, configure `preview` with deployment branch
rules permitting only **isotrack-preview-branch**.

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

Inspect Backend CI for the preview SHA: quality, every integration shard,
preview_prepare and checks must succeed. The preparation artifact
`backend-preview-preparation` contains `reports/preview-preparation.json` with SHA,
passed status and fixture/migration counts; retention is 14 days. Early container or
configuration failure may precede report creation: inspect the failed job's logs.
A preparation failure may follow a successfully applied migration, so inspect the
ledger before retrying. Do not bypass failed container checks.

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

On failure, stop promotion and turn preview auto-deploy Off. Set preparation false
before further preview pushes if preparation must be blocked. Never change main or
the live service to repair preview. Use a recorded compatible preview commit for a
manual application rollback, then verify its identity and smoke behavior separately.
Application rollback does not undo migrations. Review expand/contract compatibility,
retain isolated preview recovery points, and restore into a new preview database
when needed. No automatic down migrations or destructive reset is provided.
Hosted rollback/restore and provider journeys remain unverified release gates.
