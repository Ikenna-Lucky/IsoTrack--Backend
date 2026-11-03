import type { Queue } from "bullmq";
import { dueOutboxStatement } from "../db/queries/outbox.ts";
import { outboxJobId, type OutboxStore } from "./outbox-processor.ts";

export async function dispatchOutbox(store: OutboxStore, queue: Queue) {
  const counts = await queue.getJobCounts(
    "waiting",
    "active",
    "delayed",
    "paused",
  );
  const capacity = Math.max(
    0,
    1000 - Object.values(counts).reduce((sum, n) => sum + n, 0),
  );
  if (!capacity) return 0;
  const due = (await store.execute(dueOutboxStatement())).slice(0, capacity);
  if (!due.length) return 0;
  await queue.addBulk(
    due.map((row) => ({
      name: "deliver",
      data: { outboxId: String(row.id) },
      opts: {
        jobId: outboxJobId(String(row.id)),
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      },
    })),
  );
  return due.length;
}

export function startOutboxDispatcher(
  store: OutboxStore,
  queue: Queue,
  reportError: () => void,
) {
  let running = false;
  let stopped = false;
  let pending: Promise<void> = Promise.resolve();
  const tick = () => {
    if (running || stopped) return;
    running = true;
    pending = dispatchOutbox(store, queue)
      .then(() => {})
      .catch(reportError)
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(tick, 5000);
  timer.unref();
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await pending;
  };
}
