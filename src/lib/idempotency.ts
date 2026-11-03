import { createHash } from "node:crypto";
import type { SQL } from "drizzle-orm";

export interface WriteStore {
  execute: (statement: SQL) => Promise<Record<string, unknown>[]>;
}
export interface WriteActor {
  userId: string;
  role: "business" | "customer" | "driver";
  email: string;
}
export interface WriteResult {
  status: 200 | 201;
  body: Record<string, unknown>;
  replayed: boolean;
}
export class WriteError extends Error {
  status: 400 | 401 | 403 | 404 | 409 | 410 | 422 | 502 | 503;
  code: string;
  details: Record<string, string> | undefined;
  constructor(
    status: WriteError["status"],
    code: string,
    message: string,
    details?: Record<string, string>,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export function requireIdempotencyKey(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) {
    throw new WriteError(
      400,
      "INVALID_IDEMPOTENCY_KEY",
      "Provide an Idempotency-Key of 16–128 letters, digits, hyphens or underscores",
    );
  }
  return value;
}
export function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export function requestFingerprint(value: unknown): string {
  return hashValue(JSON.stringify(canonical(value)));
}
