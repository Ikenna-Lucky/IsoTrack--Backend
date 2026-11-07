import { createIdempotentWrites } from "./idempotent-writes";
import { writeStore } from "./write-store";
import { stripe, stripeContext } from "@/lib/stripe";
import { env } from "@/lib/env";
const client = stripe;

export const writes = createIdempotentWrites({
  store: writeStore,
  frontendUrl: env.FRONTEND_URL,
  providerContext: stripeContext,
  liveMode: false,
  createCheckout: client
    ? (params, key) =>
        client.checkout.sessions.create(params, { idempotencyKey: key })
    : null,
});
