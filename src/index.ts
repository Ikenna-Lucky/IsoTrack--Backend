import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { prettyJSON } from "hono/pretty-json";
import { secureHeaders } from "hono/secure-headers";
import { serve } from "@hono/node-server";
import { Server } from "socket.io";
import type { ServerType } from "@hono/node-server";

import { HTTPException } from "hono/http-exception";
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

// Hono app
const app = new Hono();

// Global middleware
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

// Health check
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
  // Let Hono's HTTPException pass through with its correct status code.
  // Without this, thrown HTTPException(401) would get swallowed into a 500,
  // and the frontend's axios refresh interceptor would never trigger.
  if (err instanceof HTTPException) {
    return err.getResponse();
  }

  console.error(`[Error] ${c.req.method} ${c.req.path}:`, err);

  // Never expose raw database or internal error details to the client.
  // Map known low-level error types to friendly messages; fall back to generic.
  const name = (err as { name?: string }).name ?? "";
  const code = (err as { code?: string }).code ?? "";

  // NeonDbError / postgres driver errors
  const isDbError =
    name === "NeonDbError" ||
    name === "DatabaseError" ||
    code === "42703" || // undefined_column
    code === "42P01" || // undefined_table
    code === "23505" || // unique_violation
    code === "23503" || // foreign_key_violation
    code === "08006" || // connection_failure
    name.toLowerCase().includes("neon") ||
    err.message?.toLowerCase().includes("neon internal");

  const clientMessage = isDbError
    ? "A database error occurred. Please try again later."
    : "Something went wrong. Please try again.";

  return c.json(
    {
      success: false,
      error: "INTERNAL_SERVER_ERROR",
      message: clientMessage,
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
