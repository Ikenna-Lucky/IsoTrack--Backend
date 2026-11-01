import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { createHmac } from "crypto";
import { authenticate } from "@/middleware/auth";
import { db } from "@/db";
import { payments, shipments, users } from "@/db/schema";
import { findShipmentById } from "@/db/queries/shipments";
import { success, error } from "@/lib/response";
import { env } from "@/lib/env";

export const paymentsRouter = new Hono();

// All payment routes require authentication
paymentsRouter.use("*", authenticate);

// ─── POST /payments/initialize ────────────────────────────────────────────────
// Any authenticated user (customer OR business) can initialize payment.

paymentsRouter.post(
  "/initialize",
  zValidator("json", z.object({ shipmentId: z.string().min(1) })),
  async (c) => {
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

    const paystackRes = await fetch(
      "https://api.paystack.co/transaction/initialize",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: userRow.email,
          amount: amountKobo,
          reference,
          metadata: { shipmentId, trackingId: shipment.trackingId },
        }),
      },
    );

    if (!paystackRes.ok) {
      const text = await paystackRes.text();
      console.error("[Paystack] initialize failed:", text);
      return error(c, "Payment provider error. Please try again.", 500);
    }

    const psData = (await paystackRes.json()) as {
      data: {
        reference: string;
        authorization_url: string;
        access_code: string;
      };
    };

    await db.insert(payments).values({
      id: nanoid(),
      shipmentId,
      paystackReference: reference,
      amountKobo,
      status: "pending",
    });

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

  const paystackRes = await fetch(
    `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
    { headers: { Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}` } },
  );

  if (!paystackRes.ok) return error(c, "Verification failed", 500);

  const psData = (await paystackRes.json()) as {
    data: { status: string; channel: string; reference: string };
  };

  const paid = psData.data.status === "success";

  if (paid) {
    await db
      .update(payments)
      .set({
        status: "success",
        channel: psData.data.channel,
        paidAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(payments.paystackReference, reference));

    const [payment] = await db
      .select({ shipmentId: payments.shipmentId })
      .from(payments)
      .where(eq(payments.paystackReference, reference))
      .limit(1);

    if (payment) {
      await db
        .update(shipments)
        .set({ isPaid: true, updatedAt: new Date() })
        .where(eq(shipments.id, payment.shipmentId));
    }
  }

  return success(c, {
    data: {
      paid,
      reference: psData.data.reference,
      channel: psData.data.channel,
      status: psData.data.status,
    },
  });
});

// ─── POST /payments/webhook ───────────────────────────────────────────────────

paymentsRouter.post("/webhook", async (c) => {
  const signature = c.req.header("x-paystack-signature") ?? "";
  const body = await c.req.text();

  const expected = createHmac("sha512", env.PAYSTACK_SECRET_KEY ?? "")
    .update(body)
    .digest("hex");

  if (signature !== expected) return c.text("Invalid signature", 401);

  const event = JSON.parse(body) as {
    event: string;
    data: { reference: string; channel: string };
  };

  if (event.event === "charge.success") {
    const { reference, channel } = event.data;

    await db
      .update(payments)
      .set({
        status: "success",
        channel,
        paidAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(payments.paystackReference, reference));

    const [payment] = await db
      .select({ shipmentId: payments.shipmentId })
      .from(payments)
      .where(eq(payments.paystackReference, reference))
      .limit(1);

    if (payment) {
      await db
        .update(shipments)
        .set({ isPaid: true, updatedAt: new Date() })
        .where(eq(shipments.id, payment.shipmentId));
    }
  }

  return c.text("OK", 200);
});
