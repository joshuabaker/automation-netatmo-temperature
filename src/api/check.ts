import { Hono } from "hono";
import { handle } from "hono/vercel";
import { createRedis, EventLogger } from "../lib/redis.js";
import { createNetatmoClient } from "../lib/netatmo.js";
import { createQStashClient } from "../lib/qstash.js";
import { requireApiSecret } from "../lib/middleware.js";
import type { ResetPayload } from "../types.js";

const OVERAGE_THRESHOLD = 1.0; // °C above setpoint to trigger reset

const app = new Hono();

app.get("/health", (c) => {
  return c.json({ status: "healthy", timestamp: new Date().toISOString() });
});

app.use("/check", requireApiSecret);

app.get("/check", async (c) => {
  console.log("[Check] Starting temperature check for all thermostats");

  try {
    const redis = createRedis();
    const netatmo = createNetatmoClient(redis);
    const eventLogger = new EventLogger(redis);
    const qstash = createQStashClient();

    const thermostats = await netatmo.getAllThermostats();

    if (thermostats.length === 0) {
      console.log("[Check] No thermostats found");
      return c.json({
        status: "ok",
        message: "No thermostats found",
        checked: 0,
        overages: 0,
      });
    }

    const results: Array<{
      home: string;
      room: string;
      currentTemp: number;
      setpoint: number;
      diff: string;
      action: string;
      qstashMessageId?: string;
    }> = [];

    let overageCount = 0;

    for (const thermostat of thermostats) {
      const { homeId, homeName, roomId, roomName, currentTemp, setpoint, reachable } =
        thermostat;

      if (!reachable) {
        console.log(`[Check] Skipping unreachable room "${roomName}" in "${homeName}"`);
        results.push({
          home: homeName,
          room: roomName,
          currentTemp,
          setpoint,
          diff: "N/A",
          action: "skipped_unreachable",
        });
        continue;
      }

      const diff = currentTemp - setpoint;

      console.log(
        `[Check] ${homeName}/${roomName}: Current: ${currentTemp}°C, Setpoint: ${setpoint}°C, Diff: ${diff.toFixed(2)}°C`
      );

      if (diff > OVERAGE_THRESHOLD) {
        console.log(
          `[Check] OVERAGE in "${roomName}"! Temperature is ${diff.toFixed(2)}°C above setpoint`
        );
        overageCount++;

        await eventLogger.logOverageDetected(homeId, roomId, currentTemp, setpoint);
        await netatmo.setRoomToMax(homeId, roomId);
        await eventLogger.logResetTriggered(homeId, roomId, currentTemp, setpoint);

        const resetPayload: ResetPayload = {
          homeId,
          roomId,
          originalSetpoint: setpoint,
          homeName,
          roomName,
        };
        const messageId = await qstash.scheduleReset(resetPayload);

        results.push({
          home: homeName,
          room: roomName,
          currentTemp,
          setpoint,
          diff: diff.toFixed(2),
          action: "reset_triggered",
          qstashMessageId: messageId,
        });
      } else {
        results.push({
          home: homeName,
          room: roomName,
          currentTemp,
          setpoint,
          diff: diff.toFixed(2),
          action: "none",
        });
      }
    }

    console.log(
      `[Check] Completed. Checked ${thermostats.length} rooms, found ${overageCount} overages`
    );

    return c.json({
      status: overageCount > 0 ? "overages_detected" : "ok",
      checked: thermostats.length,
      overages: overageCount,
      results,
    });
  } catch (error) {
    console.error("[Check] Error during temperature check:", error);
    return c.json(
      {
        error: "Failed to check temperature",
        details: error instanceof Error ? error.message : String(error),
      },
      500
    );
  }
});

export const GET = handle(app);
