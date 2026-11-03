import { stripe, stripeContext } from "../lib/stripe";
import { env } from "../lib/env";
import { writeStore } from "./write-store";
import { createPaymentLifecycle } from "./payment-lifecycle";

export const paymentLifecycle = stripe
  ? createPaymentLifecycle({
      client: stripe,
      store: writeStore,
      providerContext: stripeContext,
      liveMode: /^(sk|rk)_live_/.test(env.STRIPE_SECRET_KEY ?? ""),
    })
  : null;

export function startPaymentReconciliation() {
  let running: Promise<unknown> | null = null;
  const tick = () => {
    if (running || !paymentLifecycle) return;
    running = paymentLifecycle
      .sweep()
      .then((result) => {
        if (result.failed)
          console.error(
            JSON.stringify({
              event: "payment_reconciliation_failed",
              ...result,
            }),
          );
      })
      .catch(() =>
        console.error(
          JSON.stringify({ event: "payment_reconciliation_unavailable" }),
        ),
      )
      .finally(() => {
        running = null;
      });
  };
  const timer = setInterval(tick, 30_000);
  timer.unref();
  tick();
  return {
    async close() {
      clearInterval(timer);
      await running;
    },
  };
}
