import nodemailer from "nodemailer";
import { env } from "@/lib/env";
import { outboxStore } from "@/db/outbox-store";
import { renderNotificationEmail } from "@/lib/notification-email";
import { createOutboxRuntime } from "./outbox-runtime";

export function startNotificationWorker() {
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    requireTLS: true,
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 10000,
    auth: { user: env.GMAIL_USER, pass: env.GMAIL_APP_PASSWORD },
  });
  return createOutboxRuntime(
    outboxStore,
    env.UPSTASH_REDIS_URL,
    async (email) => {
      await transporter.sendMail({
        from: env.EMAIL_FROM,
        ...renderNotificationEmail(email, env.FRONTEND_URL),
      });
    },
    (operation) =>
      console.error(
        JSON.stringify({ event: "notification_failure", operation }),
      ),
  );
}
