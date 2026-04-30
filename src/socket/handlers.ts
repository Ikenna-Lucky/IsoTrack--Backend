import type { Server, Socket } from "socket.io";

/**
 * Register all Socket.io event handlers.
 * Full implementation in Phase 6 (Real-Time Tracking).
 */
export function registerSocketHandlers(io: Server): void {
  io.on("connection", (socket: Socket) => {
    console.log(`[WS] Client connected: ${socket.id}`);

    // Join a shipment room to receive updates for that shipment
    socket.on("shipment:join", (trackingId: string) => {
      socket.join(`shipment:${trackingId}`);
      console.log(`[WS] ${socket.id} joined room shipment:${trackingId}`);
    });

    // Driver location update — Phase 6
    socket.on("driver:location", (_data: unknown) => {
      // TODO: Phase 6 — validate, persist, and broadcast to shipment room
    });

    socket.on("disconnect", (reason) => {
      console.log(`[WS] Client disconnected: ${socket.id} (${reason})`);
    });
  });
}
