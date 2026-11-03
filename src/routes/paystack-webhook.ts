import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { SuccessfulPayment } from "@/lib/paystack-payload";

interface Dependencies {
  secret: string | undefined;
  confirm: (payment: SuccessfulPayment) => Promise<boolean>;
}

const chargeSchema = z.object({
  reference: z.string().min(1).max(200), status: z.literal("success"),
  amount: z.number().int().positive().max(2_147_483_647), currency: z.string().length(3),
  channel: z.string().min(1).max(50), paid_at: z.string().datetime({ offset: true }),
});

export function createPaystackWebhookRouter(dependencies: Dependencies) {
  const router = new Hono();
  router.post("/webhook", bodyLimit({ maxSize: 262_144 }), async (c) => {
    if (!dependencies.secret) return c.text("Payments unavailable", 503);
    const signature = c.req.header("x-paystack-signature");
    if (!signature || !/^[a-f0-9]{128}$/i.test(signature)) return c.text("Invalid signature", 401);
    const body = Buffer.from(await c.req.arrayBuffer());
    const expected = createHmac("sha512", dependencies.secret).update(body).digest();
    if (!timingSafeEqual(Buffer.from(signature, "hex"), expected)) return c.text("Invalid signature", 401);

    let raw: unknown;
    try { raw = JSON.parse(body.toString("utf8")); }
    catch { return c.text("Invalid event", 400); }
    const envelope = z.object({ event: z.string(), data: z.unknown() }).safeParse(raw);
    if (!envelope.success) return c.text("Invalid event", 400);
    if (envelope.data.event !== "charge.success") return c.text("OK", 200);
    const charge = chargeSchema.safeParse(envelope.data.data);
    if (!charge.success) return c.text("Invalid charge", 400);
    const data = charge.data;
    const confirmed = await dependencies.confirm({ reference: data.reference,
      amountKobo: data.amount, currency: data.currency, channel: data.channel, paidAt: data.paid_at });
    // Never acknowledge an unrecorded success: transient storage races need retry.
    if (!confirmed) return c.text("Payment could not be matched", 409);
    return c.text("OK", 200);
  });
  return router;
}
