import { verifySessionToken } from "./token-verification";
import { SignJWT, type JWTPayload } from "jose";
import { env } from "@/lib/env";
import type { UserRole } from "@/types";
import { requireSessionClaims } from "./session-claims";
import { tokenDurationSeconds } from "./token-duration";

// ─── Payload ──────────────────────────────────────────────────────────────────

export interface AccessTokenPayload extends JWTPayload {
  sub: string; // userId
  role: UserRole;
  sid: string;
  type: "access";
}

export interface RefreshTokenPayload extends JWTPayload {
  sub: string; // userId
  type: "refresh";
  sid: string;
  generation: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function accessSecret() {
  return new TextEncoder().encode(env.JWT_SECRET);
}

function refreshSecret() {
  return new TextEncoder().encode(env.JWT_REFRESH_SECRET);
}

// ─── Sign ─────────────────────────────────────────────────────────────────────

export async function createAccessToken(
  userId: string,
  role: UserRole,
  sid: string,
): Promise<string> {
  return new SignJWT({ role, sid, type: "access" } satisfies Omit<
    AccessTokenPayload,
    keyof JWTPayload
  >)
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(env.JWT_EXPIRES_IN)
    .sign(accessSecret());
}

export async function createRefreshToken(userId: string, sid: string, generation: number, expiresAt: number): Promise<string> {
  return new SignJWT({ type: "refresh", sid, generation } satisfies Omit<
    RefreshTokenPayload,
    keyof JWTPayload
  >)
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(refreshSecret());
}

// ─── Verify ───────────────────────────────────────────────────────────────────

export async function verifyAccessToken(
  token: string,
): Promise<AccessTokenPayload> {
  const payload = await verifySessionToken(token, accessSecret(), "access");
  requireSessionClaims(payload, false);
  return payload as AccessTokenPayload;
}

export async function verifyRefreshToken(
  token: string,
): Promise<RefreshTokenPayload> {
  const payload = await verifySessionToken(token, refreshSecret(), "refresh");
  requireSessionClaims(payload, true);
  return payload as RefreshTokenPayload;
}


// ─── Cookie max-age ───────────────────────────────────────────────────────────

export function refreshTokenMaxAge(): number {
  return tokenDurationSeconds(env.JWT_REFRESH_EXPIRES_IN);
}
