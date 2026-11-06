import { createHmac } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import type { ApiBudget } from "../lib/api-budget.ts";
import { budgetPeer } from "../lib/request-peer.ts";

type Group = "tracking" | "shipments" | "payments";
type Phase = "peer" | "account";
const policies = {
  tracking: {
    read: { peer: 60, account: 60 },
    write: { peer: 60, account: 60 },
  },
  shipments: {
    read: { peer: 600, account: 120 },
    write: { peer: 300, account: 60 },
  },
  payments: {
    read: { peer: 60, account: 10 },
    write: { peer: 60, account: 10 },
  },
} as const;
export function createApiProtection(deps: {
  budget: ApiBudget;
  secret: string;
  peer: (c: Context) => string | undefined;
  reportFailure: () => void;
}) {
  if (deps.secret.length < 32) throw new Error("API budget key is too short");
  return (group: Group, phase: Phase): MiddlewareHandler =>
    async (c, next) => {
      if (c.req.method === "OPTIONS") return next();
      const operation = ["GET", "HEAD"].includes(c.req.method)
        ? "read"
        : "write";
      c.header("Cache-Control", "no-store");
      let identity: string;
      if (phase === "account") {
        const id = c.get("userId");
        if (!id)
          return c.json(
            {
              success: false,
              error: "UNAUTHORIZED",
              message: "Authentication required",
            },
            401,
          );
        identity = id;
      } else {
        const peer = deps.peer(c);
        if (!peer)
          return c.json(
            {
              success: false,
              error: "REQUEST_PROTECTION_UNAVAILABLE",
              message: "Request protection unavailable",
            },
            503,
            { "Retry-After": "5" },
          );
        try {
          identity = budgetPeer(peer);
        } catch {
          return c.json(
            {
              success: false,
              error: "REQUEST_PROTECTION_UNAVAILABLE",
              message: "Request protection unavailable",
            },
            503,
            { "Retry-After": "5" },
          );
        }
      }
      const digest = createHmac("sha256", deps.secret)
        .update(
          JSON.stringify(["api-budget-v1", group, phase, operation, identity]),
        )
        .digest("hex");
      let result;
      try {
        result = await deps.budget.consume(
          `isotrack:api-budget:v1:${digest}`,
          policies[group][operation][phase],
          60000,
        );
      } catch {
        deps.reportFailure();
        return c.json(
          {
            success: false,
            error: "REQUEST_PROTECTION_UNAVAILABLE",
            message: "Request protection unavailable",
          },
          503,
          { "Retry-After": "5" },
        );
      }
      if (!result.allowed)
        return c.json(
          {
            success: false,
            error: "RATE_LIMITED",
            message: "Too many requests; try again later",
          },
          429,
          { "Retry-After": String(result.retryAfter) },
        );
      await next();
    };
}

/** A common outer bound runs before authentication, JSON validation or providers. */
export function apiBodyBoundary(readTimeoutMs = 10000): MiddlewareHandler {
  if (!Number.isSafeInteger(readTimeoutMs) || readTimeoutMs < 1)
    throw new Error("Invalid body deadline");
  return async (c, next) => {
    c.header("Cache-Control", "no-store");
    const max =
      c.req.path === "/api/v1/payments/webhook" && c.req.method === "POST"
        ? 262144
        : 16384;
    const reject = () =>
      c.json(
        {
          success: false,
          error: "PAYLOAD_TOO_LARGE",
          message: "Request body too large",
        },
        413,
      );
    const encoding = c.req.header("Content-Encoding");
    if (encoding && encoding.toLowerCase() !== "identity")
      return c.json(
        {
          success: false,
          error: "UNSUPPORTED_CONTENT_ENCODING",
          message: "Compressed request bodies are not supported",
        },
        415,
      );
    const length = c.req.header("Content-Length");
    if (
      length !== undefined &&
      (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))
    )
      return c.json(
        {
          success: false,
          error: "INVALID_CONTENT_LENGTH",
          message: "Invalid content length",
        },
        400,
      );
    if (length !== undefined && Number(length) > max) return reject();
    const body = c.req.raw.body;
    if (!body) return next();
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    const expired = new Error("Body read deadline exceeded");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(expired), readTimeoutMs);
    });
    try {
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), deadline]);
        if (done) break;
        size += value.byteLength;
        if (size > max) {
          void reader.cancel().catch(() => {});
          return reject();
        }
        chunks.push(value);
      }
    } catch (error) {
      void reader.cancel().catch(() => {});
      if (error === expired)
        return c.json(
          {
            success: false,
            error: "REQUEST_TIMEOUT",
            message: "Request body timed out",
          },
          408,
        );
      throw error;
    } finally {
      clearTimeout(timer);
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    c.req.raw = new Request(c.req.raw, {
      body: bytes,
      duplex: "half",
    });
    await next();
  };
}
