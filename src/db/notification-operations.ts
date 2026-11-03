import { outboxStore } from "./outbox-store";
import {
  replayOutboxStatement,
  purgeOutboxStatement,
  outboxStatusStatement,
} from "./queries/outbox";

async function main() {
  const [action, id] = process.argv.slice(2);
  if (action === "status") {
    console.info(
      JSON.stringify(await outboxStore.execute(outboxStatusStatement())),
    );
  } else if (action === "replay" && id) {
    const rows = await outboxStore.execute(replayOutboxStatement(id));
    if (!rows.length)
      throw new Error("Notification is not available for dead-letter replay");
    console.info(
      JSON.stringify({ event: "notification_replayed", outboxId: id }),
    );
  } else if (action === "purge") {
    const rows = await outboxStore.execute(purgeOutboxStatement());
    console.info(
      JSON.stringify({
        event: "notification_outbox_purged",
        deleted: rows.length,
      }),
    );
  } else {
    throw new Error("Use status, replay <outbox-id>, or purge");
  }
}
main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Notification operation failed",
  );
  process.exitCode = 1;
});
