import { createServer } from "node:http";
import { once } from "node:events";
import { createGraphEmailSender } from "../../src/lib/graph-email.ts";

export function createGraphTestTransport({ port }) {
  return {
    send: createGraphEmailSender(
      async () => "fixture-token",
      fetch,
      `http://127.0.0.1:${port}/v1.0/me/sendMail`,
    ),
    close() {},
  };
}
export async function graphFixture() {
  const accepted = [];
  let reject = false;
  const server = createServer(async (req, res) => {
    if (
      req.method !== "POST" ||
      req.url !== "/v1.0/me/sendMail" ||
      req.headers.authorization !== "Bearer fixture-token"
    ) {
      res.writeHead(401).end();
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (reject) {
      res.writeHead(500).end();
      return;
    }
    const { message } = JSON.parse(raw);
    const id = message.internetMessageHeaders?.find(
      (value) => value.name === "x-isotrack-message-id",
    )?.value;
    accepted.push(
      `To: ${message.toRecipients[0].emailAddress.address}\r\nMessage-ID: ${id ?? ""}\r\nSubject: ${message.subject}\r\n\r\n${message.body.content}`,
    );
    res.writeHead(202).end();
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
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
