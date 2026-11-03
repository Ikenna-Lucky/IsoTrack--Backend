import { writeStore } from "@/services/write-store";
import { scrubRequestsStatement } from "./queries/idempotency";

async function scrub() {
  const rows = await writeStore.execute(scrubRequestsStatement());
  console.info(
    JSON.stringify({
      event: "idempotency_payloads_scrubbed",
      count: rows.length,
    }),
  );
}
scrub().catch(() => {
  console.error("Idempotency cleanup failed");
  process.exitCode = 1;
});
