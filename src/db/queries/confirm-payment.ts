import { sql } from "drizzle-orm";
import type { SuccessfulPayment } from "@/lib/stripe-payload";

export function confirmPaymentStatement(payment: SuccessfulPayment) {
  return sql`select id from (select confirm_stripe_payment(${payment.reference},${payment.sessionId},
    ${payment.amountKobo},${payment.currency},${payment.channel},${payment.paidAt}::timestamptz) as id) confirmed where id is not null`;
}
