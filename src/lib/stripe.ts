import Stripe from "stripe";
import { env } from "./env";
import { hashValue } from "./idempotency";
import { stripeApiVersion } from "./stripe-config";

export const stripe =
  env.STRIPE_MODE === "sandbox"
    ? new Stripe(env.STRIPE_SECRET_KEY!, {
        apiVersion: stripeApiVersion,
        httpClient: Stripe.createFetchHttpClient(),
        timeout: 10000,
        maxNetworkRetries: 1,
      })
    : null;
// Conservative binding: credential rotation requires reconciliation of pending
// attempts, even if the new credential belongs to the same Stripe account.
export const stripeContext = hashValue(
  `${stripeApiVersion}:${env.STRIPE_SECRET_KEY ?? "unconfigured"}`,
);
