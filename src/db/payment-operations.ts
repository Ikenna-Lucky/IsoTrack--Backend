import { sql } from "drizzle-orm";
import { writeStore } from "../services/write-store";
import { paymentLifecycle } from "../services/payments";

async function main() {
  const [command, reference, sessionId, operator] = process.argv.slice(2);
  if (command === "status") {
    console.log(
      JSON.stringify(
        await writeStore.execute(sql`select jsonb_build_object('reference',provider_reference,
      'shipmentId',shipment_id,'amountKobo',amount_kobo,'status',status,'checkoutState',checkout_state,
      'reviewReason',review_reason,'receivedAt',received_at,'reconcileAfter',reconcile_after) as result
      from payments where provider='stripe' and (status='pending' or review_reason is not null)
      order by created_at limit 100`),
        null,
        2,
      ),
    );
    return;
  }
  if (!paymentLifecycle) throw new Error("Stripe configuration missing");
  if (command === "reconcile" && reference)
    await paymentLifecycle.reconcile(reference);
  else if (command === "attach" && reference && sessionId?.startsWith("cs_"))
    await paymentLifecycle.attach(reference, sessionId);
  else if (command === "record-refund" && reference && sessionId && operator)
    await paymentLifecycle.recordRefund(reference, sessionId, operator);
  else
    throw new Error(
      "Expected status, reconcile REFERENCE, attach REFERENCE SESSION_ID, or record-refund REFERENCE REFUND_ID OPERATOR",
    );
  console.log("Payment reconciliation completed");
}
main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Payment operation failed",
  );
  process.exitCode = 1;
});
