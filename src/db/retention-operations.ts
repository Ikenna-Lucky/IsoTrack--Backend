import { retentionStore } from "./retention-store";
import {
  retentionTasks,
  retentionBatch,
  retentionStatus,
} from "./queries/retention";
import { createRetentionRunner } from "../services/retention-runner";

async function main() {
  const command = process.argv[2] ?? "preview";
  if (
    process.argv.length > 3 ||
    !["preview", "status", "run"].includes(command)
  )
    throw new Error("Use preview, status or run");
  if (command === "status") {
    console.info(
      JSON.stringify(await retentionStore.execute(retentionStatus())),
    );
  } else if (command === "preview") {
    for (const task of retentionTasks)
      console.info(
        JSON.stringify((await retentionStore.execute(retentionBatch(task)))[0]),
      );
  } else {
    const runner = createRetentionRunner({
      store: retentionStore,
      result: (task, status, affected) =>
        console.info(JSON.stringify({ task, status, affected })),
    });
    const result = await runner.run();
    if (result.failed) process.exitCode = 1;
  }
}
main().catch(() => {
  console.error(
    "Retention operation failed; inspect migration and database health.",
  );
  process.exitCode = 1;
});
