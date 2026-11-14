import assert from "node:assert/strict";
import { assertPreviewIsolation } from "../src/lib/preview-isolation.ts";

export const previewDiagnosticsOrigin =
  "https://isotrack-backend-preview.onrender.com";

// Hosted diagnostics need HTTP credentials only, never direct resource credentials.
export function diagnosticsConfig(config, expectedSha, github = false) {
  assert(
    /^[a-f0-9]{40}$/.test(expectedSha ?? ""),
    "Full preview release SHA required",
  );
  if (github) {
    assert.equal(config.GITHUB_ACTIONS, "true");
    assert.equal(config.GITHUB_REF, "refs/heads/isoTrack-dev-branch");
    assert(["push", "workflow_dispatch"].includes(config.GITHUB_EVENT_NAME));
    assert.equal(config.PREVIEW_DIAGNOSTICS_ENABLED, "true");
    // Pin the destination in reviewed code, not in an arbitrary workflow input.
    config = {
      APP_URL: previewDiagnosticsOrigin,
      PREVIEW_FIXTURE_PASSWORD: config.PREVIEW_FIXTURE_PASSWORD,
    };
  } else {
    assertPreviewIsolation({ ...config, RELEASE_SHA: expectedSha });
  }
  assert.equal(config.APP_URL, previewDiagnosticsOrigin);
  assert(config.PREVIEW_FIXTURE_PASSWORD?.length >= 32);
  return config;
}
