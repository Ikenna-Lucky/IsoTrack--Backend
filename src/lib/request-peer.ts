import { isIP } from "node:net";
import type { Context } from "hono";

export function canonicalIp(value: string): string | undefined {
  if (value !== value.trim() || value.includes("%")) return;
  const version = isIP(value);
  if (version === 4) return value;
  if (version !== 6) return;
  const normalized = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = normalized.match(/^::ffff:([0-9a-f]+):([0-9a-f]+)$/);
  if (mapped) {
    const first = parseInt(mapped[1]!, 16),
      second = parseInt(mapped[2]!, 16);
    return `${first >> 8}.${first & 255}.${second >> 8}.${second & 255}`;
  }
  return normalized;
}

/** IPv6 privacy addresses within one /64 share the same authentication budget. */
export function budgetPeer(ip: string): string {
  const canonical = canonicalIp(ip);
  if (!canonical) throw new Error("Invalid peer address");
  if (isIP(canonical) === 4) return canonical;
  const [left, right] = canonical.split("::");
  const before = left ? left.split(":") : [];
  const after = right ? right.split(":") : [];
  const words =
    right !== undefined
      ? [
          ...before,
          ...Array(8 - before.length - after.length).fill("0"),
          ...after,
        ]
      : before;
  return `${words
    .slice(0, 4)
    .map((word) => parseInt(word, 16).toString(16))
    .join(":")}::/64`;
}

export function trustedProxyAddresses(value: string): Set<string> {
  if (!value.trim()) return new Set();
  return new Set(
    value.split(",").map((item) => {
      const address = canonicalIp(item.trim());
      if (!address)
        throw new Error("TRUSTED_PROXY_IPS must contain exact IP addresses");
      return address;
    }),
  );
}

/** Only an explicitly trusted immediate proxy may supply one X-Real-IP value. */
export function createPeerResolver(
  socketAddress: (c: Context) => string | undefined,
  trusted: ReadonlySet<string>,
) {
  return (c: Context): string | undefined => {
    const remote = canonicalIp(socketAddress(c) ?? "");
    if (!remote) return;
    if (!trusted.has(remote)) return remote;
    return canonicalIp(c.req.header("X-Real-IP") ?? "");
  };
}
