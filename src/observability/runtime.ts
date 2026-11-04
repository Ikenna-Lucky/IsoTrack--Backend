import IORedis from "ioredis";
import { PgDialect } from "drizzle-orm/pg-core";
import { db } from "../db";
import { env } from "../lib/env";
import { backlogStatement } from "./backlog";
import { createOperationalRouter, readinessStatement } from "./health";
import { telemetry, logEvent } from "./telemetry";

const operations = new Set([
  "outbox_redis_producer",
  "outbox_redis_consumer",
  "outbox_delivery",
  "outbox_worker",
  "outbox_dispatch",
  "account_email",
  "delivery_email",
  "account_action",
  "tracking",
  "payment_reconciliation",
]);
export function reportDependency(operation: string) {
  const bounded = operations.has(operation) ? operation : "other";
  telemetry.failures.inc({ operation: bounded });
  logEvent("dependency_failure", { operation: bounded });
}
export function createOperationalRuntime() {
  let draining = false;
  const redis = new IORedis(env.UPSTASH_REDIS_URL, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    connectTimeout: 1000,
    commandTimeout: 1000,
    retryStrategy: (times) => Math.min(times * 100, 2000),
  });
  redis.on("error", () => {});
  void redis.connect().catch(() => {});
  const dialect = new PgDialect();
  const router = createOperationalRouter({
    metrics: telemetry,
    token: env.METRICS_TOKEN,
    draining: () => draining,
    database: (signal) =>
      db.$client(readinessStatement, [], { fetchOptions: { signal } }),
    redis: async () => {
      if ((await redis.ping()) !== "PONG")
        throw new Error("Redis probe failed");
    },
    backlog: async (signal) => {
      const query = dialect.sqlToQuery(backlogStatement());
      const result = await db.$client(query.sql, query.params, {
        fullResults: true,
        arrayMode: false,
        fetchOptions: { signal },
      });
      return result.rows.map((row) => {
        const r = row.result as Record<string, unknown>;
        return {
          queue: String(r.queue),
          age: Number(r.age),
          present: r.present === true,
        };
      });
    },
  });
  return {
    router,
    drain() {
      draining = true;
    },
    close() {
      redis.disconnect();
    },
  };
}
