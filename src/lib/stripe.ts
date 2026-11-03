import Stripe from "stripe";
import { env } from "./env";
import { hashValue } from "./idempotency";

const apiVersion = "2026-10-28.endive";
export const stripe = env.STRIPE_SECRET_KEY
  ? new Stripe(env.STRIPE_SECRET_KEY, {
      apiVersion,
      timeout: 10000,
      maxNetworkRetries: 1,
    })
  : null;
// Conservative binding: credential rotation requires reconciliation of pending
// attempts, even if the new credential belongs to the same Stripe account.
export const stripeContext = hashValue(
  `${apiVersion}:${env.STRIPE_SECRET_KEY ?? "unconfigured"}`,
);
