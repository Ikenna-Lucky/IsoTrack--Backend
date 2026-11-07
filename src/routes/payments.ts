import { stripe } from "@/lib/stripe";
import { paymentLifecycle } from "@/services/payments";
import { writes } from "@/services/writes";
import { createCheckoutInitializationRouter } from "./idempotent-writes";
import type Stripe from "stripe";
import { Hono } from "hono";

import { and, eq } from "drizzle-orm";
import { createStripeWebhookRouter } from "./stripe-webhook";
import { confirmPaymentStatement } from "@/db/queries/confirm-payment";
import {
  parseStripeSession,
  type SuccessfulPayment,
} from "@/lib/stripe-payload";
import { authenticate, requireRole } from "@/middleware/auth";
import { db } from "@/db";
import { payments } from "@/db/schema";
import { findShipmentById } from "@/db/queries/shipments";
import { success, error } from "@/lib/response";
import { env } from "@/lib/env";
import { apiProtection } from "../services/api-protection";

export const paymentsRouter = new Hono();
async function confirmPayment(payment: SuccessfulPayment) {
  const result = await db.execute(confirmPaymentStatement(payment));
  return result.rows.length > 0;
}
paymentsRouter.route(
  "/",
  createStripeWebhookRouter({
    secret: paymentLifecycle ? env.STRIPE_WEBHOOK_SECRET : undefined,
    expectedLiveMode: false,
    parseSession: (session, paidAt) =>
      parseStripeSession(session, undefined, paidAt),
    confirm: confirmPayment,
    observe: (session, paidAt) => paymentLifecycle!.observe(session, paidAt),
  }),
);
paymentsRouter.use(
  "*",
  apiProtection("payments", "peer"),
  authenticate,
  requireRole("business", "customer"),
  apiProtection("payments", "account"),
);

paymentsRouter.route(
  "/",
  createCheckoutInitializationRouter({
    authorize: requireRole("business", "customer"),
    writes,
  }),
);

paymentsRouter.get("/verify/:reference", async (c) => {
  const reference = c.req.param("reference");
  const [payment] = await db
    .select()
    .from(payments)
    .where(
      and(eq(payments.reference, reference), eq(payments.provider, "stripe")),
    )
    .limit(1);
  if (!payment) return error(c, "Payment not found", 404);
  if (
    !(await findShipmentById(payment.shipmentId, {
      userId: c.get("userId"),
      role: c.get("userRole"),
    }))
  ) {
    return error(c, "Payment not found", 404);
  }
  if (!stripe) return error(c, "Payments unavailable", 503);
  if (!payment.stripeSessionId)
    return error(c, "Checkout session is not available yet", 409);
  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.retrieve(payment.stripeSessionId);
  } catch {
    return error(c, "Payment provider unavailable", 502);
  }
  const verified = parseStripeSession(session, reference);
  if (!verified || session.livemode !== false)
    return error(c, "Invalid checkout response", 502);
  await paymentLifecycle!.observe(session);
  const [current] = await db
    .select()
    .from(payments)
    .where(eq(payments.id, payment.id))
    .limit(1);
  return success(c, {
    data: {
      paid: verified.paid,
      reference,
      channel: verified.channel,
      status: verified.status,
      applied: current?.status === "success" && !current.reviewReason,
      checkoutState: current?.checkoutState,
      requiresReview:
        Boolean(current?.reviewReason) && current?.status !== "refunded",
    },
  });
});

paymentsRouter.post("/:reference/cancel", async (c) => {
  const reference = c.req.param("reference");
  const [payment] = await db
    .select()
    .from(payments)
    .where(
      and(eq(payments.reference, reference), eq(payments.provider, "stripe")),
    )
    .limit(1);
  if (
    !payment ||
    !(await findShipmentById(payment.shipmentId, {
      userId: c.get("userId"),
      role: c.get("userRole"),
    }))
  )
    return error(c, "Payment not found", 404);
  if (!paymentLifecycle) return error(c, "Payments unavailable", 503);
  try {
    await paymentLifecycle.reconcile(reference, true);
    const [current] = await db
      .select()
      .from(payments)
      .where(eq(payments.id, payment.id))
      .limit(1);
    return success(c, {
      data: {
        reference,
        checkoutState: current?.checkoutState,
        requiresReview:
          Boolean(current?.reviewReason) && current?.status !== "refunded",
      },
    });
  } catch {
    return error(
      c,
      "Cancellation could not be confirmed; verify the original payment before retrying",
      502,
    );
  }
});
