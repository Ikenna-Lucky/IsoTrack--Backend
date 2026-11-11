export interface DatabaseConfigInput {
  DATABASE_DRIVER?: string | undefined;
  DATABASE_URL?: string | undefined;
  DEPLOYMENT_ENV?: string | undefined;
  NODE_ENV?: string | undefined;
}
export function databaseConfig(config: DatabaseConfigInput) {
  const driver = config.DATABASE_DRIVER ?? "neon";
  if (driver !== "neon" && driver !== "postgres")
    throw new Error("DATABASE_DRIVER must be neon or postgres");
  const url = config.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  if (driver === "postgres") {
    const parsed = new URL(url);
    if (
      (config.DEPLOYMENT_ENV ?? "local") !== "local" ||
      config.NODE_ENV === "production" ||
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
    )
      throw new Error(
        "The postgres adapter requires a loopback database in a local non-production environment",
      );
  }
  return { driver, url };
}
