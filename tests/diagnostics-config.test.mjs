import assert from "node:assert/strict";
import { test } from "node:test";
import {
  diagnosticsConfig,
  previewDiagnosticsOrigin,
} from "../scripts/diagnostics-config.mjs";

const sha = "a".repeat(40);
const config = {
  GITHUB_ACTIONS: "true",
  GITHUB_REF: "refs/heads/isoTrack-dev-branch",
  GITHUB_EVENT_NAME: "push",
  PREVIEW_DIAGNOSTICS_ENABLED: "true",
  PREVIEW_FIXTURE_PASSWORD: "synthetic-fixture-password-32-characters",
};

test("CI diagnostics use pinned preview origin and only fixture HTTP credentials", () => {
  const result = diagnosticsConfig(
    {
      ...config,
      APP_URL: "https://untrusted.invalid",
      DATABASE_URL: "never-forward",
      STRIPE_SECRET_KEY: "never-forward",
    },
    sha,
    true,
  );
  assert.deepEqual(result, {
    APP_URL: previewDiagnosticsOrigin,
    PREVIEW_FIXTURE_PASSWORD: config.PREVIEW_FIXTURE_PASSWORD,
  });
  assert.doesNotThrow(() =>
    diagnosticsConfig(
      { ...config, GITHUB_EVENT_NAME: "workflow_dispatch" },
      sha,
      true,
    ),
  );
});

test("CI diagnostics reject untrusted refs/events, disabled operation and missing identity", () => {
  for (const change of [
    { GITHUB_ACTIONS: "false" },
    { GITHUB_REF: "refs/heads/main" },
    { GITHUB_REF: "refs/heads/isotrack-preview-branch" },
    { GITHUB_REF: "refs/pull/1/merge" },
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_EVENT_NAME: "pull_request_target" },
    { PREVIEW_DIAGNOSTICS_ENABLED: undefined },
    { PREVIEW_DIAGNOSTICS_ENABLED: "false" },
    { PREVIEW_FIXTURE_PASSWORD: undefined },
    { PREVIEW_FIXTURE_PASSWORD: "short" },
  ])
    assert.throws(() => diagnosticsConfig({ ...config, ...change }, sha, true));
  for (const value of [
    undefined,
    "unknown",
    "main",
    "a".repeat(39),
    "a".repeat(41),
    "'; exit 0",
  ])
    assert.throws(() => diagnosticsConfig(config, value, true));
});

test("local diagnostics still require full resource isolation rather than accepting CI-only config", () => {
  assert.throws(() => diagnosticsConfig(config, sha));
  const local = {
    DEPLOYMENT_ENV: "preview",
    NODE_ENV: "production",
    NOTIFICATION_WORKERS_ENABLED: "false",
    RETENTION_ENABLED: "false",
    DATABASE_URL: "postgresql://fixture:fixture@preview.neon.test/db",
    PREVIEW_DATABASE_HOST: "preview.neon.test",
    LIVE_DATABASE_HOST: "live.neon.test",
    UPSTASH_REDIS_URL: "redis://preview.redis.test:6379",
    PREVIEW_REDIS_HOST: "preview.redis.test",
    LIVE_REDIS_HOST: "live.redis.test",
    APP_URL: previewDiagnosticsOrigin,
    PREVIEW_APP_HOST: new URL(previewDiagnosticsOrigin).hostname,
    LIVE_APP_HOST: "live.onrender.test",
    PREVIEW_FIXTURE_PASSWORD: config.PREVIEW_FIXTURE_PASSWORD,
  };
  assert.equal(diagnosticsConfig(local, sha), local);
  assert.throws(() =>
    diagnosticsConfig(
      { ...local, LIVE_DATABASE_HOST: local.PREVIEW_DATABASE_HOST },
      sha,
    ),
  );
});
