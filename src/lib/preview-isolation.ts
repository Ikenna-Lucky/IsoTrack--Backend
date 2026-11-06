export function assertPreviewPreparation(config: Record<string, unknown>) {
  if (config.GITHUB_REF !== "refs/heads/isotrack-preview-branch")
    throw new Error("Only the preview branch may prepare preview data");
  if (config.PREVIEW_PREPARE_ENABLED !== "true")
    throw new Error(
      "Preview preparation is not enabled; finish the schema review and environment setup first",
    );
  assertPreviewIsolation(config);
}

export function assertPreviewIsolation(config: Record<string, unknown>) {
  const required = (name: string) => {
    const value = config[name];
    if (typeof value !== "string" || !value)
      throw new Error("Preview isolation configuration is incomplete");
    return value;
  };
  if (
    required("DEPLOYMENT_ENV") !== "preview" ||
    required("NODE_ENV") !== "production"
  )
    throw new Error("Preview mode is required");
  if (!/^[a-f0-9]{40}$/.test(required("RELEASE_SHA")))
    throw new Error("Preview requires a full release SHA");
  if (
    ![false, "false"].includes(
      config.NOTIFICATION_WORKERS_ENABLED as boolean | string,
    ) ||
    ![false, "false"].includes(config.RETENTION_ENABLED as boolean | string)
  )
    throw new Error("Preview background work must be disabled");
  if (config.STRIPE_SECRET_KEY || config.STRIPE_WEBHOOK_SECRET)
    throw new Error("Initial preview must not use payment credentials");
  for (const [urlName, previewName, liveName, protocols] of [
    [
      "DATABASE_URL",
      "PREVIEW_DATABASE_HOST",
      "LIVE_DATABASE_HOST",
      ["postgres:", "postgresql:"],
    ],
    [
      "UPSTASH_REDIS_URL",
      "PREVIEW_REDIS_HOST",
      "LIVE_REDIS_HOST",
      ["redis:", "rediss:"],
    ],
    ["APP_URL", "PREVIEW_APP_HOST", "LIVE_APP_HOST", ["https:"]],
  ] as const) {
    const url = new URL(required(urlName));
    // Neon pooler and direct endpoint spellings must not defeat the live-host check.
    const host = (value: string) => {
      const parsed = new URL(`https://${value}`);
      if (
        parsed.hostname !== value.toLowerCase() ||
        parsed.port ||
        parsed.username ||
        parsed.password ||
        parsed.pathname !== "/" ||
        parsed.search ||
        parsed.hash
      )
        throw new Error("Resource hosts must be hostnames only");
      return value.toLowerCase().replace(/\.$/, "").replace("-pooler.", ".");
    };
    if (
      !(protocols as readonly string[]).includes(url.protocol) ||
      host(url.hostname) !== host(required(previewName)) ||
      host(url.hostname) === host(required(liveName))
    )
      throw new Error("Preview resource isolation check failed");
    if (
      urlName === "APP_URL" &&
      (url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash)
    )
      throw new Error("Preview app must use a bare HTTPS origin");
  }
}
