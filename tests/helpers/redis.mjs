import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import IORedis from "ioredis";

const exec = promisify(execFile);
export function redisFixture(prefix = "api-budget") {
  const name = `isotrack-${prefix}-test-${randomUUID()}`;
  let started = false;
  const clients = [];
  return {
    async start() {
      await exec(
        "docker",
        [
          "run",
          "--detach",
          "--rm",
          "--name",
          name,
          "--publish",
          "127.0.0.1::6379",
          "redis:7-alpine",
        ],
        { timeout: 60000 },
      );
      started = true;
      const { stdout } = await exec("docker", ["port", name, "6379/tcp"]);
      return `redis://127.0.0.1:${stdout.trim().split(":").at(-1)}`;
    },
    async connect(url) {
      const client = new IORedis(url, {
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 0,
        connectTimeout: 1000,
        commandTimeout: 1000,
        retryStrategy: (n) => Math.min(n * 100, 2000),
      });
      client.on("error", () => {});
      clients.push(client);
      const ready = once(client, "ready");
      await client.connect();
      await ready;
      return client;
    },
    async stop() {
      for (const client of clients) client.disconnect();
      if (started)
        await exec("docker", ["stop", "--time", "1", name], { timeout: 20000 });
    },
  };
}
