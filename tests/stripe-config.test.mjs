import assert from "node:assert/strict";
import { test } from "node:test";
import { validateStripeConfig } from "../src/lib/stripe-config.ts";
import { assertPreviewIsolation } from "../src/lib/preview-isolation.ts";

const sandbox = {
  STRIPE_MODE: "sandbox",
  STRIPE_SECRET_KEY: "sk_test_isolated_fixture",
  STRIPE_WEBHOOK_SECRET: "whsec_isolated_fixture",
};
test("Stripe is disabled by default and credentials never silently enable it", () => {
  assert.equal(validateStripeConfig({}), "disabled");
  assert.equal(
    validateStripeConfig({
      STRIPE_MODE: "disabled",
      STRIPE_SECRET_KEY: "",
      STRIPE_WEBHOOK_SECRET: "",
    }),
    "disabled",
  );
  for (const config of [
    { STRIPE_SECRET_KEY: sandbox.STRIPE_SECRET_KEY },
    { STRIPE_WEBHOOK_SECRET: sandbox.STRIPE_WEBHOOK_SECRET },
    {
      ...sandbox,
      STRIPE_SECRET_KEY: "sk_live_fixture",
      STRIPE_MODE: "disabled",
    },
  ])
    assert.throws(() => validateStripeConfig(config));
});
test("sandbox mode requires a test server key and signing secret in every hosting environment", () => {
  for (const deployment of ["local", "preview", "production"]) {
    for (const key of ["sk_test_isolated_fixture", "rk_test_isolated_fixture"])
      assert.equal(
        validateStripeConfig({
          ...sandbox,
          DEPLOYMENT_ENV: deployment,
          STRIPE_SECRET_KEY: key,
        }),
        "sandbox",
      );
    for (const change of [
      { STRIPE_MODE: "live" },
      { STRIPE_MODE: "Sandbox" },
      { STRIPE_SECRET_KEY: "sk_live_private_fixture" },
      { STRIPE_SECRET_KEY: "rk_live_private_fixture" },
      { STRIPE_SECRET_KEY: "pk_test_fixture" },
      { STRIPE_SECRET_KEY: undefined },
      { STRIPE_SECRET_KEY: " sk_test_fixture" },
      { STRIPE_SECRET_KEY: "sk_test_" },
      { STRIPE_WEBHOOK_SECRET: undefined },
      { STRIPE_WEBHOOK_SECRET: "wrong_fixture" },
    ]) {
      assert.throws(
        () =>
          validateStripeConfig({
            ...sandbox,
            DEPLOYMENT_ENV: deployment,
            ...change,
          }),
        (error) =>
          !error.message.includes("private_fixture") &&
          !error.message.includes("wrong_fixture"),
      );
    }
  }
});
test("sandbox payments do not relax preview resource isolation or notification-worker policy", () => {
  const config = {
    ...sandbox,
    DEPLOYMENT_ENV: "preview",
    NODE_ENV: "production",
    RELEASE_SHA: "a".repeat(40),
    NOTIFICATION_WORKERS_ENABLED: "false",
    RETENTION_ENABLED: "false",
    APP_URL: "https://preview.fixture.invalid",
    PREVIEW_APP_HOST: "preview.fixture.invalid",
    LIVE_APP_HOST: "live.fixture.invalid",
    DATABASE_URL: "postgresql://fixture:fixture@preview-db.invalid/db",
    PREVIEW_DATABASE_HOST: "preview-db.invalid",
    LIVE_DATABASE_HOST: "live-db.invalid",
    UPSTASH_REDIS_URL: "redis://preview-redis.invalid",
    PREVIEW_REDIS_HOST: "preview-redis.invalid",
    LIVE_REDIS_HOST: "live-redis.invalid",
  };
  assert.doesNotThrow(() => assertPreviewIsolation(config));
  for (const change of [
    { LIVE_DATABASE_HOST: "preview-db.invalid" },
    { NOTIFICATION_WORKERS_ENABLED: "true" },
    { STRIPE_SECRET_KEY: "sk_live_fixture" },
  ])
    assert.throws(() => assertPreviewIsolation({ ...config, ...change }));
});
