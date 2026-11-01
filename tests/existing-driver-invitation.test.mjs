import assert from "node:assert/strict";
import { test } from "node:test";
import { createExistingDriverInvitationRouter } from "../src/routes/existing-driver-invitation.ts";

const token = "a".repeat(43);
function setup(
  role = "driver",
  result = { userId: "signed-in", driverId: "driver", businessId: "business" },
) {
  const calls = [];
  const router = createExistingDriverInvitationRouter({
    authenticate: async (c, next) => {
      if (!c.req.header("Authorization"))
        return c.json({ success: false }, 401);
      c.set("userId", "signed-in");
      c.set("userRole", role);
      await next();
    },
    accept: async (...args) => {
      calls.push(args);
      return result;
    },
  });
  const request = (body, authenticated = true) =>
    router.request("/accept-existing", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authenticated ? { Authorization: "test identity" } : {}),
      },
      body: JSON.stringify(body),
    });
  return { request, calls };
}

test("existing-driver HTTP endpoint requires authentication before enrollment", async () => {
  const { request, calls } = setup();
  assert.equal((await request({ token }, false)).status, 401);
  assert.equal(calls.length, 0);
});

test("business and customer identities cannot use driver enrollment", async () => {
  for (const role of ["business", "customer"]) {
    const { request, calls } = setup(role);
    assert.equal((await request({ token })).status, 403);
    assert.equal(calls.length, 0);
  }
});

test("malformed tokens and caller-supplied identity fields are rejected", async () => {
  const { request, calls } = setup();
  for (const body of [
    { token: "short" },
    { token, userId: "victim" },
    { token, email: "victim@example.test" },
    {},
  ]) {
    assert.equal((await request(body)).status, 400);
  }
  assert.equal(calls.length, 0);
});

test("valid HTTP acceptance uses only the authenticated identity", async () => {
  const { request, calls } = setup();
  const response = await request({ token });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [["signed-in", token]]);
  assert.equal((await response.json()).data.businessId, "business");
});

test("unavailable enrollment returns conflict without membership details", async () => {
  const { request } = setup("driver", null);
  const response = await request({ token });
  assert.equal(response.status, 409);
  assert.equal(Object.hasOwn(await response.json(), "data"), false);
});
