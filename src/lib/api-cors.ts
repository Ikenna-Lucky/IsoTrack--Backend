import { cors } from "hono/cors";

export function apiCors(frontendUrl: string) {
  return cors({
    origin: [new URL(frontendUrl).origin],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
    exposeHeaders: ["Idempotency-Replayed", "Retry-After", "X-Request-Id"],
    credentials: true,
    maxAge: 86400,
  });
}
