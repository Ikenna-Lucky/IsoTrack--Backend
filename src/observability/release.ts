import { Hono } from "hono";

export function createReleaseRouter(environment: string, sha: string) {
  const router = new Hono();
  router.get("/health/release", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ environment, sha });
  });
  return router;
}
