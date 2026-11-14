export class EmailRetryAfter extends Error {
  readonly delayMs: number;
  constructor(delayMs: number) {
    super("Email provider deferred sending; queued mail will retry.");
    this.delayMs = delayMs;
  }
}
export function emailRetrySeconds(error: unknown): number {
  return error instanceof EmailRetryAfter && Number.isFinite(error.delayMs)
    ? Math.max(1, Math.min(3600, Math.ceil(error.delayMs / 1000)))
    : 0;
}
