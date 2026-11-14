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
  const business = email.recipientRole === "business";
  const driver = email.recipientRole === "driver";
  const url = new URL(
    business
      ? "/business/shipments"
      : driver
        ? "/driver/deliveries"
        : "/customer/track",
    frontendUrl,
  );
  if (!business && !driver) url.searchParams.set("id", email.trackingId);
  const action = business
    ? "View your shipments"
    : driver
      ? "View your deliveries"
      : "Track your shipment";
  const messageId = `<${createHash("sha256").update(email.eventId).digest("hex")}@notifications.isotrack.app>`;
  return {
    to: email.to,
    messageId,
    subject: `[${email.trackingId.replace(/[\r\n]/g, "")}] ${email.title}`,
    text: `Hi ${email.name},\n\n${email.message}\n\n${action}: ${url.href}`,
    html: `<h1>${escapeHtml(email.title)}</h1><p>Hi ${escapeHtml(email.name)},</p><p>${escapeHtml(email.message)}</p><p><a href="${escapeHtml(url.href)}">${action}</a></p>`,
  };
}
