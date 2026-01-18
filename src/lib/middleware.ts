import type { Context, Next } from "hono";

/**
 * Middleware to verify Vercel Cron requests via CRON_SECRET
 */
export async function requireCronSecret(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    console.error("[Auth] CRON_SECRET environment variable not configured");
    return c.json({ error: "Server misconfigured" }, 500);
  }

  if (authHeader === `Bearer ${cronSecret}`) {
    return next();
  }

  console.warn("[Auth] Unauthorized request - invalid or missing cron secret");
  return c.json({ error: "Unauthorized" }, 401);
}
