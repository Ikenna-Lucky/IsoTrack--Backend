import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync } from "node:fs";
import { integrationShard } from "../scripts/test-plan.mjs";

const files = readdirSync(new URL("./", import.meta.url))
  .filter((file) => file.endsWith(".integration.mjs"))
  .sort();

test("CI shards cover every integration file exactly once with independent reports", () => {
  const plans = [1, 2, 3].map((index) => integrationShard(files, `${index}/3`));
  const assigned = plans.flatMap((plan) => plan.files);
  assert.deepEqual(assigned.toSorted(), files);
  assert.equal(new Set(assigned).size, files.length);
  assert.equal(new Set(plans.map((plan) => plan.reportName)).size, 3);
  assert.ok(plans.every((plan) => plan.files.length > 0));
  assert.deepEqual(integrationShard(files).files, files);
});

test("invalid shard configuration fails instead of silently omitting tests", () => {
  for (const value of [
    "",
    "0/3",
    "4/3",
    "1/0",
    "1/99",
    "1/2x",
    "1.5/3",
    "1/9007199254740993",
  ])
    assert.throws(() => integrationShard(files, value));
});
