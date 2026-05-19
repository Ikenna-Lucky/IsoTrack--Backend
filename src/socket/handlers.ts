import type { Server, Socket } from "socket.io";

export interface LocationPayload {
  trackingId: string;
  lat: number;
  lng: number;
  heading?: number;
  speed?: number;
  timestamp: number;
}

function isValidLocation(data: unknown): data is LocationPayload {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.trackingId === "string" &&
    typeof d.lat === "number" &&
    typeof d.lng === "number" &&
    typeof d.timestamp === "number" &&
    d.lat >= -90 &&
    d.lat <= 90 &&
    d.lng >= -180 &&
    d.lng <= 180
  );
}

export function registerSocketHandlers(io: Server): void {
  io.on("connection", (socket: Socket) => {
    console.log(`[WS] connected: ${socket.id}`);

    socket.on("shipment:join", (trackingId: string) => {
      if (typeof trackingId !== "string" || !trackingId.trim()) return;
      void socket.join(`shipment:${trackingId}`);
      socket.emit("shipment:joined", { trackingId });
      console.log(`[WS] ${socket.id} → room shipment:${trackingId}`);
    });

    socket.on("shipment:leave", (trackingId: string) => {
      void socket.leave(`shipment:${trackingId}`);
    });

    socket.on("driver:location", (data: unknown) => {
      if (!isValidLocation(data)) {
        socket.emit("error", { message: "Invalid location payload" });
        return;
      }

      socket.to(`shipment:${data.trackingId}`).emit("driver:location", {
        lat: data.lat,
        lng: data.lng,
        heading: data.heading ?? 0,
        speed: data.speed ?? 0,
        timestamp: data.timestamp,
      });
    });

    socket.on("disconnect", (reason) => {
      console.log(`[WS] disconnected: ${socket.id} (${reason})`);
    });
  });
}
