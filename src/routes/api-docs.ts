import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Hono } from "hono";
import { openApiDocument } from "../openapi/document.ts";

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>IsoTrack API reference</title><link rel="stylesheet" href="/docs/assets/swagger-ui.css"></head>
<body><div id="swagger-ui"></div><script src="/docs/assets/swagger-ui-bundle.js"></script><script src="/docs/assets/config.js"></script></body></html>`;
const config = (interactive: boolean) => `window.ui = SwaggerUIBundle({
  url: '/openapi.json', dom_id: '#swagger-ui', deepLinking: true,
  displayRequestDuration: true, filter: true, persistAuthorization: false,
  withCredentials: true, validatorUrl: null, queryConfigEnabled: false,
  defaultModelsExpandDepth: 1,
  supportedSubmitMethods: ${interactive ? '["get", "post", "patch", "delete"]' : "[]"}
});`;

/** Fixed asset routes avoid exposing the filesystem or depending on a CDN. */
export function createApiDocsRouter(interactive = true) {
  const router = new Hono();
  router.use("/docs/*", async (c, next) => {
    c.header(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Robots-Tag", "noindex, nofollow");
    c.header("Cache-Control", "no-store");
    await next();
  });
  router.get("/docs", (c) => c.redirect("/docs/"));
  router.get("/docs/", (c) =>
    c.html(
      interactive
        ? html
        : html.replace(
            '<div id="swagger-ui">',
            '<p>Documentation preview: API execution is disabled. Start the backend to use Try it out.</p><div id="swagger-ui">',
          ),
    ),
  );
  router.get("/openapi.json", (c) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Robots-Tag", "noindex, nofollow");
    return c.json(openApiDocument);
  });
  router.get("/docs/assets/config.js", (c) =>
    c.body(config(interactive), 200, {
      "Content-Type": "application/javascript; charset=utf-8",
    }),
  );
  for (const filename of ["swagger-ui.css", "swagger-ui-bundle.js"] as const) {
    let cached: Promise<string> | undefined;
    const load = async () => {
      try {
        return await readFile(resolve("dist/swagger", filename), "utf8");
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "ENOENT"
        )
          throw error;
        return readFile(
          resolve("node_modules/swagger-ui-dist", filename),
          "utf8",
        );
      }
    };
    router.get(`/docs/assets/${filename}`, async (c) => {
      cached ??= load().catch((error: unknown) => {
        cached = undefined;
        throw error;
      });
      return c.body(await cached, 200, {
        "Content-Type": filename.endsWith(".css")
          ? "text/css; charset=utf-8"
          : "application/javascript; charset=utf-8",
      });
    });
  }
  return router;
}
