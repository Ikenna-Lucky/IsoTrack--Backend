import assert from "node:assert/strict";
import { test } from "node:test";
import { createMicrosoftMail } from "../src/services/microsoft-mail.ts";
const config = {
  MICROSOFT_MAIL_CLIENT_ID: "11111111-1111-4111-8111-111111111111",
  MICROSOFT_MAIL_SENDER: "sender@outlook.com",
  MICROSOFT_MAIL_CACHE_KEY: "ab".repeat(32),
};
test("Microsoft authorization rejects a different sender and persists renewed cache before sending across restarts", async () => {
  let encrypted = null,
    lease = null,
    accountName = "wrong@outlook.com",
    refreshes = 0,
    sends = 0;
  const forces = [];
  const database = {
    query: async (text, params) => {
      if (text.startsWith("insert")) {
        assert.equal(lease, null);
        lease = params[1];
        return [{ encrypted_cache: encrypted }];
      }
      if (text.includes("set encrypted_cache")) {
        assert.equal(params[1], lease);
        encrypted = params[2];
        lease = null;
        return [{ id: params[0] }];
      }
      if (params[1] === lease) lease = null;
      return [];
    },
  };
  const application = () => {
    let cache = { username: accountName, revision: 0 };
    return {
      getTokenCache: () => ({
        deserialize: (raw) => {
          cache = JSON.parse(raw);
        },
        serialize: () => JSON.stringify(cache),
        getAllAccounts: async () => [{ username: cache.username }],
      }),
      acquireTokenByDeviceCode: async ({ scopes }) => {
        assert.deepEqual(scopes, ["https://graph.microsoft.com/Mail.Send"]);
        return { account: { username: accountName } };
      },
      acquireTokenSilent: async ({ account, forceRefresh }) => {
        assert.equal(account.username, "sender@outlook.com");
        refreshes++;
        forces.push(forceRefresh);
        cache.revision++;
        return {
          accessToken: "fixture-token",
          expiresOn: new Date(Date.now() + 3600000),
        };
      },
    };
  };
  const mail = createMicrosoftMail(config, database, application);
  await assert.rejects(
    mail.authorize(() => {}),
    /configured Outlook sender/,
  );
  assert.equal(encrypted, null);
  accountName = "sender@outlook.com";
  await mail.authorize(() => {});
  assert.ok(encrypted && !encrypted.includes(accountName));
  const originalFetch = globalThis.fetch;
  let rejectToken = false;
  globalThis.fetch = async (url, request) => {
    assert.equal(url, "https://graph.microsoft.com/v1.0/me/sendMail");
    assert.ok(encrypted);
    assert.equal(lease, null);
    assert.equal(request.headers.Authorization, "Bearer fixture-token");
    sends++;
    if (rejectToken) {
      rejectToken = false;
      return new Response(null, { status: 401 });
    }
    return new Response(null, { status: 202 });
  };
  try {
    const sending = createMicrosoftMail(config, database, application);
    const email = {
      to: "recipient@example.test",
      subject: "Review",
      text: "Fixture only",
    };
    await Promise.all(Array.from({ length: 5 }, () => sending.send(email)));
    assert.equal(refreshes, 1);
    assert.equal(sends, 5);
    const restarted = createMicrosoftMail(config, database, application);
    await restarted.send(email);
    assert.equal(refreshes, 2);
    rejectToken = true;
    await restarted.send(email);
    assert.deepEqual(forces, [false, false, true]);
    assert.equal(sends, 8);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
