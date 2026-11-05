import { createRetentionRunner } from "./retention-runner";
import { retentionStore } from "../db/retention-store";
import { env } from "../lib/env";
import { telemetry, logEvent } from "../observability/telemetry";

export function startRetention() {
  telemetry.retentionEnabled.set(Number(env.RETENTION_ENABLED));
  const runner = createRetentionRunner({
    store: retentionStore,
    result(task, status, affected) {
      telemetry.retentionRuns.inc({ task, status });
      telemetry.retentionAffected.inc({ task }, affected);
      logEvent(
        status === "error" ? "retention_failed" : "retention_completed",
        {
          operation: task,
          outcome: status,
          affected,
        },
      );
    },
  });
  if (env.RETENTION_ENABLED) runner.start();
  return runner;
}
