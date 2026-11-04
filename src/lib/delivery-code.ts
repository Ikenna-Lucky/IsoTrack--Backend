import { createHmac } from "node:crypto";
function mac(secret: string, value: string) {
  if (!/^[a-f0-9]{64}$/i.test(secret))
    throw new Error("Delivery secret is not configured");
  return createHmac("sha256", Buffer.from(secret, "hex"))
    .update(value)
    .digest("hex");
}
export function deliveryCode(id: string, secret: string) {
  return (
    BigInt(`0x${mac(secret, `isotrack:delivery-code:v1:${id}`)}`) % 100000000n
  )
    .toString()
    .padStart(8, "0");
}
export function deliveryProof(id: string, code: string, secret: string) {
  return mac(secret, `isotrack:delivery-proof:v1:${id}:${code}`);
}
export function deliveryFingerprint(body: unknown, secret: string) {
  return mac(secret, `isotrack:delivery-request:v1:${JSON.stringify(body)}`);
}
