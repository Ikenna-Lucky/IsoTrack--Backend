import Stripe from "stripe";
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { nanoid } from "nanoid";
import { and, eq, or, isNull } from "drizzle-orm";
import { createStripeWebhookRouter } from "./stripe-webhook";
import { confirmPaymentStatement } from "@/db/queries/confirm-payment";
import { parseStripeSession, type SuccessfulPayment } from "@/lib/stripe-payload";
import { authenticate, requireRole } from "@/middleware/auth";
import { db } from "@/db";
import { payments } from "@/db/schema";
import { findShipmentById } from "@/db/queries/shipments";
import { success, error } from "@/lib/response";
import { env } from "@/lib/env";

const stripe = env.STRIPE_SECRET_KEY ? new Stripe(env.STRIPE_SECRET_KEY, {
  apiVersion: "2026-10-28.endive", timeout: 10000, maxNetworkRetries: 1,
}) : null;
export const paymentsRouter = new Hono();
async function confirmPayment(payment: SuccessfulPayment) {
  const result = await db.execute(confirmPaymentStatement(payment));
  return result.rows.length > 0;
}
paymentsRouter.route("/", createStripeWebhookRouter({
  secret: env.STRIPE_WEBHOOK_SECRET, expectedLiveMode: /^(sk|rk)_live_/.test(env.STRIPE_SECRET_KEY ?? ""),
  parseSession: (session, paidAt) => parseStripeSession(session, undefined, paidAt), confirm: confirmPayment,
}));
paymentsRouter.use("*", authenticate, requireRole("business", "customer"));

paymentsRouter.post("/initialize", zValidator("json", z.object({ shipmentId: z.string().min(1) }).strict()), async (c) => {
  if (!stripe) return error(c, "Payments unavailable", 503);
  const shipment = await findShipmentById(c.req.valid("json").shipmentId, {
    userId: c.get("userId"), role: c.get("userRole"),
  });
  if (!shipment) return error(c, "Shipment not found", 404);
  if (shipment.isPaid || ["cancelled", "failed"].includes(shipment.status)) return error(c, "Shipment is not payable", 409);
  const reference = `IST-PAY-${nanoid(24)}`;
  await db.insert(payments).values({ id: nanoid(), shipmentId: shipment.id, reference,
    provider: "stripe", amountKobo: shipment.priceKobo, status: "pending" });
  const returnUrl = new URL("/customer/shipments", env.FRONTEND_URL);
  returnUrl.searchParams.set("payment_reference", reference);
  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: "payment", ui_mode: "hosted_page", allowed_payment_method_types: ["card"], customer_email: c.get("user").email,
      client_reference_id: reference, metadata: { reference, shipmentId: shipment.id },
      line_items: [{ quantity: 1, price_data: { currency: "ngn", unit_amount: shipment.priceKobo,
        product_data: { name: `Shipment ${shipment.trackingId}` } } }],
      success_url: returnUrl.toString(), cancel_url: new URL("/customer/shipments?payment_cancelled=1", env.FRONTEND_URL).toString(),
    }, { idempotencyKey: reference });
  } catch { return error(c, "Payment provider unavailable", 502); }
  if (!session.url || !parseStripeSession(session, reference)) return error(c, "Invalid checkout response", 502);
  const attached = await db.update(payments).set({ stripeSessionId: session.id, updatedAt: new Date() })
    .where(and(eq(payments.reference, reference), eq(payments.provider, "stripe"),
      or(isNull(payments.stripeSessionId), eq(payments.stripeSessionId, session.id))))
    .returning({ id: payments.id });
  if (!attached[0]) return error(c, "Checkout session could not be attached", 409);
  return success(c, { data: { reference, authorizationUrl: session.url, sessionId: session.id, amountKobo: shipment.priceKobo } });
});

paymentsRouter.get("/verify/:reference", async (c) => {
  const reference = c.req.param("reference");
  const [payment] = await db.select().from(payments).where(and(eq(payments.reference, reference), eq(payments.provider, "stripe"))).limit(1);
  if (!payment) return error(c, "Payment not found", 404);
  if (!await findShipmentById(payment.shipmentId, { userId: c.get("userId"), role: c.get("userRole") })) {
    return error(c, "Payment not found", 404);
  }
  if (!stripe) return error(c, "Payments unavailable", 503);
  if (!payment.stripeSessionId) return error(c, "Checkout session is not available yet", 409);
  let session: Stripe.Checkout.Session;
  try { session = await stripe.checkout.sessions.retrieve(payment.stripeSessionId); }
  catch { return error(c, "Payment provider unavailable", 502); }
  const verified = parseStripeSession(session, reference);
  if (!verified || session.livemode !== /^(sk|rk)_live_/.test(env.STRIPE_SECRET_KEY ?? "")) return error(c, "Invalid checkout response", 502);
  if (verified.charge && !await confirmPayment(verified.charge)) return error(c, "Payment details do not match", 409);
  return success(c, { data: { paid: verified.paid, reference, channel: verified.channel, status: verified.status } });
});
