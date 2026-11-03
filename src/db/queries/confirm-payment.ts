import { sql } from "drizzle-orm";
import type { SuccessfulPayment } from "@/lib/stripe-payload";

export function confirmPaymentStatement(payment: SuccessfulPayment) {
  return sql`with matched as materialized (
    select p.id, p.shipment_id, p.status from payments p
    join shipments s on s.id = p.shipment_id
    where p.provider_reference = ${payment.reference} and p.provider = 'stripe'
      and (p.stripe_session_id is null or p.stripe_session_id = ${payment.sessionId})
      and p.amount_kobo = ${payment.amountKobo} and s.price_kobo = ${payment.amountKobo}
      and ${payment.currency} = 'NGN' and p.status in ('pending', 'success')
    for update of p, s
  ), confirmed as (
    update payments p set status = 'success', stripe_session_id = ${payment.sessionId}, channel = ${payment.channel},
      paid_at = ${payment.paidAt}::timestamptz, updated_at = statement_timestamp()
    from matched where p.id = matched.id and p.status = 'pending'
    returning p.shipment_id
  ), paid_shipment as (
    update shipments s set is_paid = true, updated_at = statement_timestamp()
    where s.is_paid = false and s.id in (
      select shipment_id from confirmed union
      select shipment_id from matched where status = 'success'
    ) returning id
  ) select id from matched`;
}
