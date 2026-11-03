import { createServer } from "node:net";
import { once } from "node:events";

export async function smtpFixture() {
  const accepted = [];
  const sockets = new Set();
  let reject = false;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.write("220 localhost test SMTP\r\n");
    let buffer = "";
    let data = false;
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      for (;;) {
        if (data) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) break;
          const message = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          data = false;
          if (reject) socket.write("451 temporary test delivery failure\r\n");
          else {
            accepted.push(message);
            socket.write("250 accepted\r\n");
          }
        } else {
          const end = buffer.indexOf("\r\n");
          if (end < 0) break;
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (/^EHLO|^HELO/i.test(line)) socket.write("250 localhost\r\n");
          else if (/^DATA$/i.test(line)) {
            data = true;
            socket.write("354 send message\r\n");
          } else if (/^QUIT$/i.test(line)) {
            socket.end("221 bye\r\n");
            return;
          } else socket.write("250 ok\r\n");
        }
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    port: server.address().port,
    accepted,
    reject(value) {
      reject = value;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
