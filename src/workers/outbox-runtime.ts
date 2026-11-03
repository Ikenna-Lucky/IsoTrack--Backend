import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import {
  createOutboxProcessor,
  type OutboxStore,
  type NotificationEmail,
} from "./outbox-processor.ts";
import { startOutboxDispatcher } from "./outbox-dispatcher.ts";

export const OUTBOX_QUEUE = "notification-outbox-v1";

export function createOutboxRuntime(
  store: OutboxStore,
  redisUrl: string,
  sendEmail: (email: NotificationEmail) => Promise<void>,
  reportError: (operation: string) => void,
  recovery = { lockDuration: 30_000, stalledInterval: 30_000 },
) {
  const producer = new IORedis(redisUrl, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 5000,
    commandTimeout: 5000,
  });
  const consumer = new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    connectTimeout: 5000,
  });
  producer.on("error", () => reportError("outbox_redis_producer"));
  consumer.on("error", () => reportError("outbox_redis_consumer"));
  const queue = new Queue(OUTBOX_QUEUE, { connection: producer });
  const process = createOutboxProcessor(store, sendEmail);
  const worker = new Worker(
    OUTBOX_QUEUE,
    async (job) => {
      const data: unknown = job.data;
      if (
        !data ||
        typeof data !== "object" ||
        !("outboxId" in data) ||
        typeof data.outboxId !== "string"
      ) {
        throw new Error("Invalid notification job");
      }
      try {
        await process(data.outboxId);
      } catch {
        throw new Error("Notification processing failed");
      }
    },
    { connection: consumer, concurrency: 5, ...recovery },
  );
  worker.on("failed", () => reportError("outbox_delivery"));
  worker.on("error", () => reportError("outbox_worker"));
  const stopDispatcher = startOutboxDispatcher(store, queue, () =>
    reportError("outbox_dispatch"),
  );
  return {
    queue,
    worker,
    async close() {
      await stopDispatcher();
      await worker.close();
      await queue.close();
      producer.disconnect();
      consumer.disconnect();
    },
  };
}
