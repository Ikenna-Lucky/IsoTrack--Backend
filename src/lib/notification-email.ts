import { createHash } from "node:crypto";
import type { NotificationEmail } from "../workers/outbox-processor";

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
}

export function renderNotificationEmail(
  email: NotificationEmail,
  frontendUrl: string,
) {
  const url = new URL("/customer/track", frontendUrl);
  url.searchParams.set("id", email.trackingId);
  const messageId = `<${createHash("sha256").update(email.eventId).digest("hex")}@notifications.isotrack.app>`;
  return {
    to: email.to,
    messageId,
    subject: `[${email.trackingId.replace(/[\r\n]/g, "")}] ${email.title}`,
    text: `Hi ${email.name},\n\n${email.message}\n\nTrack your shipment: ${url.href}`,
    html: `<h1>${escapeHtml(email.title)}</h1><p>Hi ${escapeHtml(email.name)},</p><p>${escapeHtml(email.message)}</p><p><a href="${escapeHtml(url.href)}">Track your shipment</a></p>`,
  };
}
