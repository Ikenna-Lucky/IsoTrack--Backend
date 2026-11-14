import { createGraphTestTransport } from "./graph.mjs";

import { postgresFixture } from "./postgres.mjs";
import { createOutboxRuntime } from "../../src/workers/outbox-runtime.ts";
import { dispatchOutbox } from "../../src/workers/outbox-dispatcher.ts";
import { renderNotificationEmail } from "../../src/lib/notification-email.ts";

const postgres = postgresFixture({
  container: process.env.TEST_POSTGRES_CONTAINER,
});
const store = {
  execute: async (statement) => {
    const rows = await postgres.query(statement);
    return rows ? rows.split("\n").map((line) => JSON.parse(line)) : [];
  },
};
const graph = createGraphTestTransport({
  port: Number(process.env.TEST_GRAPH_PORT),
});
const runtime = createOutboxRuntime(
  store,
  process.env.TEST_REDIS_URL,
  async (email) => {
    await graph.send({
      from: "test@example.test",
      ...renderNotificationEmail(email, "https://app.example.test"),
    });
    process.send?.({ type: "graph_accepted" });
    // Parent kills this real process in the send/commit acknowledgement window.
    await new Promise(() => {});
  },
  () => {},
  { lockDuration: 1000, stalledInterval: 1000 },
);
await runtime.queue.waitUntilReady();
await dispatchOutbox(store, runtime.queue);
