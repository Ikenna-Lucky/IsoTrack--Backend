export const stripeApiVersion = "2026-10-28.endive";

// Payments stay in sandbox mode, including on production deployments.
export function validateStripeConfig(config: Record<string, unknown>) {
  const mode = config.STRIPE_MODE ?? "disabled";
  if (mode !== "disabled" && mode !== "sandbox")
    throw new Error("STRIPE_MODE must be disabled or sandbox");
  const key = config.STRIPE_SECRET_KEY;
  const webhook = config.STRIPE_WEBHOOK_SECRET;
  if (mode === "disabled") {
    if (key || webhook)
      throw new Error(
        "Remove Stripe credentials or explicitly select sandbox mode",
      );
    return mode;
  }
  if (typeof key !== "string" || !/^(sk|rk)_test_[A-Za-z0-9_]+$/.test(key))
    throw new Error(
      "Sandbox mode requires a Stripe test secret or restricted key",
    );
  if (typeof webhook !== "string" || !/^whsec_[A-Za-z0-9_]+$/.test(webhook))
    throw new Error(
      "Sandbox mode requires the matching webhook signing secret",
    );
  return mode;
}
