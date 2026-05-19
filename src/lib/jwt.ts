import { SignJWT, jwtVerify, type JWTPayload } from "jose";
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
  const { payload } = await jwtVerify<AccessTokenPayload>(
    token,
    accessSecret(),
  );
  if (payload.type !== "access") {
    throw new Error("Invalid token type");
  }
  return payload;
}

export async function verifyRefreshToken(
  token: string,
): Promise<RefreshTokenPayload> {
  const { payload } = await jwtVerify<RefreshTokenPayload>(
    token,
    refreshSecret(),
  );
  if (payload.type !== "refresh") {
    throw new Error("Invalid token type");
  }
  return payload;
}

// ─── Cookie max-age ───────────────────────────────────────────────────────────

export function refreshTokenMaxAge(): number {
  return durationToSeconds(env.JWT_REFRESH_EXPIRES_IN);
}
