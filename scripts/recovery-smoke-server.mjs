// Recovery rehearsal only: retain production routing and the real Neon transport.
import { neonConfig } from "@neondatabase/serverless";
const database = new URL(process.env.DATABASE_URL);
const redis = new URL(process.env.UPSTASH_REDIS_URL);
if (
  database.pathname !== "/isotrack_recovery" ||
  redis.hostname !== "127.0.0.1" ||
  process.env.STRIPE_MODE !== "disabled" ||
  process.env.STRIPE_SECRET_KEY ||
  process.env.STRIPE_WEBHOOK_SECRET ||
  process.env.NOTIFICATION_WORKERS_ENABLED !== "false" ||
  process.env.RETENTION_ENABLED !== "false"
)
  throw new Error("Recovery isolation settings are required");

const transport = globalThis.fetch;
const endpoint = new URL(
  neonConfig.fetchEndpoint(database.hostname, database.port || 5432),
);
globalThis.fetch = (input, options) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const headers = new Headers(options?.headers);
  const connection = headers.get("Neon-Connection-String");
  let sameDatabase = false;
  if (connection) {
    const candidate = new URL(connection);
    sameDatabase =
      candidate.hostname === database.hostname &&
      candidate.pathname === database.pathname &&
      candidate.username === database.username &&
      candidate.password === database.password;
  }
  if (
    url.protocol !== "https:" ||
    url.href !== endpoint.href ||
    !sameDatabase
  ) {
    console.log("RECOVERY_BLOCKED_HTTP");
    throw new Error("External HTTP disabled except the recovery database");
  }
  return transport(input, options);
};
const { io } = await import("../src/index.ts");
console.log(`RECOVERY_LISTENING:${io.httpServer.address().port}`);
