// Test-only transport override; all application routing/wiring is unchanged.
import { neonConfig } from "@neondatabase/serverless";

const endpoint = new URL(process.env.JOURNEY_DATABASE_ENDPOINT);
if (endpoint.hostname !== "127.0.0.1" || endpoint.protocol !== "http:")
  throw new Error("Journey database transport must stay on loopback");
neonConfig.fetchEndpoint = endpoint.href;
const transport = globalThis.fetch;
globalThis.fetch = (input, options) => {
  if (String(input) !== endpoint.href)
    throw new Error("External HTTP is disabled in journey tests");
  return transport(input, options);
};
const { io } = await import("../../src/index.ts");
console.log(`JOURNEY_LISTENING:${io.httpServer.address().port}`);
