import Stripe from "stripe";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { SuccessfulPayment } from "@/lib/stripe-payload";

interface Dependencies {
  secret: string | undefined;
  expectedLiveMode: boolean;
  parseSession: (
    session: unknown,
    paidAt: string,
  ) => { charge: SuccessfulPayment | null } | null;
  confirm: (payment: SuccessfulPayment) => Promise<boolean>;
  observe?: (session: unknown, paidAt: string) => Promise<unknown>;
}

export function createStripeWebhookRouter(dependencies: Dependencies) {
  const router = new Hono();
  router.post("/webhook", bodyLimit({ maxSize: 262_144 }), async (c) => {
    if (!dependencies.secret) return c.text("Payments unavailable", 503);
    const signature = c.req.header("stripe-signature");
    if (!signature) return c.text("Invalid signature", 400);
    let event: Stripe.Event;
    try {
      event = await Stripe.webhooks.constructEventAsync(
        await c.req.text(),
        signature,
        dependencies.secret,
        300,
      );
    } catch {
      return c.text("Invalid signature or event", 400);
    }
    if (event.livemode !== dependencies.expectedLiveMode)
      return c.text("Wrong payment mode", 400);
    if (
      ![
        "checkout.session.completed",
        "checkout.session.async_payment_succeeded",
        "checkout.session.expired",
        "checkout.session.async_payment_failed",
      ].includes(event.type)
    ) {
      return c.text("OK", 200);
    }
    if (!Number.isSafeInteger(event.created) || event.created <= 0)
      return c.text("Invalid event", 400);
    const session = dependencies.parseSession(
      event.data.object,
      new Date(event.created * 1000).toISOString(),
    );
    if (!session) return c.text("Invalid session", 400);
    if (dependencies.observe) {
      await dependencies.observe(
        event.data.object,
        new Date(event.created * 1000).toISOString(),
      );
      return c.text("OK", 200);
    }
    if (!session.charge) return c.text("OK", 200);
    if (!(await dependencies.confirm(session.charge)))
      return c.text("Payment could not be matched", 409);
    return c.text("OK", 200);
  });
  return router;
}
