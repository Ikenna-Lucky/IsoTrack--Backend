import type { JWTPayload } from "jose";

export function requireSessionClaims(
  payload: JWTPayload,
  refresh: boolean,
): void {
  if (
    typeof payload.sid !== "string" ||
    !/^[a-zA-Z0-9_-]{21}$/.test(payload.sid)
  ) {
    throw new Error("Invalid session identifier");
  }
  if (
    refresh &&
    (!Number.isSafeInteger(payload.generation) ||
      (payload.generation as number) < 0 ||
      (payload.generation as number) >= 2147483647)
  ) {
    throw new Error("Invalid refresh generation");
  }
}
