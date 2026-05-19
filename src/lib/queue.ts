import { Queue } from "bullmq";
import IORedis from "ioredis";
import { env } from "@/lib/env";
import type { ShipmentMilestone, ShipmentEmailData } from "@/lib/email";

export const redis = new IORedis(env.UPSTASH_REDIS_URL, {
  maxRetriesPerRequest: null,
  tls: env.UPSTASH_REDIS_URL.startsWith("rediss://") ? {} : undefined,
});

export interface NotificationJob {
  type: "shipment_milestone";
  milestone: ShipmentMilestone;
  email: ShipmentEmailData;
}

export const notificationQueue = new Queue<NotificationJob>("notifications", {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  },
});

export async function enqueueShipmentEmail(
  milestone: ShipmentMilestone,
  data: ShipmentEmailData,
): Promise<void> {
  await notificationQueue.add(
    `${milestone}:${data.trackingId}`,
    { type: "shipment_milestone", milestone, email: data },
  );
}
