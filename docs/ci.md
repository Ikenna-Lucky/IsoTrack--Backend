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

The integration suites need Docker. They create disposable PostgreSQL/Redis
containers, loopback Socket.IO/SMTP servers and synthetic records without loading
application credentials, making Stripe payments or sending external email. See
`tests/README.md` for scope and container cleanup details. The runner has a seven-
minute integration timeout; the CI job allows fifteen minutes including setup.

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

The workflow installs from the lockfile, requires lint/types/build, then runs both
test suites and retains their reports for 14 days. Integration still runs after a
unit-test failure when the build succeeded, preserving additional failure evidence.
Test failures retain their failing exit status. Missing report artifacts fail upload
when tests ran. No deployment or production migration occurs in this workflow.

After the first remote run, configure repository rules to require the `checks` job
from Backend CI before merging. Repository protection settings were not changed
here, and the workflow has not yet been verified on GitHub's Linux runner.

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
