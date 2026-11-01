import { jwtVerify } from "jose";

export async function verifySessionToken(
  token: string,
  secret: Uint8Array,
  type: "access" | "refresh",
) {
  const { payload } = await jwtVerify(token, secret, {
    algorithms: ["HS256"],
    requiredClaims: ["sub", "iat", "exp"],
  });
  if (payload.type !== type || typeof payload.sub !== "string" || !payload.sub.trim()) {
    throw new Error("Invalid token claims");
  }
  if (type === "access" && (typeof payload.role !== "string" || !["business", "driver", "customer"].includes(payload.role))) {
    throw new Error("Invalid access token role");
  }
  return payload;
}
