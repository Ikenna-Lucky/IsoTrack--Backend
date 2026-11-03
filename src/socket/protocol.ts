import { z } from "zod";

export const trackingIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
export const locationSchema = z
  .object({
    trackingId: trackingIdSchema,
    lat: z.number().finite().min(-90).max(90),
    lng: z.number().finite().min(-180).max(180),
    heading: z.number().finite().min(0).lt(360).optional(),
    speed: z.number().finite().min(0).max(100).optional(),
    timestamp: z.number().int().nonnegative().safe(),
  })
  .strict();

export type LocationPayload = z.infer<typeof locationSchema>;
export interface SocketIdentity {
  socketId: string;
  userId: string;
  sessionId: string;
  expiresAt: number;
}
export interface SocketGrant {
  socketId: string;
  role: "business" | "driver" | "customer";
}

export function isFreshLocation(
  location: LocationPayload,
  now: number,
): boolean {
  return (
    location.timestamp >= now - 30_000 && location.timestamp <= now + 5_000
  );
}
