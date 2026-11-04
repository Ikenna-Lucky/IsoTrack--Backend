import { writeStore } from "../services/write-store";
import {
  deliveryStatus,
  purgeDeliveryConfirmations,
} from "./queries/delivery-operations";
async function main() {
  const command = process.argv[2];
  if (command !== "status" && command !== "purge")
    throw new Error("Expected status or purge");
  const rows = await writeStore.execute(
    command === "status" ? deliveryStatus() : purgeDeliveryConfirmations(),
  );
  console.log(
    JSON.stringify(
      command === "status" ? rows : { removed: rows.length },
      null,
      2,
    ),
  );
}
main().catch(() => {
  console.error("Delivery operation failed");
  process.exitCode = 1;
});
