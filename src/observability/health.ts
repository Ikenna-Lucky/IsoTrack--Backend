import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Telemetry } from "./telemetry.ts";
export const readinessStatement =
  "select p.checkout_state,s.version,s.recipient_email,s.return_state,d.code_hash,e.action from payments p,payment_checkout_guards g,shipment_payment_receipts r,account_actions a,notification_outbox n,shipments s,delivery_confirmations d,shipment_exceptions e where false";

interface Dependencies {
  database: (signal: AbortSignal) => Promise<unknown>;
  redis: (signal: AbortSignal) => Promise<unknown>;
  backlog: (
    signal: AbortSignal,
  ) => Promise<{ queue: string; age: number; present: boolean }[]>;
  metrics: Telemetry;
  token: string | undefined;
  draining: () => boolean;
  timeoutMs?: number;
  cacheMs?: number;
}
export function createOperationalRouter(deps: Dependencies) {
  const app = new Hono();
  let cache: Promise<{ database: boolean; redis: boolean }> | null = null;
  let checked = 0;
  let checking = false;
  let snapshot: Promise<void> | null = null;
  let sampled = 0;
  async function bounded<T>(
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => run(controller.signal)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("Probe deadline"));
          }, deps.timeoutMs ?? 1500);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  function check() {
    if (
      !cache ||
      (!checking && Date.now() - checked > (deps.cacheMs ?? 5000))
    ) {
      checking = true;
      checked = Date.now();
      cache = Promise.all([
        bounded(deps.database).then(
          () => true,
          () => false,
        ),
        bounded(deps.redis).then(
          () => true,
          () => false,
        ),
      ])
        .then(([database, redis]) => {
          deps.metrics.ready.set({ dependency: "database" }, Number(database));
          deps.metrics.ready.set({ dependency: "redis" }, Number(redis));
          return { database, redis };
        })
        .finally(() => {
          checking = false;
        });
    }
    return cache;
  }
  async function collect() {
    if (snapshot) return snapshot;
    if (Date.now() - sampled < 15000) return;
    sampled = Date.now();
    snapshot = bounded(deps.backlog)
      .then((rows) => {
        const queues = new Set([
          "notifications",
          "notification_dead",
          "notification_leases",
          "account_emails",
          "account_email_dead",
          "account_email_leases",
          "delivery_emails",
          "delivery_email_dead",
          "delivery_email_leases",
          "payments",
          "payment_reviews",
          "held_packages",
        ]);
        if (
          rows.length !== queues.size ||
          new Set(rows.map((row) => row.queue)).size !== queues.size ||
          rows.some(
            (row) =>
              !queues.has(row.queue) ||
              !Number.isFinite(row.age) ||
              typeof row.present !== "boolean",
          )
        )
          throw new Error("Invalid backlog snapshot");
        for (const row of rows) {
          deps.metrics.snapshots.set(
            { queue: row.queue },
            Math.max(0, row.age),
          );
          deps.metrics.present.set({ queue: row.queue }, Number(row.present));
        }
        deps.metrics.snapshotTime.set(Date.now() / 1000);
      })
      .catch(() => {
        /* Retain last good values; freshness alert detects failure. */
      })
      .finally(() => {
        snapshot = null;
      });
    return snapshot;
  }
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.get("/health", (c) =>
    c.json({
      status: "ok",
      service: "isotrack-api",
      version: "0.1.0",
      timestamp: new Date().toISOString(),
    }),
  );
  app.get("/health/live", (c) => c.json({ status: "ok" }));
  app.get("/health/ready", async (c) => {
    if (deps.draining()) return c.json({ status: "not_ready" }, 503);
    const result = await check();
    // Redis delivers durable async work. Its outage is degraded service, not a
    // reason to evict every API replica and prevent new durable writes.
    const ready = result.database && !deps.draining();
    return c.json({ status: ready ? "ready" : "not_ready" }, ready ? 200 : 503);
  });
  app.get("/metrics", async (c) => {
    if (!deps.token) return c.text("Not found", 404);
    const authorization = c.req.header("Authorization") ?? "";
    const expected = createHash("sha256")
      .update(`Bearer ${deps.token}`)
      .digest();
    const actual = createHash("sha256").update(authorization).digest();
    if (!timingSafeEqual(expected, actual)) return c.text("Unauthorized", 401);
    await Promise.all([check(), collect()]);
    return c.text(await deps.metrics.registry.metrics(), 200, {
      "Content-Type": deps.metrics.registry.contentType,
    });
  });
  return app;
}
