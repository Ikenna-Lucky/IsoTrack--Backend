import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { Registry, Counter, Histogram, Gauge } from "@prometheus-io/client";
import { matchedRoutes } from "hono/route";
import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ErrorHandler } from "hono";

const context = new AsyncLocalStorage<string>();
export const currentRequestId = () => context.getStore();
type Event =
  | "request_completed"
  | "request_failed"
  | "authentication_attempt"
  | "dependency_failure"
  | "service_started"
  | "shutdown_failed"
  | "retention_failed"
  | "retention_completed";

// Log fields are an allowlist. Errors, SQL, URLs, bodies and headers never enter
// the sink, even if an upstream caller accidentally supplies them.
export function createEventLogger(
  sink: (line: string) => void = (line) => console.info(line),
) {
  return (event: Event, fields: Record<string, unknown> = {}) => {
    const output: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level: event.includes("fail") ? "error" : "info",
      event,
    };
    for (const key of [
      "requestId",
      "method",
      "route",
      "operation",
      "outcome",
      "category",
    ]) {
      const value = fields[key];
      if (
        typeof value === "string" &&
        value.length <= 200 &&
        !/[\r\n]/.test(value)
      )
        output[key] = value;
    }
    for (const key of [
      "status",
      "durationSeconds",
      "attempted",
      "failed",
      "affected",
    ]) {
      const value = fields[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0)
        output[key] = value;
    }
    try {
      sink(JSON.stringify(output));
    } catch {
      /* Logging must not fail a business write. */
    }
  };
}

export function createTelemetry() {
  const registry = new Registry();
  const http = new Histogram({
    name: "isotrack_http_request_duration_seconds",
    help: "API response preparation latency",
    labelNames: ["method", "route", "status"],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });
  const inflight = new Gauge({
    name: "isotrack_http_inflight",
    help: "Requests currently executing",
    registers: [registry],
  });
  const database = new Histogram({
    name: "isotrack_database_request_duration_seconds",
    help: "Neon HTTP time to response headers, including transaction batches",
    labelNames: ["outcome"],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });
  const failures = new Counter({
    name: "isotrack_background_failures_total",
    help: "Background dependency failures",
    labelNames: ["operation"],
    registers: [registry],
  });
  const sweep = new Counter({
    name: "isotrack_payment_reconciliation_total",
    help: "Payment reconciliation attempts",
    labelNames: ["outcome"],
    registers: [registry],
  });
  const retentionRuns = new Counter({
    name: "isotrack_retention_runs_total",
    help: "Bounded cleanup batches",
    labelNames: ["task", "status"],
    registers: [registry],
  });
  const retentionAffected = new Counter({
    name: "isotrack_retention_affected_total",
    help: "Deleted or scrubbed records",
    labelNames: ["task"],
    registers: [registry],
  });
  const retentionEnabled = new Gauge({
    name: "isotrack_retention_enabled",
    help: "Automatic cleanup enabled on this replica",
    registers: [registry],
  });
  retentionEnabled.set(0);
  const ready = new Gauge({
    name: "isotrack_dependency_ready",
    help: "Most recent dependency check",
    labelNames: ["dependency"],
    registers: [registry],
  });
  const snapshots = new Gauge({
    name: "isotrack_backlog_oldest_seconds",
    help: "Age of oldest actionable durable record",
    labelNames: ["queue"],
    registers: [registry],
  });
  const present = new Gauge({
    name: "isotrack_backlog_present",
    help: "Whether an actionable durable record exists",
    labelNames: ["queue"],
    registers: [registry],
  });
  const snapshotTime = new Gauge({
    name: "isotrack_backlog_snapshot_timestamp_seconds",
    help: "Last successful durable backlog snapshot",
    registers: [registry],
  });
  new Gauge({
    name: "isotrack_process_start_time_seconds",
    help: "Process start Unix timestamp",
    registers: [registry],
  }).set(Date.now() / 1000);
  new Gauge({
    name: "isotrack_process_resident_memory_bytes",
    help: "Process resident memory",
    registers: [registry],
    collect() {
      this.set(process.memoryUsage().rss);
    },
  });
  return {
    registry,
    http,
    inflight,
    database,
    failures,
    sweep,
    retentionRuns,
    retentionAffected,
    retentionEnabled,
    ready,
    snapshots,
    present,
    snapshotTime,
  };
}
export type Telemetry = ReturnType<typeof createTelemetry>;
export const telemetry = createTelemetry();
export const logEvent = createEventLogger();

export function requestTelemetry(
  metrics: Telemetry,
  log = createEventLogger(),
): MiddlewareHandler {
  return async (c, next) =>
    context.run(randomUUID(), async () => {
      const started = performance.now();
      c.header("X-Request-Id", currentRequestId());
      metrics.inflight.inc();
      try {
        await next();
      } finally {
        const method = [
          "GET",
          "POST",
          "PUT",
          "PATCH",
          "DELETE",
          "HEAD",
          "OPTIONS",
        ].includes(c.req.method)
          ? c.req.method
          : "OTHER";
        const route =
          matchedRoutes(c)
            .filter((r) => r.method === method && !r.path.includes("*"))
            .at(-1)?.path ?? "unmatched";
        const status = c.res.status;
        const durationSeconds = (performance.now() - started) / 1000;
        metrics.inflight.dec();
        metrics.http.observe(
          { method, route, status: String(status) },
          durationSeconds,
        );
        log("request_completed", {
          requestId: currentRequestId(),
          method,
          route,
          status,
          durationSeconds,
        });
      }
    });
}

export function safeErrorHandler(log = createEventLogger()): ErrorHandler {
  return (error, c) => {
    if (error instanceof HTTPException && error.status < 500) {
      const response = error.getResponse();
      if (response.headers.get("Content-Type")?.includes("application/json"))
        return response;
      const codes: Record<number, string> = {
        400: "BAD_REQUEST",
        401: "UNAUTHORIZED",
        403: "FORBIDDEN",
        404: "NOT_FOUND",
        405: "METHOD_NOT_ALLOWED",
        408: "REQUEST_TIMEOUT",
        409: "CONFLICT",
        413: "PAYLOAD_TOO_LARGE",
        422: "VALIDATION_ERROR",
        429: "TOO_MANY_REQUESTS",
      };
      const headers = new Headers(response.headers);
      headers.set("Content-Type", "application/json; charset=UTF-8");
      return new Response(
        JSON.stringify({
          success: false,
          error: codes[error.status] ?? "REQUEST_REJECTED",
          message: error.message,
        }),
        { status: error.status, headers },
      );
    }
    const status = error instanceof HTTPException ? error.status : 500;
    log("request_failed", {
      requestId: currentRequestId(),
      category: ["NeonDbError", "DatabaseError"].includes(error.name)
        ? "database"
        : "internal",
      status,
    });
    return c.json(
      {
        success: false,
        error: "INTERNAL_SERVER_ERROR",
        message: "Something went wrong. Please try again.",
      },
      status,
    );
  };
}

type FetchTransport = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;
export function instrumentDatabaseFetch(
  metrics: Telemetry,
  transport: FetchTransport,
): FetchTransport {
  return async (input, init) => {
    const start = performance.now();
    let outcome = "error";
    try {
      const response = await transport(input, {
        ...init,
        signal: AbortSignal.any([
          ...(init?.signal ? [init.signal] : []),
          AbortSignal.timeout(5000),
        ]),
      });
      if (response.ok) outcome = "success";
      return response;
    } finally {
      metrics.database.observe({ outcome }, (performance.now() - start) / 1000);
    }
  };
}
