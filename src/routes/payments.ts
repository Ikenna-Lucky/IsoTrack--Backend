import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { createHmac } from "crypto";
import { authenticate, requireRole } from "@/middleware/auth";
import { db } from "@/db";
import { payments, shipments, businesses } from "@/db/schema";
import { findShipmentById } from "@/db/queries/shipments";
import { success, error } from "@/lib/response";
import { env } from "@/lib/env";

export const paymentsRouter = new Hono();

// ─── Paystack helpers ──────────────────────────────────────────────────────────

const PAYSTACK_BASE = "https://api.paystack.co";

async function paystackPost(path: string, body: Record<string, unknown>) {
  const res = await fetch(`${PAYSTACK_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<Record<string, unknown>>;
}

async function paystackGet(path: string) {
  const res = await fetch(`${PAYSTACK_BASE}${path}`, {
    headers: { Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}` },
  });
  return res.json() as Promise<Record<string, unknown>>;
}

// ─── POST /initialize ─────────────────────────────────────────────────────────
// Business initialises a Paystack transaction for a shipment.
// Returns: { reference, authorizationUrl, accessCode, amountKobo }

paymentsRouter.post(
  "/initialize",
  authenticate,
  requireRole("business"),
  zValidator("json", z.object({ shipmentId: z.string().min(1) })),
  async (c) => {
    if (!env.PAYSTACK_SECRET_KEY) {
      return error(c, "Payment provider not configured", 500);
    }

    const { shipmentId } = c.req.valid("json");
    const user = c.get("user") as { id: string; email: string };

    // Load shipment
    const shipment = await findShipmentById(shipmentId);
    if (!shipment) return error(c, "Shipment not found", 404);

    // Verify the requester owns this shipment's business
    const [ownerBiz] = await db
      .select({ id: businesses.id })
      .from(businesses)
      .where(eq(businesses.userId, user.id))
      .limit(1);

    if (!ownerBiz || shipment.businessId !== ownerBiz.id) {
      return error(c, "Not authorised to pay for this shipment", 403);
    }

    if (shipment.isPaid) {
      return error(c, "This shipment is already paid", 409);
    }

    // Reuse existing pending payment or create a fresh one
    let existingPayment = shipment.payment ?? null;

    if (!existingPayment || existingPayment.status === "failed") {
      const [created] = await db
        .insert(payments)
        .values({
          id: nanoid(),
          shipmentId: shipment.id,
          amountKobo: shipment.priceKobo,
          status: "pending",
        })
        .returning();
      if (!created) return error(c, "Failed to create payment record", 500);
      existingPayment = created;
    }

    // Build a unique reference and call Paystack
    const reference = `iso_${existingPayment.id}_${Date.now()}`;
    const paystackRes = await paystackPost("/transaction/initialize", {
      email: user.email,
      amount: shipment.priceKobo,
      reference,
      metadata: {
        shipmentId: shipment.id,
        trackingId: shipment.trackingId,
        paymentId: existingPayment.id,
      },
    });

    if (!paystackRes.status) {
      return error(c, (paystackRes.message as string) ?? "Paystack error", 500);
    }

    // Persist the Paystack reference
    await db
      .update(payments)
      .set({ paystackReference: reference, updatedAt: new Date() })
      .where(eq(payments.id, existingPayment.id));

    const txData = paystackRes.data as Record<string, unknown>;
    return success(c, {
      data: {
        reference,
        authorizationUrl: txData.authorization_url as string,
        accessCode: txData.access_code as string,
        amountKobo: shipment.priceKobo,
      },
    });
  },
);

// ─── GET /verify/:reference ───────────────────────────────────────────────────
// Frontend calls this after the Paystack popup closes to confirm payment.

paymentsRouter.get(
  "/verify/:reference",
  authenticate,
  requireRole("business"),
  async (c) => {
    if (!env.PAYSTACK_SECRET_KEY) {
      return error(c, "Payment provider not configured", 500);
    }

    const reference = c.req.param("reference")!;

    const paystackRes = await paystackGet(`/transaction/verify/${reference}`);
    if (!paystackRes.status) {
      return error(
        c,
        (paystackRes.message as string) ?? "Verification failed",
        500,
      );
    }

    const txData = paystackRes.data as Record<string, unknown>;
    const txStatus = txData.status as string;

    // Find our local payment record
    const [payment] = await db
      .select()
      .from(payments)
      .where(eq(payments.paystackReference, reference))
      .limit(1);

    if (!payment) return error(c, "Payment record not found", 404);

    if (txStatus === "success") {
      await db
        .update(payments)
        .set({
          status: "success",
          channel: txData.channel as string,
          paidAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(payments.id, payment.id));

      await db
        .update(shipments)
        .set({ isPaid: true, updatedAt: new Date() })
        .where(eq(shipments.id, payment.shipmentId));

      return success(c, {
        data: { paid: true, channel: txData.channel, reference },
        message: "Payment verified successfully",
      });
    }

    return success(c, {
      data: { paid: false, status: txStatus, reference },
    });
  },
);

// ─── POST /webhook ────────────────────────────────────────────────────────────
// Paystack POSTs events here. We verify the HMAC-SHA512 signature before acting.
// This route must be registered WITHOUT the global body-parser so we can read
// the raw body. Hono reads raw text via c.req.text().

paymentsRouter.post("/webhook", async (c) => {
  if (!env.PAYSTACK_SECRET_KEY) return c.text("ok", 200);

  const signature = c.req.header("x-paystack-signature") ?? "";
  const rawBody = await c.req.text();

  const hash = createHmac("sha512", env.PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest("hex");

  if (hash !== signature) {
    return c.text("Invalid signature", 400);
  }

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return c.text("Bad JSON", 400);
  }

  // Handle successful charge
  if (event.event === "charge.success") {
    const txData = event.data as Record<string, unknown>;
    const reference = txData.reference as string;

    const [payment] = await db
      .select()
      .from(payments)
      .where(eq(payments.paystackReference, reference))
      .limit(1);

    if (payment && payment.status !== "success") {
      await db
        .update(payments)
        .set({
          status: "success",
          channel: txData.channel as string,
          paidAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(payments.id, payment.id));

      await db
        .update(shipments)
        .set({ isPaid: true, updatedAt: new Date() })
        .where(eq(shipments.id, payment.shipmentId));
    }
  }

  // Always return 200 so Paystack doesn't retry
  return c.text("ok", 200);
});
