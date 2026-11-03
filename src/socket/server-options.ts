import type { ServerOptions } from "socket.io";

export function trackingServerOptions(
  frontendUrl: string,
): Partial<ServerOptions> {
  const origin = new URL(frontendUrl).origin;
  return {
    maxHttpBufferSize: 8192,
    allowRequest: (request, callback) =>
      callback(
        null,
        request.headers.origin === undefined ||
          request.headers.origin === origin,
      ),
    cors: { origin, methods: ["GET", "POST"], credentials: true },
    transports: ["websocket", "polling"],
    // Recovery is deliberately disabled: reconnects must authenticate and rejoin.
  };
}
