import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  percentile,
  runPhase,
  phaseFailures,
} from "../scripts/load-engine.mjs";

test("tail latency and failed/dropped work cannot produce a passing load result", () => {
  assert.equal(percentile([1, 2, 3, 4, 100], 0.95), 100);
  assert.equal(percentile([], 0.95), null);
  const result = {
    name: "steady",
    failed: 1,
    dropped: 2,
    completed: 8,
    offered: 10,
    operations: { "read-business": { p95Ms: 700 } },
  };
  assert.equal(phaseFailures(result).length, 3);
  assert.equal(
    phaseFailures({
      ...result,
      failed: 0,
      dropped: 0,
      completed: 10,
      operations: { "read-business": { p95Ms: 100 } },
    }).length,
    0,
  );
});

test("fixed arrivals bound in-flight work and report overload rather than hiding it", async () => {
  let inFlight = 0,
    peak = 0;
  const result = await runPhase(
    { name: "burst", rate: 1000, seconds: 0.05, maxInFlight: 2 },
    async () => {
      peak = Math.max(peak, ++inFlight);
      await delay(20);
      inFlight--;
      return "read-business";
    },
  );
  assert.ok(peak <= 2);
  assert.ok(result.dropped > 0);
  assert.equal(result.completed + result.dropped, 50);
  assert.ok(
    phaseFailures(result).some((failure) => failure.includes("dropped")),
  );
});
