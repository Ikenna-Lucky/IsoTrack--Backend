import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { prettyJSON } from "hono/pretty-json";
import { secureHeaders } from "hono/secure-headers";
import { serve } from "@hono/node-server";
import { Server } from "socket.io";
import type { ServerType } from "@hono/node-server";

import { authRouter } from "@/routes/auth";
import { shipmentsRouter } from "@/routes/shipments";
import { driversRouter } from "@/routes/drivers";
import { businessRouter } from "@/routes/business";
import { notificationsRouter } from "@/routes/notifications";
import { paymentsRouter } from "@/routes/payments";
import { trackingRouter } from "@/routes/tracking";
import { registerSocketHandlers } from "@/socket/handlers";
import { startNotificationWorker } from "@/workers/notification.worker";
import { env } from "@/lib/env";

// ─── Hono app ─────────────────────────────────────────────────────────────────
const app = new Hono();

// ─── Global middleware ────────────────────────────────────────────────────────
app.use("*", logger());
app.use("*", prettyJSON());
app.use("*", secureHeaders());
app.use(
  "*",
  cors({
    origin: [env.FRONTEND_URL],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
    maxAge: 86400,
  }),
);

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (c) => {
  return c.json({
    status: "ok",
    service: "isotrack-api",
    version: "0.1.0",
    timestamp: new Date().toISOString(),
  });
});

// ─── API routes (v1) ─────────────────────────────────────────────────────────
const v1 = new Hono();

v1.route("/auth", authRouter);
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
      message: `Route ${c.req.method} ${c.req.path} not found`,
    },
    404,
  );
});

// ─── Global error handler ─────────────────────────────────────────────────────
app.onError((err, c) => {
  console.error(`[Error] ${c.req.method} ${c.req.path}:`, err);
  return c.json(
    {
      success: false,
      error: "INTERNAL_SERVER_ERROR",
      message:
        env.NODE_ENV === "production" ? "Something went wrong" : err.message,
    },
    500,
  );
});

// ─── HTTP server (via @hono/node-server) + Socket.io ─────────────────────────
// @hono/node-server creates a proper Node.js http.Server under the hood,
// which Socket.io can attach to. Bun runs Node.js-compatible APIs natively.
const httpServer: ServerType = serve({
  fetch: app.fetch,
  port: env.PORT,
});

const io = new Server(httpServer, {
  cors: {
    origin: env.FRONTEND_URL,
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ["websocket", "polling"],
});

registerSocketHandlers(io);
startNotificationWorker();

console.log(`
╔══════════════════════════════════════════╗
║         IsoTrack API Server              ║
╠══════════════════════════════════════════╣
║  Status   : Running                      ║
║  Port     : ${String(env.PORT).padEnd(28)}║
║  Env      : ${String(env.NODE_ENV).padEnd(28)}║
║  API Base : /api/v1                      ║
║  WS       : Socket.io attached           ║
║  Worker   : Notification queue active    ║
╚══════════════════════════════════════════╝
`);

export type AppType = typeof app;
export { io };
