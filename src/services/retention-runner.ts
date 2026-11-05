import {
  retentionBatch,
  retentionTasks,
  type RetentionTask,
} from "../db/queries/retention.ts";
import type { WriteStore } from "../lib/idempotency.ts";

interface Dependencies {
  store: WriteStore;
  result: (
    task: RetentionTask,
    status: "success" | "busy" | "error",
    affected: number,
  ) => void;
}
export function createRetentionRunner(
  deps: Dependencies,
  intervalMs = 900_000,
) {
  let stopping = false;
  let running: Promise<{ failed: number }> | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  async function cycle() {
    let failed = 0;
    for (const task of retentionTasks) {
      if (stopping) break;
      try {
        const row = (await deps.store.execute(retentionBatch(task, false)))[0];
        if (
          !row ||
          !["success", "busy"].includes(String(row.status)) ||
          !Number.isInteger(row.affected) ||
          Number(row.affected) < 0 ||
          Number(row.affected) > 500 ||
          (row.status === "success" && row.recorded !== true)
        )
          throw new Error("Invalid retention result");
        deps.result(
          task,
          row.status as "success" | "busy",
          Number(row.affected),
        );
      } catch {
        failed++;
        deps.result(task, "error", 0);
      }
    }
    return { failed };
  }
  function run() {
    if (stopping) return Promise.resolve({ failed: 0 });
    running ??= cycle().finally(() => {
      running = null;
    });
    return running;
  }
  return {
    run,
    start() {
      if (timer || stopping) return;
      timer = setInterval(() => {
        void run();
      }, intervalMs);
      timer.unref();
      void run();
    },
    async close() {
      stopping = true;
      clearInterval(timer);
      await running;
    },
  };
}
