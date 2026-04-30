import { Hono } from "hono";

export const authRouter = new Hono();

// POST /api/v1/auth/register
authRouter.post("/register", async (c) => {
  return c.json(
    { success: true, message: "Auth router — register (Phase 4)" },
    501,
  );
});

// POST /api/v1/auth/login
authRouter.post("/login", async (c) => {
  return c.json(
    { success: true, message: "Auth router — login (Phase 4)" },
    501,
  );
});

// POST /api/v1/auth/refresh
authRouter.post("/refresh", async (c) => {
  return c.json(
    { success: true, message: "Auth router — refresh (Phase 4)" },
    501,
  );
});

// POST /api/v1/auth/logout
authRouter.post("/logout", async (c) => {
  return c.json(
    { success: true, message: "Auth router — logout (Phase 4)" },
    501,
  );
});

// GET /api/v1/auth/me
authRouter.get("/me", async (c) => {
  return c.json({ success: true, message: "Auth router — me (Phase 4)" }, 501);
});
