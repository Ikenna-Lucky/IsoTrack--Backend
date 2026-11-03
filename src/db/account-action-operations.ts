import { sql } from "drizzle-orm";
import { writeStore } from "@/services/write-store";
import { purgeAccountActions } from "./queries/account-actions";

async function main() {
  const command = process.argv[2];
  if (command !== "status" && command !== "purge")
    throw new Error("Expected status or purge");
  const rows = await writeStore.execute(
    command === "purge"
      ? purgeAccountActions()
      : sql`
    select json_build_object('purpose',purpose,'state',delivery_state,'count',count(*)) as result
      from account_actions group by purpose,delivery_state order by purpose,delivery_state`,
  );
  console.log(JSON.stringify(rows, null, 2));
}
main().catch(() => {
  console.error("Account action operation failed");
  process.exitCode = 1;
});
