import assert from "node:assert/strict";
import { test } from "node:test";
import { createGraphEmailSender } from "../src/lib/graph-email.ts";
import {
  encryptMailCache,
  decryptMailCache,
} from "../src/lib/mail-token-cache.ts";
import { microsoftMailConfig } from "../src/lib/microsoft-mail-config.ts";
test("Graph sends JSON using the authorized mailbox and accepts only empty HTTP 202", async () => {
  let calls = 0;
  const send = createGraphEmailSender(
    async () => "private-token",
    async (url, request) => {
      calls++;
      assert.equal(url, "https://graph.microsoft.com/v1.0/me/sendMail");
      assert.equal(request.headers.Authorization, "Bearer private-token");
      assert.equal(request.redirect, "error");
      assert.ok(request.signal);
      const body = JSON.parse(request.body);
      assert.equal(body.message.from, undefined);
      assert.equal(
        body.message.toRecipients[0].emailAddress.address,
        "recipient@example.test",
      );
      assert.equal(body.message.body.contentType, "HTML");
      assert.equal(
        body.message.internetMessageHeaders[0].name,
        "x-isotrack-message-id",
      );
      return new Response(null, { status: 202 });
    },
  );
  await send({
    to: "recipient@example.test",
    subject: "Verify",
    text: "Text",
    html: "<p>Verify</p>",
    messageId: "<fixture@example.test>",
  });
  assert.equal(calls, 1);
  await assert.rejects(
    send({ to: "bad-address", subject: "Verify", text: "Text" }),
  );
  assert.equal(calls, 1);
});
test("Graph refreshes once on 401, honors throttling and never leaks provider errors or retries uncertain sends inline", async () => {
  const email = {
    to: "recipient@example.test",
    subject: "Verify",
    text: "private-link",
  };
  const tokens = [],
    statuses = [401, 202];
  await createGraphEmailSender(
    async (force) => {
      tokens.push(force);
      return "secret";
    },
    async () => new Response(null, { status: statuses.shift() }),
  )(email);
  assert.deepEqual(tokens, [false, true]);
  for (const status of [200, 400, 403, 500, 302]) {
    let calls = 0;
    const send = createGraphEmailSender(
      async () => "secret",
      async () => {
        calls++;
        return new Response("private-provider-response", { status });
      },
    );
    await assert.rejects(
      send(email),
      (error) =>
        error.message.includes(String(status)) &&
        !error.message.includes("private"),
    );
    assert.equal(calls, 1);
  }
  let calls = 0;
  const throttled = createGraphEmailSender(
    async () => "secret",
    async () => {
      calls++;
      return new Response(null, {
        status: 429,
        headers: { "Retry-After": "60" },
      });
    },
  );
  await assert.rejects(throttled(email));
  await assert.rejects(throttled(email));
  assert.equal(calls, 1);
  const uncertain = createGraphEmailSender(
    async () => "secret",
    async () => {
      throw new Error("request included private credentials");
    },
  );
  await assert.rejects(uncertain(email), /could not be confirmed/);
});
test("mail cache is encrypted, authenticated and bound to the configured client/mailbox", () => {
  const key = "ab".repeat(32),
    identity = "fixture:sender@outlook.com";
  const value = encryptMailCache("private-refresh-token", key, identity);
  assert.ok(!value.includes("private"));
  assert.equal(decryptMailCache(value, key, identity), "private-refresh-token");
  assert.notEqual(
    value,
    encryptMailCache("private-refresh-token", key, identity),
  );
  assert.throws(() => decryptMailCache(value, "cd".repeat(32), identity));
  assert.throws(() => decryptMailCache(value, key, "other-mailbox"));
  assert.throws(() => decryptMailCache(value.slice(0, -3), key, identity));
  assert.throws(() => microsoftMailConfig({}));
  assert.throws(() =>
    microsoftMailConfig({
      MICROSOFT_MAIL_CLIENT_ID: "not-an-id",
      MICROSOFT_MAIL_SENDER: "sender@outlook.com",
      MICROSOFT_MAIL_CACHE_KEY: key,
    }),
  );
});
