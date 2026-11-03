import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import {
  createAccountActionRouter,
  accountPassword,
} from "../src/routes/account-actions.ts";
import {
  actionToken,
  actionHash,
  actionId,
  newActionId,
  actionPeerHash,
} from "../src/lib/account-action-token.ts";
import {
  renderAccountEmail,
  startAccountEmailDispatcher,
} from "../src/workers/account-email.ts";

const key = randomBytes(32).toString("hex");
function fixture(overrides = {}) {
  let calls = 0;
  const app = createAccountActionRouter({
    key,
    store: {
      execute: async () => {
        calls++;
        return [{ allowed: true }];
      },
    },
    peer: () => "127.0.0.1",
    reportError: () => {},
    ...overrides,
  });
  return { app, calls: () => calls };
}
const request = (app, path, body, headers = {}) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("account token proofs are domain-separated, hashable and never include email or password", () => {
  const id = newActionId();
  const reset = actionToken(id, "reset_password", key);
  const verification = actionToken(id, "verify_email", key);
  assert.equal(reset.length, 87);
  assert.equal(actionId(reset), id);
  assert.notEqual(reset, verification);
  assert.equal(actionHash(reset).length, 64);
  assert.notEqual(
    actionPeerHash("127.0.0.1", key),
    actionPeerHash("127.0.0.2", key),
  );
  assert.notEqual(
    actionPeerHash("127.0.0.1", key),
    actionPeerHash("127.0.0.1", randomBytes(32).toString("hex")),
  );
  assert.equal(actionId("malformed"), null);
  assert.throws(() => actionToken(id, "reset_password", "invalid"));
});

test("account action routes enforce strict inputs, body limits and no-store responses", async () => {
  const { app } = fixture();
  for (const body of [
    { email: "bad" },
    { email: "a@example.test", userId: "spoof" },
    "{broken",
  ]) {
    assert.equal((await request(app, "/forgot-password", body)).status, 400);
  }
  assert.equal(
    (
      await request(
        app,
        "/forgot-password",
        { email: "a@example.test" },
        { "content-type": "text/plain" },
      )
    ).status,
    400,
  );
  const oversized = await request(app, "/forgot-password", {
    email: "a".repeat(5000),
  });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.headers.get("cache-control"), "no-store");
  for (const newPassword of [
    "short",
    "lowercase123",
    `Password1${"a".repeat(72)}`,
    `Password1${"é".repeat(33)}`,
  ]) {
    assert.equal(
      (
        await request(app, "/reset-password", {
          token: actionToken(newActionId(), "reset_password", key),
          newPassword,
        })
      ).status,
      400,
    );
  }
  assert.ok(accountPassword.safeParse(`Password1${"a".repeat(63)}`).success);
  assert.ok(!accountPassword.safeParse(`Password1${"é".repeat(32)}`).success);
});

test("missing configuration or peer fails closed and storage errors expose no secrets", async () => {
  for (const override of [{ key: undefined }, { peer: () => undefined }]) {
    const { app, calls } = fixture(override);
    const response = await request(app, "/forgot-password", {
      email: "a@example.test",
    });
    assert.equal(response.status, 503);
    assert.equal(calls(), 0);
  }
  const { app } = fixture({
    store: {
      execute: async () => {
        throw new Error("database secret and private@example.test");
      },
    },
  });
  const response = await request(app, "/forgot-password", {
    email: "a@example.test",
  });
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes("private@example.test"));
  const parent = new Hono()
    .route("/auth", fixture({ key: undefined }).app)
    .get("/auth/unrelated", (c) => c.json({ ok: true }));
  assert.equal((await parent.request("/auth/unrelated")).status, 200);
});

test("account email renderer rejects unsafe origins and keeps tokens out of query parameters", () => {
  const id = newActionId();
  for (const frontend of [
    "http://evil.example.test",
    "https://user:password@app.example.test",
  ]) {
    assert.throws(() =>
      renderAccountEmail(id, "reset_password", "a@example.test", key, frontend),
    );
  }
  const email = renderAccountEmail(
    id,
    "verify_email",
    "a@example.test",
    key,
    "https://app.example.test/path",
  );
  const url = new URL(email.text.match(/https:\/\/\S+/)[0]);
  assert.equal(url.origin, "https://app.example.test");
  assert.equal(url.pathname, "/verify-email");
  assert.equal(url.search, "");
  assert.ok(url.hash.startsWith("#token="));
});

test("account email dispatcher drains an active batch before stopping", async () => {
  let release;
  let markStarted;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  let completed = false;
  const close = startAccountEmailDispatcher(
    async () => {
      markStarted();
      await gate;
      completed = true;
    },
    () => assert.fail("unexpected dispatch failure"),
  );
  await started;
  let closed = false;
  const closing = close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  release();
  await closing;
  assert.ok(completed);
});
