import { Worker } from "bullmq";
import { redis } from "@/lib/queue";
import { sendShipmentMilestoneEmail } from "@/lib/email";
import type { NotificationJob } from "@/lib/queue";

export function startNotificationWorker(): Worker {
  const worker = new Worker<NotificationJob>(
    "notifications",
    async (job) => {
      const { type, milestone, email } = job.data;

      if (type !== "shipment_milestone") return;

      // 1. Send the email
      console.log(`[Worker] Sending ${milestone} email to ${email.customerEmail}`);
      await sendShipmentMilestoneEmail(milestone, email);
      console.log(`[Worker] Email sent for ${email.trackingId} (${milestone})`);

      // 2. Write an in-app notification for the customer if they have an account
      // (Business in-app notifications are written directly in the shipment route
      //  so they appear immediately — the worker handles the customer side here)
      // For now we write to the business owner as a fallback record too
      try {
        // Find the business userId via trackingId pattern is not ideal;
        // the in-app notification for business is already written in the route.
        // Here we just log success — customer in-app notifications can be added
        // once customer accounts are fully wired to their own dashboard.
        console.log(`[Worker] Job complete: ${milestone} for ${email.trackingId}`);
      } catch (err) {
        console.error("[Worker] Post-email step failed:", err);
      }
    },
    {
      connection: redis,
      concurrency: 5,
    },
  );

  worker.on("failed", (job, err) => {
    console.error(`[Worker] Job ${job?.id} failed (attempt ${job?.attemptsMade}):`, err.message);
  });

  worker.on("error", (err) => {
    console.error("[Worker] Connection error:", err.message);
  });

  console.log("[Worker] Notification worker started");
  return worker;
}
