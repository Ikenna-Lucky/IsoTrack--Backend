import { db } from "@/db";
import { purgeExpiredSessionsStatement } from "./queries/session-statements";

async function purge() {
  let deleted = 0;
  for (let batch = 0; batch < 20; batch++) {
    const result = await db.execute(purgeExpiredSessionsStatement());
    deleted += result.rows.length;
    if (result.rows.length < 5000) break;
  }
  console.info(JSON.stringify({ event: "auth_sessions_purged", deleted }));
}

purge().catch((error: unknown) => {
  console.error("Session cleanup failed", error);
  process.exitCode = 1;
});
