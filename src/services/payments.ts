import { stripe, stripeContext } from "../lib/stripe";
import { writeStore } from "./write-store";
import { createPaymentLifecycle } from "./payment-lifecycle";
import { telemetry } from "../observability/telemetry";
import { reportDependency } from "../observability/runtime";

export const paymentLifecycle = stripe
  ? createPaymentLifecycle({
      client: stripe,
      store: writeStore,
      providerContext: stripeContext,
      liveMode: false,
    })
  : null;

export function startPaymentReconciliation() {
  let running: Promise<unknown> | null = null;
  const tick = () => {
    if (running || !paymentLifecycle) return;
    running = paymentLifecycle
      .sweep()
      .then((result) => {
        telemetry.sweep.inc(
          { outcome: "success" },
          result.attempted - result.failed,
        );
        telemetry.sweep.inc({ outcome: "error" }, result.failed);
        if (result.failed) reportDependency("payment_reconciliation");
      })
      .catch(() => reportDependency("payment_reconciliation"))
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
