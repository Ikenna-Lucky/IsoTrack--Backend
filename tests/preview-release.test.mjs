import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPreviewIsolation } from "../src/lib/preview-isolation.ts";
import { createReleaseRouter } from "../src/observability/release.ts";
import { deployHook, verifyPreview } from "../scripts/preview-release.mjs";

const config = {
  DEPLOYMENT_ENV: "preview",
  NODE_ENV: "production",
  RELEASE_SHA: "a".repeat(40),
  NOTIFICATION_WORKERS_ENABLED: "false",
  RETENTION_ENABLED: "false",
  DATABASE_URL: "postgresql://fixture:fixture@ep-preview-pooler.neon.test/db",
  PREVIEW_DATABASE_HOST: "ep-preview.neon.test",
  LIVE_DATABASE_HOST: "ep-live.neon.test",
  UPSTASH_REDIS_URL: "rediss://fixture:fixture@preview.redis.test:6379",
  PREVIEW_REDIS_HOST: "preview.redis.test",
  LIVE_REDIS_HOST: "live.redis.test",
  APP_URL: "https://preview.onrender.com",
  PREVIEW_APP_HOST: "preview.onrender.com",
  LIVE_APP_HOST: "live.onrender.com",
  RENDER_PREVIEW_SERVICE_ID: "srv-preview",
  RENDER_LIVE_SERVICE_ID: "srv-live",
  RENDER_PREVIEW_DEPLOY_HOOK:
    "https://api.render.com/deploy/srv-preview?key=fixture-secret",
  PREVIEW_FIXTURE_PASSWORD: "fixture-preview-password-32-characters",
};
test("preview isolation refuses live resource aliases, workers, unknown releases and payment credentials", () => {
  assert.doesNotThrow(() => assertPreviewIsolation(config));
  for (const change of [
    { DEPLOYMENT_ENV: "production" },
    { NODE_ENV: "development" },
    { RELEASE_SHA: "unknown" },
    { LIVE_DATABASE_HOST: "ep-preview.neon.test" },
    { LIVE_REDIS_HOST: "preview.redis.test" },
    { LIVE_APP_HOST: "preview.onrender.com" },
    { DATABASE_URL: "postgresql://fixture@unexpected.test/db" },
    { APP_URL: "https://preview.onrender.com/path" },
    { NOTIFICATION_WORKERS_ENABLED: "true" },
    { RETENTION_ENABLED: "true" },
    { STRIPE_SECRET_KEY: "sk_test_fixture" },
    { PREVIEW_APP_HOST: undefined },
    { LIVE_DATABASE_HOST: "https://ep-preview.neon.test" },
    { LIVE_REDIS_HOST: "preview.redis.test:6379" },
    { LIVE_DATABASE_HOST: "ep-preview.neon.test." },
  ])
    assert.throws(() => assertPreviewIsolation({ ...config, ...change }));
});
test("Render hook is pinned to a different preview service and exact release, without redirects or arbitrary hosts", () => {
  assert.equal(deployHook(config).searchParams.get("ref"), config.RELEASE_SHA);
  for (const change of [
    { RENDER_LIVE_SERVICE_ID: "srv-preview" },
    {
      RENDER_PREVIEW_DEPLOY_HOOK:
        "https://api.render.com/deploy/srv-live?key=x",
    },
    {
      RENDER_PREVIEW_DEPLOY_HOOK: "https://evil.test/deploy/srv-preview?key=x",
    },
    {
      RENDER_PREVIEW_DEPLOY_HOOK:
        "https://api.render.com/deploy/srv-preview?key=x&ref=main",
    },
  ])
    assert.throws(() => deployHook({ ...config, ...change }));
});
test("release identity contains only environment/SHA and is not cached", async () => {
  const response = await createReleaseRouter(
    "preview",
    config.RELEASE_SHA,
  ).request("/health/release");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), {
    environment: "preview",
    sha: config.RELEASE_SHA,
  });
});
test("smoke checks never send credentials until exact preview identity is verified", async () => {
  const paths = [];
  await assert.rejects(() =>
    verifyPreview(config, {
      attempts: 2,
      wait: async () => {},
      fetcher: async (url) => {
        paths.push(new URL(url).pathname);
        return Response.json({
          environment: "production",
          sha: config.RELEASE_SHA,
        });
      },
    }),
  );
  assert.deepEqual(paths, ["/health/release", "/health/release"]);
});
test("smoke failures cannot pass when tenant denial or public privacy regresses", async () => {
  for (const broken of ["privacy", "tenancy"]) {
    await assert.rejects(() =>
      verifyPreview(config, {
        attempts: 1,
        fetcher: async (url, options) => {
          const path = new URL(url).pathname;
          if (path === "/health/release")
            return Response.json({
              environment: "preview",
              sha: config.RELEASE_SHA,
            });
          if (path.startsWith("/health"))
            return Response.json({ status: "ready" });
          if (path === "/api/v1/auth/login")
            return Response.json({ data: { accessToken: "fixture" } });
          if (path.startsWith("/api/v1/track"))
            return Response.json({
              data:
                broken === "privacy"
                  ? { pickupAddress: { street: "PRIVATE-PREVIEW" } }
                  : { status: "assigned" },
            });
          return Response.json(
            {},
            { status: options.headers?.Authorization ? 200 : 401 },
          );
        },
      }),
    );
  }
});

test("successful smoke checks retain statuses without passwords, tokens or response bodies", async () => {
  let publicCalls = 0;
  const report = await verifyPreview(config, {
    attempts: 1,
    fetcher: async (url, options) => {
      const path = new URL(url).pathname;
      if (path === "/health/release")
        return Response.json({
          environment: "preview",
          sha: config.RELEASE_SHA,
        });
      if (path.startsWith("/health")) return Response.json({ status: "ready" });
      if (path === "/api/v1/auth/login") {
        const actor = JSON.parse(options.body).email.split("@")[0];
        return Response.json({ data: { accessToken: actor } });
      }
      if (path.startsWith("/api/v1/track")) {
        publicCalls++;
        return publicCalls > 60
          ? Response.json({}, { status: 429, headers: { "Retry-After": "10" } })
          : Response.json({ data: { status: "assigned" } });
      }
      if (options.method === "POST") return Response.json({}, { status: 413 });
      const actor = options.headers?.Authorization?.slice("Bearer ".length);
      const status = !actor
        ? 401
        : actor === "preview-other" || path.includes("foreign")
          ? 404
          : 200;
      return Response.json({}, { status });
    },
  });
  assert.equal(report.passed, true);
  assert.ok(
    report.checks.some((c) => c.name === "tracking budget" && c.status === 429),
  );
  assert.ok(!JSON.stringify(report).includes(config.PREVIEW_FIXTURE_PASSWORD));
  assert.ok(!JSON.stringify(report).includes("accessToken"));
});
