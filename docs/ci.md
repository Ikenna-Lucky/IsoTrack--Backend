# Backend checks and test evidence

Use Node 24.12.0 and Bun 1.3.12, matching `.github/workflows/ci.yml`.

```sh
bun install --frozen-lockfile
bun run lint
bun run type-check
bun run build
bun run test:unit
bun run test:integration
```

The integration suites need Docker. They create disposable PostgreSQL/Redis,
Prometheus/Alertmanager containers, local HTTP/Socket.IO/SMTP servers and synthetic
records without loading application credentials, making Stripe payments or sending
external messages. The alert drill uses a local fixture receiver only. Images may
need network access on a cold machine. See `tests/README.md` for scope and cleanup.
The runner has a fifteen-minute integration timeout with two test files in
parallel; each CI integration group allows twenty minutes including setup.

Each CI integration group pulls all four service images in an explicit preparation step before the test
phase. Integration tests run only when preparation succeeded; a download failure
still fails the job. For a cold local machine, pull the same images listed in the
workflow before starting the suite so registry latency does not consume fixture
startup deadlines. No test assertion is automatically retried or skipped.

## Lint and build

ESLint checks TypeScript source, JavaScript tests and test tooling. Recommended
rules are supplemented by type-aware promise handling and unnecessary assertion
checks. Lint warnings fail the command. Tooling dependencies are declared directly
and locked rather than relying on incidental packages already installed locally.

## Reports

The test scripts discover the matching test files explicitly, run Node's test
runner with console and JUnit reporters, and write:

- `reports/unit.xml` and `reports/integration.xml`
- `reports/unit.json` and `reports/integration.json`

JSON summaries contain runtime, platform, executed file list, start/end times,
counts, exit status and the GitHub commit SHA when `GITHUB_SHA` is available. A
local run has `commit: null`; it must not be represented as evidence for a specific
Git commit without additional attribution.

The command fails on empty discovery, nonzero exit, missing/truncated reports,
failed/cancelled tests, skips or todos. Report validation has regression tests.
It recognizes Node 24's generated JUnit format; a reporter-format change must be
reviewed rather than silently accepted. Generated reports are ignored by Git.

## GitHub Actions

The `quality` job installs the frozen lockfile and requires lint, types, build and
fast tests. Three integration jobs run after quality succeeds. Each installs its
own locked dependencies and Docker images, then runs a disjoint group of files:

```sh
node scripts/run-tests.mjs integration 1/3
node scripts/run-tests.mjs integration 2/3
node scripts/run-tests.mjs integration 3/3
```

Discovery sorts all integration files and distributes them by position modulo the
group count. New files join automatically. Tests verify that the three groups
cover every integration file exactly once. Invalid, empty or out-of-range groups
fail before execution. The optional group argument is integration-only; normal
`npm run test:integration` still runs every file together.

Each group writes `reports/integration-<index>-of-3.xml` and `.json`, including its
selected files and group identity. Each retains a separate artifact for 14 days;
fast reports use `backend-unit-results`. Uploads run after test failures, and
missing files fail upload when tests started. Matrix `fail-fast: false` preserves
evidence from the other groups after one fails. Assertions are not retried.

The final `checks` job runs even after dependency failures or skips and succeeds
only if quality and every integration group succeeded. Require `checks` from
Backend CI in repository rules. Repository protection settings were not changed.
There is no deployment or production migration in this workflow.

Remote Actions success must be verified after these changes are pushed. A connector
lookup for the current local commit returned GitHub 404 on 2026-11-05; this does
not prove the repository or workflow is absent. Remote access and the new workflow's
Linux execution remain unverified. Local success does not establish either.

References: [GitHub matrix failure behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
and [distinct artifact names for matrix jobs](https://github.com/actions/upload-artifact).

## Verification on 2026-11-03

Local lint/type checks passed. All 27 fast tests and 40 PostgreSQL integration
tests passed, with no skips, todos, cancellations or failures. Their reports were
generated and validated through the same scripts used in CI.

A fresh Windows source copy with no `.env`, Git metadata or existing `node_modules`
successfully installed the frozen lockfile, passed lint/types/build and all 27 fast
tests. The source copy was removed afterward; evidence is retained under
`reports/clean-install*`. The Linux clean-room attempt could not pull its Node image
because Docker's registry host failed DNS resolution. Linux and remote Actions
verification remain outstanding; local success does not establish either.

## Verification on 2026-11-05

The complete local integration command passed 191/191 cases in 758.923 seconds,
with zero failures, cancellations, skips or todos across 13 files. Validated
reports/integration.xml and .json retain the result. Fast tests passed 64/64;
lint, types, Bun build and workflow/runner formatting also passed. This was a
Windows/Node 24.12.0 run with disposable real services and local provider fixtures.
See production-readiness.md for artifact attribution and remaining release gates.

The grouped runner smoke check (integration 9/13) also passed all 53 cases in
77.690 seconds and produced independent validated XML/JSON reports. The actual
three-group GitHub matrix remains unverified remotely.

Monitoring fixtures grant read/traverse access to synthetic configs for non-root
container users while keeping mounts read-only. Startup failures retain bounded
container diagnostics in the affected integration artifact under monitoring-*-diagnostic.json.

## CI runtime maintenance — 2026-11-05

The workflow uses `actions/checkout@v6`, `actions/setup-node@v6` and
`actions/upload-artifact@v6`, whose action manifests use Node 24. Jobs select
`ubuntu-24.04` explicitly instead of the moving ubuntu-latest label. This fixes the
reported action-runtime deprecations and avoids the announced latest-image major
version transition. The runner image still receives updates; this is not an immutable
image pin. Application Node 24.12.0 and Bun 1.3.12 versions remain unchanged.

Before pushing this update, add the new action tags to Settings > Actions > General:
`actions/checkout@v6, actions/setup-node@v6, actions/upload-artifact@v6, oven-sh/setup-bun@v2`.
Keep the old v4 entries too if other active branches still use them. Update the
allowlist before triggering the new workflow. Read-only workflow permissions remain.
Remote execution, artifact delivery and absence of these annotations must be checked
on the new commit; local formatting cannot establish those results.

References: [checkout manifest](https://raw.githubusercontent.com/actions/checkout/v6/action.yml),
[setup-node manifest](https://raw.githubusercontent.com/actions/setup-node/v6/action.yml),
[upload-artifact manifest](https://raw.githubusercontent.com/actions/upload-artifact/v6/action.yml),
[runner image support](https://github.com/actions/runner-images).
