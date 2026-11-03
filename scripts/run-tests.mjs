import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { requirePassingReport } from "./test-report.mjs";

const suite = process.argv[2];
if (!["unit", "integration"].includes(suite))
  throw new Error("Expected unit or integration suite");
const root = fileURLToPath(new URL("../", import.meta.url));
const suffix = suite === "unit" ? ".test.mjs" : ".integration.mjs";
const files = readdirSync(resolve(root, "tests"))
  .filter((file) => file.endsWith(suffix))
  .sort()
  .map((file) => resolve(root, "tests", file));
if (!files.length) throw new Error(`No ${suite} test files discovered`);
mkdirSync(resolve(root, "reports"), { recursive: true });
const report = resolve(root, "reports", `${suite}.xml`);
rmSync(report, { force: true });
const startedAt = new Date().toISOString();
const result = spawnSync(
  process.execPath,
  [
    "--test",
    // Bound simultaneous Docker fixtures on developer machines and CI runners.
    // Races within each suite still exercise concurrent production requests.
    ...(suite === "integration" ? ["--test-concurrency=2"] : []),
    "--test-reporter=spec",
    "--test-reporter=junit",
    "--test-reporter-destination=stdout",
    `--test-reporter-destination=${report}`,
    ...files,
  ],
  {
    cwd: root,
    stdio: "inherit",
    timeout: suite === "integration" ? 900000 : 60000,
  },
);
let counts = null;
let reportError = null;
try {
  counts = requirePassingReport(readFileSync(report, "utf8"));
} catch (error) {
  reportError = error.message;
}
const passed = result.status === 0 && !result.error && !reportError;
writeFileSync(
  resolve(root, "reports", `${suite}.json`),
  JSON.stringify(
    {
      suite,
      startedAt,
      finishedAt: new Date().toISOString(),
      node: process.version,
      platform: process.platform,
      commit: process.env.GITHUB_SHA ?? null,
      files: files.map((file) => file.slice(root.length)),
      counts,
      passed,
      exitStatus: result.status,
      signal: result.signal,
      error: result.error?.message ?? reportError,
    },
    null,
    2,
  ) + "\n",
);
if (!passed) {
  console.error(
    result.error?.message ?? reportError ?? `${suite} tests failed`,
  );
  process.exitCode = 1;
}
