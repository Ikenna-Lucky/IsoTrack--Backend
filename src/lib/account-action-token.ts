import { createHash, createHmac, randomBytes } from "node:crypto";

export type AccountPurpose = "reset_password" | "verify_email";
export function actionToken(
  id: string,
  purpose: AccountPurpose,
  key: string,
): string {
  if (!/^[a-f0-9]{64}$/i.test(key))
    throw new Error("Account action key is not configured");
  const proof = createHmac("sha256", Buffer.from(key, "hex"))
    .update(`isotrack:account-action:v1:${purpose}:${id}`)
    .digest("base64url");
  return `${id}.${proof}`;
}
export const newActionId = () => randomBytes(32).toString("base64url");
export const actionHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export function actionId(token: string): string | null {
  return /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(token)
    ? token.slice(0, 43)
    : null;
}
export function actionPeerHash(peer: string, key: string): string {
  return createHmac("sha256", Buffer.from(key, "hex"))
    .update(`isotrack:account-peer:v1:${peer}`)
    .digest("hex");
}
