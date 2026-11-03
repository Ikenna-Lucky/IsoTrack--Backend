import { getConnInfo } from "@hono/node-server/conninfo";
import { env } from "@/lib/env";
import { createPeerResolver, trustedProxyAddresses } from "../lib/request-peer";
export const requestPeer = createPeerResolver(
  (c) => getConnInfo(c).remote.address,
  trustedProxyAddresses(env.TRUSTED_PROXY_IPS),
);
