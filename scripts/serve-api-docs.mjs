import { serve } from "@hono/node-server";
import { secureHeaders } from "hono/secure-headers";
import { Hono } from "hono";
import { createApiDocsRouter } from "../src/routes/api-docs.ts";

const value = process.argv[2] ?? "8001";
if (
  process.argv.length > 3 ||
  !/^[1-9][0-9]{0,4}$/.test(value) ||
  Number(value) > 65535
)
  throw new Error("Usage: node scripts/serve-api-docs.mjs [port 1-65535]");
const app = new Hono();
app.use("*", secureHeaders());
app.route("/", createApiDocsRouter(false));
serve({ fetch: app.fetch, port: Number(value), hostname: "127.0.0.1" });
console.log(
  `Read-only Swagger preview: http://127.0.0.1:${value}/docs/ (no database, Redis or credentials needed)`,
);
