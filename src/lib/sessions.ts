import { nanoid } from "nanoid";
import { db } from "@/db";
import type { User } from "@/db/schema";
import { openSessionStatement, rotateSessionStatement, activeSessionStatement, revokeSessionStatement } from "@/db/queries/session-statements";
import { createAccessToken, createRefreshToken, refreshTokenMaxAge, type RefreshTokenPayload } from "./jwt";

export async function openSession(user: User) {
  const sid = nanoid();
  const result = await db.execute(openSessionStatement(sid, user.id, user.credentialVersion, refreshTokenMaxAge()));
  const row = result.rows[0];
  if (!row) return null;
  return issueTokens(user, sid, 0, Number(row.expires_at));
}

export async function rotateSession(user: User, payload: RefreshTokenPayload) {
  // Sign first so a signing failure leaves the refresh generation usable.
  const tokens = await issueTokens(user, payload.sid, payload.generation + 1, payload.exp!);
  const result = await db.execute(rotateSessionStatement(payload.sid, user.id, payload.generation));
  const row = result.rows[0];
  return row && row.revoked_at === null && Number(row.generation) === payload.generation + 1 ? tokens : null;
}

async function issueTokens(user: User, sid: string, generation: number, expiresAt: number) {
  const [accessToken, refreshToken] = await Promise.all([
    createAccessToken(user.id, user.role, sid),
    createRefreshToken(user.id, sid, generation, expiresAt),
  ]);
  return { accessToken, refreshToken, maxAge: Math.max(0, expiresAt - Math.floor(Date.now() / 1000)) };
}

export async function isSessionActive(sid: string, userId: string) {
  return (await db.execute(activeSessionStatement(sid, userId))).rows.length === 1;
}

export async function revokeSession(sid: string, userId: string) {
  await db.execute(revokeSessionStatement(sid, userId));
}
