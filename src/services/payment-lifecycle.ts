import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type Stripe from "stripe";
import type { WriteStore } from "../lib/idempotency";
import { parseStripeSession } from "../lib/stripe-payload.ts";
import { confirmPaymentStatement } from "../db/queries/confirm-payment.ts";

interface Dependencies {
  store: WriteStore;
  providerContext: string;
  liveMode: boolean;
  client: Stripe;
}

export function createPaymentLifecycle({
  store,
  client,
  providerContext,
  liveMode,
}: Dependencies) {
  async function payment(reference: string) {
    return (
      await store.execute(sql`select jsonb_build_object('id',p.id,'shipmentId',p.shipment_id,
      'amount',p.amount_kobo,'sessionId',p.stripe_session_id,'state',p.checkout_state,'status',p.status,
      'payable',not s.is_paid and s.status not in ('cancelled','failed') and s.price_kobo=p.amount_kobo,
      'requestId',r.id,'parameters',r.parameters,'providerSafe',r.created_at+interval '23 hours'>statement_timestamp()) as result
      from payments p join shipments s on s.id=p.shipment_id
      left join idempotency_requests r on r.resource_id=p.id and r.operation='payments.initialize'
      where p.provider='stripe' and p.provider_reference=${reference}`)
    )[0];
  }

  async function observe(raw: unknown, paidAt?: string) {
    const parsed = parseStripeSession(raw, undefined, paidAt);
    if (!parsed) throw new Error("Invalid checkout session");
    const session = raw as Stripe.Checkout.Session;
    const row = await payment(parsed.reference);
    if (
      !row ||
      row.amount !== session.amount_total ||
      session.currency !== "ngn" ||
      session.metadata?.shipmentId !== row.shipmentId ||
      session.livemode !== liveMode ||
      (row.sessionId && row.sessionId !== session.id)
    )
      throw new Error("Unmatched checkout session");
    if (parsed.charge) {
      if (row.status === "refunded") return parsed;
      const result = await store.execute(
        sql`select jsonb_build_object('id',id) as result from (${confirmPaymentStatement(parsed.charge)}) confirmed`,
      );
      if (!result.length) throw new Error("Unmatched payment receipt");
    } else if (
      (session.status === "expired" ||
        (session.status === "complete" && session.payment_intent)) &&
      session.payment_status === "unpaid"
    ) {
      // An attached PaymentIntent can remain unsettled independently of Checkout.
      // Keep the guard until its state also proves that no payment is processing.
      if (session.payment_intent) {
        const id =
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : session.payment_intent.id;
        const intent = await client.paymentIntents.retrieve(id);
        if (
          intent.livemode !== liveMode ||
          intent.amount !== row.amount ||
          intent.amount_received > 0 ||
          intent.currency !== "ngn" ||
          !(
            intent.status === "canceled" ||
            (session.status === "expired" &&
              intent.status === "requires_payment_method")
          )
        ) {
          await saveUnpaid(String(row.id), session, true);
          return parsed;
        }
      }
      await store.execute(
        sql`select jsonb_build_object('closed',close_stripe_checkout(${parsed.reference},${session.id},${session.amount_total},${session.status === "expired" ? "expired" : "failed"})) as result`,
      );
    } else {
      await saveUnpaid(String(row.id), session, session.status === "complete");
    }
    return parsed;
  }

  async function saveUnpaid(
    id: string,
    session: Stripe.Checkout.Session,
    processing: boolean,
  ) {
    await store.execute(sql`update payments set stripe_session_id=${session.id},
      checkout_state=${processing ? "processing" : "open"},updated_at=statement_timestamp()
      where id=${id} and status='pending' and checkout_state not in ('expired','review')
      and (stripe_session_id is null or stripe_session_id=${session.id}) returning jsonb_build_object('id',id) as result`);
  }

  async function reconcile(reference: string, cancel = false) {
    const row = await payment(reference);
    if (!row) throw new Error("Payment not found");
    let session: Stripe.Checkout.Session;
    if (typeof row.sessionId === "string")
      session = await client.checkout.sessions.retrieve(row.sessionId);
    else {
      const parameters = row.parameters as Record<string, unknown> | null;
      if (
        !row.providerSafe ||
        !row.requestId ||
        parameters?.providerContext !== providerContext ||
        !parameters.params
      )
        throw new Error(
          "Manual reconciliation required: original provider retry window or configuration unavailable",
        );
      // Retry with the original parameters and key: the first request may have succeeded.
      session = await client.checkout.sessions.create(parameters.params, {
        idempotencyKey: `isotrack_${String(row.requestId)}`,
      });
    }
    // Validate before asking the provider to mutate this session.
    const parsed = parseStripeSession(session, reference);
    if (
      !parsed ||
      session.metadata?.shipmentId !== row.shipmentId ||
      session.amount_total !== row.amount ||
      session.currency !== "ngn" ||
      session.livemode !== liveMode
    )
      throw new Error("Invalid checkout response");
    if ((cancel || !row.payable) && session.status === "open") {
      try {
        session = await client.checkout.sessions.expire(session.id);
      } catch {
        session = await client.checkout.sessions.retrieve(session.id);
      }
    }
    return observe(session);
  }

  // Operator recovery only attaches a provider object after the same amount,
  // mode, shipment and reference checks used by signed webhooks.
  async function attach(reference: string, sessionId: string) {
    const session = await client.checkout.sessions.retrieve(sessionId);
    if (!parseStripeSession(session, reference))
      throw new Error("Session reference does not match");
    return observe(session);
  }

  async function recordRefund(
    reference: string,
    refundId: string,
    operator: string,
  ) {
    if (
      !operator.trim() ||
      operator.length > 128 ||
      !refundId.startsWith("re_")
    )
      throw new Error("Refund and operator identity required");
    const row = await payment(reference);
    if (!row || typeof row.sessionId !== "string")
      throw new Error("Reconcile the original payment first");
    const session = await client.checkout.sessions.retrieve(row.sessionId);
    if (
      !parseStripeSession(session, reference) ||
      session.metadata?.shipmentId !== row.shipmentId ||
      session.livemode !== liveMode ||
      session.amount_total !== row.amount ||
      session.currency !== "ngn"
    )
      throw new Error("Payment session mismatch");
    const intent =
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id;
    const refund = await client.refunds.retrieve(refundId);
    const refundedIntent =
      typeof refund.payment_intent === "string"
        ? refund.payment_intent
        : refund.payment_intent?.id;
    if (
      !intent ||
      intent !== refundedIntent ||
      refund.status !== "succeeded" ||
      refund.amount !== row.amount ||
      refund.currency !== "ngn"
    )
      throw new Error(
        "Only a verified, successful full refund of this payment can resolve review",
      );
    const result =
      await store.execute(sql`with resolved as (update payments set status='refunded',refund_id=${refundId},
      refund_recorded_by=${operator},refund_recorded_at=statement_timestamp(),updated_at=statement_timestamp()
      where id=${row.id as string} and review_reason is not null and received_at is not null
      and refund_id is null returning id,shipment_id), released as (
        delete from payment_checkout_guards g using resolved r where g.shipment_id=r.shipment_id
        and (g.payment_id=r.id or (g.payment_id is null and not exists(
          select 1 from payments p where p.shipment_id=g.shipment_id and p.provider='stripe' and p.status='pending' and p.id<>r.id)))
        returning g.shipment_id)
      select jsonb_build_object('id',id) as result from resolved`);
    if (!result.length)
      throw new Error("Review is missing or already resolved");
  }

  async function sweep() {
    const token = randomUUID();
    const rows =
      await store.execute(sql`with due as (select id from payments where provider='stripe' and status='pending'
      and checkout_state<>'review' and reconcile_after<=statement_timestamp()
      and (reconcile_until is null or reconcile_until<=statement_timestamp())
      order by reconcile_after limit 10 for update skip locked)
      update payments p set reconcile_token=${token},reconcile_until=statement_timestamp()+interval '5 minutes'
      from due where p.id=due.id returning jsonb_build_object('id',p.id,'reference',p.provider_reference) as result`);
    let failed = 0;
    // Two provider calls in flight per process; PostgreSQL leases coordinate replicas.
    for (let offset = 0; offset < rows.length; offset += 2) {
      const outcomes = await Promise.allSettled(
        rows.slice(offset, offset + 2).map(async (row) => {
          try {
            await reconcile(String(row.reference));
          } catch {
            failed++;
          } finally {
            await store.execute(sql`update payments set reconcile_token=null,reconcile_until=null,
          reconcile_after=statement_timestamp()+interval '5 minutes' where id=${row.id as string} and reconcile_token=${token}
          returning jsonb_build_object('id',id) as result`);
          }
        }),
      );
      if (outcomes.some((result) => result.status === "rejected"))
        throw new Error("Payment reconciliation storage unavailable");
    }
    return { attempted: rows.length, failed };
  }
  return { observe, reconcile, sweep, attach, recordRefund };
}
