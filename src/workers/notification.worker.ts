import { Worker } from "bullmq";
import { redis } from "@/lib/queue";
import { sendShipmentMilestoneEmail } from "@/lib/email";
import type { NotificationJob } from "@/lib/queue";

export function startNotificationWorker(): Worker {
  const worker = new Worker<NotificationJob>(
    "notifications",
    async (job) => {
      const { type, milestone, email } = job.data;

      if (type === "shipment_milestone") {
        console.log(`[Worker] Sending ${milestone} email → ${email.customerEmail}`);
        await sendShipmentMilestoneEmail(milestone, email);
        console.log(`[Worker] ✓ Sent ${milestone} email for ${email.trackingId}`);
      }
    },
    {
      connection: redis,
      concurrency: 5,
    },
  );

  worker.on("failed", (job, err) => {
    console.error(`[Worker] ✗ Job ${job?.id} failed (attempt ${job?.attemptsMade}):`, err.message);
  });

  worker.on("error", (err) => {
    console.error("[Worker] Connection error:", err.message);
  });

  console.log("[Worker] Notification worker started");
  return worker;
}
