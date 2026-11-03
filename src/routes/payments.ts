import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { createPaystackWebhookRouter } from "./paystack-webhook";
import { confirmPaymentStatement } from "@/db/queries/confirm-payment";
import { parsePaystackVerification, type SuccessfulPayment } from "@/lib/paystack-payload";
import { authenticate, requireRole } from "@/middleware/auth";
import { db } from "@/db";
import { payments, users } from "@/db/schema";
import { findShipmentById } from "@/db/queries/shipments";
import { success, error } from "@/lib/response";
import { env } from "@/lib/env";

export const paymentsRouter = new Hono();

async function confirmPayment(payment: SuccessfulPayment) {
  const result = await db.execute(confirmPaymentStatement(payment));
  return result.rows.length > 0;
}

paymentsRouter.route("/", createPaystackWebhookRouter({ secret: env.PAYSTACK_SECRET_KEY, confirm: confirmPayment }));
paymentsRouter.use("*", authenticate, requireRole("business", "customer"));

// ─── POST /payments/initialize ────────────────────────────────────────────────
// Any authenticated user (customer OR business) can initialize payment.

paymentsRouter.post(
  "/initialize",
  zValidator("json", z.object({ shipmentId: z.string().min(1) })),
  async (c) => {
    if (!env.PAYSTACK_SECRET_KEY) return error(c, "Payments unavailable", 503);
    const { shipmentId } = c.req.valid("json");
    const userId = c.get("userId");

    const shipment = await findShipmentById(shipmentId, { userId: c.get("userId"), role: c.get("userRole") });
    if (!shipment) return error(c, "Shipment not found", 404);
    if (shipment.isPaid) return error(c, "Shipment is already paid", 400);

    const [userRow] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!userRow) return error(c, "User not found", 404);

    const amountKobo = shipment.priceKobo;
    const reference = `IST-PAY-${nanoid(12).toUpperCase()}`;

    await db.insert(payments).values({
      id: nanoid(),
      shipmentId,
      paystackReference: reference,
      amountKobo,
      status: "pending",
    });

    let paystackRes: Response;
    try { paystackRes = await fetch(
      "https://api.paystack.co/transaction/initialize",
      {
        method: "POST",
        signal: AbortSignal.timeout(10000),
        headers: {
          Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          currency: "NGN",
          email: userRow.email,
          amount: amountKobo,
          reference,
          metadata: { shipmentId, trackingId: shipment.trackingId },
        }),
      },
    ); } catch { return error(c, "Payment provider unavailable", 502); }

    if (!paystackRes.ok) {
      return error(c, "Payment provider error. Please try again.", 502);
    }

    let raw: unknown;
    try { raw = await paystackRes.json(); }
    catch { return error(c, "Invalid payment provider response", 502); }
    const parsed = z.object({ status: z.literal(true), data: z.object({
      reference: z.literal(reference), authorization_url: z.string().url().startsWith("https://"),
      access_code: z.string().min(1),
    }) }).safeParse(raw);
    if (!parsed.success) return error(c, "Invalid payment provider response", 502);
    const psData = parsed.data;

    return success(c, {
      data: {
        reference: psData.data.reference,
        authorizationUrl: psData.data.authorization_url,
        accessCode: psData.data.access_code,
        amountKobo,
      },
    });
  },
);

// ─── GET /payments/verify/:reference ─────────────────────────────────────────

paymentsRouter.get("/verify/:reference", async (c) => {
  const { reference } = c.req.param();
  const [payment] = await db.select({ shipmentId: payments.shipmentId }).from(payments)
    .where(eq(payments.paystackReference, reference)).limit(1);
  if (!payment) return error(c, "Payment not found", 404);
  const shipment = await findShipmentById(payment.shipmentId, {
    userId: c.get("userId"), role: c.get("userRole"),
  });
  if (!shipment) return error(c, "Payment not found", 404);
  if (!env.PAYSTACK_SECRET_KEY) return error(c, "Payments unavailable", 503);

  let response: Response;
  try {
    response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}` },
      signal: AbortSignal.timeout(10000),
    });
  } catch { return error(c, "Payment provider unavailable", 502); }
  if (!response.ok) return error(c, "Verification failed", 502);
  let raw: unknown;
  try { raw = await response.json(); }
  catch { return error(c, "Invalid payment provider response", 502); }
  const verified = parsePaystackVerification(raw, reference);
  if (!verified) {
    return error(c, "Invalid payment provider response", 502);
  }
  if (verified.charge) {
    const confirmed = await confirmPayment(verified.charge);
    if (!confirmed) return error(c, "Payment details do not match the shipment", 409);
  }
  return success(c, { data: { paid: verified.paid, reference, channel: verified.channel, status: verified.status } });
});
