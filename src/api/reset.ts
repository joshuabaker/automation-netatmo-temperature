import { Hono } from "hono";
import { handle } from "hono/vercel";
import { createRedis, EventLogger } from "../lib/redis.js";
import { createNetatmoClient } from "../lib/netatmo.js";
import { createQStashClient } from "../lib/qstash.js";
import type { ResetPayload } from "../types.js";

const app = new Hono();

app.post("/reset", async (c) => {
  console.log("[Reset] Received reset callback");

  try {
    const rawBody = await c.req.text();
    const qstashSignature = c.req.header("upstash-signature");

    if (!qstashSignature) {
      console.error("[Reset] Missing QStash signature");
      return c.json({ error: "Unauthorized" }, 401);
    }

    const qstash = createQStashClient();
    const isAuthorized = await qstash.verifySignature(qstashSignature, rawBody);

    if (!isAuthorized) {
      console.error("[Reset] Invalid QStash signature");
      return c.json({ error: "Unauthorized" }, 401);
    }

    console.log("[Reset] Authorized via QStash signature");

    const payload: ResetPayload = JSON.parse(rawBody);
    const { homeId, roomId, originalSetpoint, homeName, roomName } = payload;

    if (!homeId || !roomId) {
      console.error("[Reset] Invalid payload - missing homeId or roomId");
      return c.json({ error: "Invalid payload" }, 400);
    }

    const displayName =
      homeName && roomName ? `${homeName}/${roomName}` : `${homeId}/${roomId}`;
    console.log(`[Reset] Resetting ${displayName} back to home mode`);

    const redis = createRedis();
    const netatmo = createNetatmoClient(redis);
    const eventLogger = new EventLogger(redis);

    const homeStatus = await netatmo.getHomeStatus(homeId);
    const room = netatmo.getRoomFromStatus(homeStatus, roomId);
    const currentTemp = room?.therm_measured_temperature ?? 0;

    await netatmo.setRoomToHome(homeId, roomId);
    await eventLogger.logResetCompleted(homeId, roomId, currentTemp, originalSetpoint);

    console.log(
      `[Reset] Successfully reset ${displayName} to home mode. Current temp: ${currentTemp}°C`
    );

    return c.json({
      status: "reset_completed",
      homeId,
      roomId,
      homeName,
      roomName,
      currentTemp,
      originalSetpoint,
    });
  } catch (error) {
    console.error("[Reset] Error during reset:", error);
    return c.json(
      {
        error: "Failed to reset room",
        details: error instanceof Error ? error.message : String(error),
      },
      500
    );
  }
});

export const POST = handle(app);
