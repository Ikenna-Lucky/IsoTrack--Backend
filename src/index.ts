import { Hono } from "hono";
import { apiCors } from "@/lib/api-cors";
import { prettyJSON } from "hono/pretty-json";
import { secureHeaders } from "hono/secure-headers";
import { serve } from "@hono/node-server";
import { Server } from "socket.io";
import type { ServerType } from "@hono/node-server";

import {
  requestTelemetry,
  safeErrorHandler,
  telemetry,
  logEvent,
} from "./observability/telemetry";
import { createOperationalRuntime } from "./observability/runtime";
import { authRouter } from "@/routes/auth";
import { driverInvitationsRouter } from "@/routes/driver-invitations";
import { shipmentsRouter } from "@/routes/shipments";
import { driversRouter } from "@/routes/drivers";
import { businessRouter } from "@/routes/business";
import { notificationsRouter } from "@/routes/notifications";
import { paymentsRouter } from "@/routes/payments";
import { trackingRouter } from "@/routes/tracking";
import { registerSocketHandlers } from "@/socket/handlers";
import { trackingDependencies } from "@/socket/dependencies";
import { trackingServerOptions } from "@/socket/server-options";
import { startNotificationWorker } from "@/workers/notification.worker";
import { startPaymentReconciliation } from "@/services/payments";
import { env } from "@/lib/env";
import { startRetention } from "./services/retention";
import { apiBodyBoundary } from "./middleware/api-protection";
import { closeApiProtection } from "./services/api-protection";
import { createReleaseRouter } from "./observability/release";

// Hono app
const app = new Hono();

// Global middleware
app.use("*", requestTelemetry(telemetry, logEvent));
app.use("*", prettyJSON());
app.use("*", secureHeaders());
app.use("*", apiCors(env.FRONTEND_URL));
app.use("/api/v1/*", apiBodyBoundary());

const operations = createOperationalRuntime();
app.route("/", operations.router);
app.route("/", createReleaseRouter(env.DEPLOYMENT_ENV, env.RELEASE_SHA));

// ─── API routes (v1) ─────────────────────────────────────────────────────────
const v1 = new Hono();

v1.route("/auth", authRouter);
v1.route("/driver-invitations", driverInvitationsRouter);
v1.route("/shipments", shipmentsRouter);
v1.route("/drivers", driversRouter);
v1.route("/business", businessRouter);
v1.route("/notifications", notificationsRouter);
v1.route("/payments", paymentsRouter);
v1.route("/track", trackingRouter);

app.route("/api/v1", v1);

// ─── 404 fallback ─────────────────────────────────────────────────────────────
app.notFound((c) => {
  return c.json(
    {
      success: false,
      error: "NOT_FOUND",
      message: "Route not found",
    },
    404,
  );
});

// ─── Global error handler ─────────────────────────────────────────────────────
app.onError(safeErrorHandler(logEvent));

// ─── HTTP server (via @hono/node-server) + Socket.io ─────────────────────────
// @hono/node-server creates a proper Node.js http.Server under the hood,
// which Socket.io can attach to. Bun runs Node.js-compatible APIs natively.
const httpServer: ServerType = serve({
  fetch: app.fetch,
  port: env.PORT,
});

const io = new Server(httpServer, trackingServerOptions(env.FRONTEND_URL));

registerSocketHandlers(io, trackingDependencies);
const notificationRuntime = env.NOTIFICATION_WORKERS_ENABLED
  ? startNotificationWorker()
  : { close: async () => {} };
const paymentRuntime =
  env.STRIPE_MODE === "sandbox"
    ? startPaymentReconciliation()
    : { close: async () => {} };
const retentionRuntime = startRetention();

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  operations.drain();
  const deadline = setTimeout(() => process.exit(1), 30_000);
  deadline.unref();
  const drain = async () => {
    await Promise.all([
      io.close(),
      notificationRuntime.close(),
      paymentRuntime.close(),
      retentionRuntime.close(),
    ]);
    clearTimeout(deadline);
    operations.close();
    closeApiProtection();
  };
  void drain().catch(() => {
    logEvent("shutdown_failed");
    process.exitCode = 1;
  });
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

logEvent("service_started");

export type AppType = typeof app;
export { io };
