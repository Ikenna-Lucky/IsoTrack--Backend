import { createHmac } from "node:crypto";
import { budgetPeer } from "./request-peer.ts";
export type AuthOperation = "login" | "register";
export function authPeerKey(
  secret: string,
  operation: AuthOperation,
  peer: string,
): string {
  return `auth:v1:${operation}:peer:${createHmac("sha256", secret)
    .update(`peer:${budgetPeer(peer)}`)
    .digest("hex")}`;
}
export function authPairKey(
  secret: string,
  peer: string,
  email: string,
): string {
  return `auth:v1:login:pair:${createHmac("sha256", secret)
    .update(JSON.stringify(["login-pair", budgetPeer(peer), email]))
    .digest("hex")}`;
}
