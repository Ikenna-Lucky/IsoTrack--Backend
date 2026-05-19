import nodemailer from "nodemailer";
import { env } from "@/lib/env";

export const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: env.GMAIL_USER,
    pass: env.GMAIL_APP_PASSWORD,
  },
});

function baseTemplate(title: string, body: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#09090b;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#09090b;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#111113;border:1px solid rgba(255,255,255,0.08);border-radius:16px;overflow:hidden;max-width:560px;width:100%;">
          
          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#0f4c41,#0c3d34);padding:28px 32px;">
              <span style="font-size:22px;font-weight:800;color:#2dd4bf;letter-spacing:-0.5px;">IsoTrack</span>
              <span style="font-size:11px;color:rgba(45,212,191,0.5);margin-left:8px;letter-spacing:3px;text-transform:uppercase;">Logistics</span>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:32px;">
              ${body}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 32px;border-top:1px solid rgba(255,255,255,0.06);">
              <p style="margin:0;font-size:11px;color:#52526a;text-align:center;">
                © ${new Date().getFullYear()} IsoTrack · You received this because you have an active shipment.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function statusBadge(label: string, color: string): string {
  return `<span style="display:inline-block;background:${color}1a;border:1px solid ${color}33;color:${color};font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;padding:4px 12px;border-radius:999px;">${label}</span>`;
}

function metaRow(label: string, value: string): string {
  return `
  <tr>
    <td style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.05);">
      <span style="font-size:11px;color:#71717a;text-transform:uppercase;letter-spacing:1px;">${label}</span>
    </td>
    <td style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.05);text-align:right;">
      <span style="font-size:13px;color:#e4e4e7;font-weight:500;">${value}</span>
    </td>
  </tr>`;
}

export interface ShipmentEmailData {
  trackingId: string;
  customerName: string;
  customerEmail: string;
  pickup: string;
  delivery: string;
  packageType: string;
  amount: string;
  driverName?: string;
  eta?: string;
}

export type ShipmentMilestone = "assigned" | "picked_up" | "delivered" | "failed";

const MILESTONE_CONFIG: Record<ShipmentMilestone, { subject: string; badge: string; badgeColor: string; headline: string; sub: string }> = {
  assigned: {
    subject: "Driver assigned to your shipment",
    badge: "Driver Assigned",
    badgeColor: "#0ea5e9",
    headline: "Your driver is on the way!",
    sub: "A driver has accepted your shipment and is heading to pick it up.",
  },
  picked_up: {
    subject: "Your package has been picked up",
    badge: "Picked Up",
    badgeColor: "#8b5cf6",
    headline: "Package collected — en route!",
    sub: "Your driver has collected your package and is heading to the destination.",
  },
  delivered: {
    subject: "Your package has been delivered ✓",
    badge: "Delivered",
    badgeColor: "#10b981",
    headline: "Delivery complete!",
    sub: "Your package has been successfully delivered. Thank you for using IsoTrack.",
  },
  failed: {
    subject: "Delivery attempt was unsuccessful",
    badge: "Delivery Failed",
    badgeColor: "#f43f5e",
    headline: "We couldn't complete your delivery",
    sub: "Our driver was unable to deliver your package. Please contact support to reschedule.",
  },
};

export async function sendShipmentMilestoneEmail(
  milestone: ShipmentMilestone,
  data: ShipmentEmailData,
): Promise<void> {
  const config = MILESTONE_CONFIG[milestone];

  const body = `
    <div style="margin-bottom:24px;">
      ${statusBadge(config.badge, config.badgeColor)}
    </div>

    <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#f4f4f5;">${config.headline}</h1>
    <p style="margin:0 0 28px;font-size:14px;color:#71717a;line-height:1.6;">Hi ${data.customerName}, ${config.sub}</p>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
      ${metaRow("Tracking ID", `<span style="font-family:monospace;">${data.trackingId}</span>`)}
      ${metaRow("Package Type", data.packageType)}
      ${metaRow("Pickup", data.pickup)}
      ${metaRow("Delivery", data.delivery)}
      ${data.driverName ? metaRow("Driver", data.driverName) : ""}
      ${data.eta ? metaRow("ETA", data.eta) : ""}
      ${metaRow("Amount", data.amount)}
    </table>

    <a href="http://localhost:3000/customer/track?id=${data.trackingId}"
       style="display:inline-block;background:#0f766e;color:#fff;font-size:14px;font-weight:600;text-decoration:none;padding:12px 28px;border-radius:10px;">
      Track Your Shipment →
    </a>
  `;

  await transporter.sendMail({
    from: env.EMAIL_FROM,
    to: data.customerEmail,
    subject: `[${data.trackingId}] ${config.subject}`,
    html: baseTemplate(config.subject, body),
  });
}
