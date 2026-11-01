import { verifySessionToken } from "./token-verification";
import { SignJWT, type JWTPayload } from "jose";
import { env } from "@/lib/env";
import type { UserRole } from "@/types";

// ─── Payload ──────────────────────────────────────────────────────────────────

export interface AccessTokenPayload extends JWTPayload {
  sub: string; // userId
  role: UserRole;
  type: "access";
}

export interface RefreshTokenPayload extends JWTPayload {
  sub: string; // userId
  type: "refresh";
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function accessSecret() {
  return new TextEncoder().encode(env.JWT_SECRET);
}

function refreshSecret() {
  return new TextEncoder().encode(env.JWT_REFRESH_SECRET);
}

/** Parse duration string like "15m", "7d" → seconds */
function durationToSeconds(duration: string): number {
  const unit = duration.slice(-1);
  const value = parseInt(duration.slice(0, -1), 10);
  switch (unit) {
    case "s":
      return value;
    case "m":
      return value * 60;
    case "h":
      return value * 3600;
    case "d":
      return value * 86400;
    default:
      return 900; // 15 min fallback
  }
}

// ─── Sign ─────────────────────────────────────────────────────────────────────

export async function createAccessToken(
  userId: string,
  role: UserRole,
): Promise<string> {
  return new SignJWT({ role, type: "access" } satisfies Omit<
    AccessTokenPayload,
    keyof JWTPayload
  >)
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(env.JWT_EXPIRES_IN)
    .sign(accessSecret());
}

export async function createRefreshToken(userId: string): Promise<string> {
  return new SignJWT({ type: "refresh" } satisfies Omit<
    RefreshTokenPayload,
    keyof JWTPayload
  >)
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(env.JWT_REFRESH_EXPIRES_IN)
    .sign(refreshSecret());
}

// ─── Verify ───────────────────────────────────────────────────────────────────

export async function verifyAccessToken(
  token: string,
): Promise<AccessTokenPayload> {
  return await verifySessionToken(token, accessSecret(), "access") as AccessTokenPayload;
}

export async function verifyRefreshToken(
  token: string,
): Promise<RefreshTokenPayload> {
  return await verifySessionToken(token, refreshSecret(), "refresh") as RefreshTokenPayload;
}

// ─── Cookie max-age ───────────────────────────────────────────────────────────

export function refreshTokenMaxAge(): number {
  return durationToSeconds(env.JWT_REFRESH_EXPIRES_IN);
}
