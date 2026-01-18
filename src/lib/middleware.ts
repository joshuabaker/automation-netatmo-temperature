import type { Context, Next } from "hono";

/**
 * Middleware to verify API_SECRET for external cron services
 * Accepts: Authorization: Bearer <secret>
 */
export async function requireApiSecret(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");
  const apiSecret = process.env.API_SECRET;

  if (!apiSecret) {
    console.error("[Auth] API_SECRET environment variable not configured");
    return c.json({ error: "Server misconfigured" }, 500);
  }

  if (authHeader === `Bearer ${apiSecret}`) {
    return next();
  }

  console.warn("[Auth] Unauthorized request");
  return c.json({ error: "Unauthorized" }, 401);
}
