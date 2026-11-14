import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
export function encryptMailCache(
  value: string,
  keyHex: string,
  identity: string,
) {
  if (!/^[a-f0-9]{64}$/i.test(keyHex))
    throw new Error("Invalid mail cache encryption key");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  cipher.setAAD(Buffer.from(identity));
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), encrypted]
    .map((v) => v.toString("base64url"))
    .join(".");
}
export function decryptMailCache(
  value: string,
  keyHex: string,
  identity: string,
) {
  const parts = value.split(".");
  if (parts.length !== 3 || !/^[a-f0-9]{64}$/i.test(keyHex))
    throw new Error("Invalid mail cache");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(keyHex, "hex"),
    Buffer.from(parts[0]!, "base64url"),
  );
  decipher.setAAD(Buffer.from(identity));
  decipher.setAuthTag(Buffer.from(parts[1]!, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(parts[2]!, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
