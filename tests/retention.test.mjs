import assert from "node:assert/strict";
import { test } from "node:test";
import { createRetentionRunner } from "../src/services/retention-runner.ts";
import { retentionTasks, retentionBatch } from "../src/db/queries/retention.ts";
import { PgDialect } from "drizzle-orm/pg-core";

test("retention preview is the default and rejects unbounded batches", () => {
  const text = new PgDialect().sqlToQuery(retentionBatch("sessions")).sql;
  assert.ok(!/delete|update|advisory|retention_runs/i.test(text));
  for (const limit of [0, -1, 501, 1.5, NaN])
    assert.throws(() => retentionBatch("sessions", false, limit));
});

test("cleanup failures remain visible while independent tasks continue", async () => {
  let calls = 0;
  const results = [];
  const runner = createRetentionRunner({
    store: {
      execute: async () => {
        const task = retentionTasks[calls++];
        if (calls === 1) throw new Error("PRIVATE database data");
        return [{ task, status: "success", affected: 0, recorded: true }];
      },
    },
    result: (...result) => results.push(result),
  });
  assert.equal((await runner.run()).failed, 1);
  assert.equal(calls, retentionTasks.length);
  assert.deepEqual(results[0], ["sessions", "error", 0]);
  assert.ok(!JSON.stringify(results).includes("PRIVATE"));
  await runner.close();
});

test("overlapping ticks share work and shutdown drains only the current batch", async () => {
  let finish, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  let calls = 0;
  const runner = createRetentionRunner({
    store: {
      execute: async () => {
        calls++;
        entered();
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    },
    result: () => {},
  });
  const first = runner.run(),
    duplicate = runner.run();
  await started;
  assert.equal(first, duplicate);
  let drained = false;
  const closed = runner.close().then(() => {
    drained = true;
  });
  assert.equal(drained, false);
  finish([{ status: "success", affected: 1, recorded: true }]);
  await Promise.all([first, duplicate, closed]);
  assert.equal(calls, 1);
  await runner.run();
  assert.equal(calls, 1);
});
