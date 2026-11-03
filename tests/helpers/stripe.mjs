import { createServer } from "node:http";
import { once } from "node:events";
import Stripe from "stripe";

export async function stripeFixture() {
  const requests = [];
  const sessions = new Map();
  const intents = new Map();
  const refunds = new Map();
  let drop = 0;
  let transform = (value) => value;
  let gate = null;
  let unlock;
  let sequence = 0;
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, "http://localhost").pathname;
    if (
      request.method === "GET" &&
      (path.startsWith("/v1/payment_intents/") ||
        path.startsWith("/v1/refunds/"))
    ) {
      const value = (path.startsWith("/v1/refunds/") ? refunds : intents).get(
        path.split("/")[3],
      );
      response.writeHead(value ? 200 : 404, {
        "content-type": "application/json",
      });
      response.end(
        JSON.stringify(
          value ?? { error: { message: "Missing fixture object" } },
        ),
      );
      return;
    }
    if (request.method === "GET" || path.endsWith("/expire")) {
      const id = path.split("/")[4];
      const saved = [...sessions.values()].find(
        (value) => value.session.id === id,
      );
      if (!saved) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "No such session" } }));
        return;
      }
      if (path.endsWith("/expire") && saved.session.status === "open")
        saved.session.status = "expired";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(transform(saved.session)));
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const key = request.headers["idempotency-key"];
    requests.push({ key, body, version: request.headers["stripe-version"] });
    const params = new URLSearchParams(body);
    let saved = sessions.get(key);
    if (saved && saved.body !== body) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { type: "idempotency_error", message: "Changed parameters" },
        }),
      );
      return;
    }
    if (!saved) {
      const id = `cs_test_${++sequence}`;
      saved = {
        body,
        session: {
          id,
          object: "checkout.session",
          mode: "payment",
          status: "open",
          payment_status: "unpaid",
          livemode: false,
          url: `https://checkout.stripe.com/c/pay/${id}`,
          amount_total: Number(
            params.get("line_items[0][price_data][unit_amount]"),
          ),
          currency: params.get("line_items[0][price_data][currency]"),
          client_reference_id: params.get("client_reference_id"),
          metadata: {
            reference: params.get("metadata[reference]"),
            shipmentId: params.get("metadata[shipmentId]"),
          },
        },
      };
      sessions.set(key, saved);
    }
    if (gate) await gate;
    if (drop) {
      drop--;
      request.socket.destroy();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(transform(saved.session)));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const stripe = new Stripe("sk_test_local_contract_fixture", {
    host: "127.0.0.1",
    port: server.address().port,
    protocol: "http",
    apiVersion: "2026-10-28.endive",
    timeout: 10000,
    maxNetworkRetries: 0,
  });
  return {
    requests,
    sessions,
    intents,
    refunds,
    client: stripe,
    create: (params, key) =>
      stripe.checkout.sessions.create(params, { idempotencyKey: key }),
    dropNextResponse() {
      // The SDK always retries the first connection reset, even with configured
      // retries disabled. Lose both responses to expose the unknown outcome.
      drop = 2;
    },
    transform(value) {
      transform = value;
    },
    hold() {
      gate = new Promise((resolve) => {
        unlock = resolve;
      });
      return () => {
        gate = null;
        unlock();
      };
    },
    reset() {
      requests.length = 0;
      sessions.clear();
      intents.clear();
      refunds.clear();
      drop = 0;
      transform = (value) => value;
    },
    async close() {
      unlock?.();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
