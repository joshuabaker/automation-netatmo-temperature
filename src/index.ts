import { Hono } from "hono";
import { createNetatmoClient } from "./lib/netatmo.js";
import { createRedis, EventLogger } from "./lib/redis.js";

// Drift detection settings
const MIN_MINUTES_SINCE_DROP = 10; // Minutes after setpoint drop to check
const MIN_TEMP_RISE = 0.5; // Minimum °C rise to trigger (setpoint dropped but temp went up)

const app = new Hono();

app.get("/health", (c) => {
  return c.json({ status: "healthy", timestamp: new Date().toISOString() });
});

app.get("/check", async (c) => {
  // Verify API secret
  const authHeader = c.req.header("Authorization");
  const apiSecret = process.env.API_SECRET;

  if (!apiSecret) {
    console.error("[Auth] API_SECRET environment variable not configured");
    return c.json({ error: "Server misconfigured" }, 500);
  }

  if (authHeader !== `Bearer ${apiSecret}`) {
    console.warn("[Auth] Unauthorized request");
    return c.json({ error: "Unauthorized" }, 401);
  }

  console.log("[Check] Starting temperature check for all thermostats");

  try {
    const redis = createRedis();
    const netatmo = createNetatmoClient(redis);
    const eventLogger = new EventLogger(redis);

    const thermostats = await netatmo.getAllThermostats();

    if (thermostats.length === 0) {
      console.log("[Check] No thermostats found");
      return c.json({
        status: "ok",
        message: "No thermostats found",
        checked: 0,
        drifts: 0,
      });
    }

    const results: Array<{
      home: string;
      room: string;
      currentTemp: number;
      setpoint: number;
      action: string;
      drift?: {
        tempAtDrop: number;
        tempRise: number;
        minutesSinceDrop: number;
      };
    }> = [];

    let driftCount = 0;

    for (const thermostat of thermostats) {
      const {
        homeId,
        homeName,
        roomId,
        roomName,
        currentTemp,
        setpoint,
        reachable,
        mode,
        serverTime,
      } = thermostat;

      if (!reachable) {
        console.log(
          `[Check] Skipping unreachable room "${roomName}" in "${homeName}"`
        );
        results.push({
          home: homeName,
          room: roomName,
          currentTemp,
          setpoint,
          action: "skipped_unreachable",
        });
        continue;
      }

      // Failsafe: Reset any stuck MAX mode rooms
      if (mode === "max") {
        console.log(
          `[Check] FAILSAFE: Room "${roomName}" stuck in MAX mode, resetting to home`
        );
        await netatmo.setRoomToHome(homeId, roomId);
        await eventLogger.logResetCompleted(
          homeId,
          roomId,
          currentTemp,
          setpoint
        );
        results.push({
          home: homeName,
          room: roomName,
          currentTemp,
          setpoint,
          action: "failsafe_reset",
        });
        continue;
      }

      // Get historical data for drift detection (last 30 minutes)
      const dateBegin = serverTime - 30 * 60; // 30 minutes ago
      const measureResponse = await netatmo.getRoomMeasure(
        homeId,
        roomId,
        "30min",
        dateBegin,
        serverTime
      );

      const points = netatmo.parseMeasureData(measureResponse);

      console.log(
        `[Check] ${homeName}/${roomName}: Current: ${currentTemp}°C, Setpoint: ${setpoint}°C, Data points: ${points.length}`
      );

      // Check for drift (setpoint dropped but temperature rising)
      const drift = netatmo.detectDrift(
        points,
        serverTime,
        MIN_MINUTES_SINCE_DROP,
        MIN_TEMP_RISE
      );

      if (drift.isDrifting) {
        console.log(
          `[Check] DRIFT in "${roomName}"! Setpoint dropped ${drift.minutesSinceDrop} min ago, ` +
            `temp rose ${drift.tempRise?.toFixed(2)}°C (${
              drift.tempAtDrop
            }°C → ${drift.currentTemp}°C)`
        );
        driftCount++;

        await eventLogger.logOverageDetected(
          homeId,
          roomId,
          currentTemp,
          setpoint
        );
        await netatmo.setRoomToMax(homeId, roomId, serverTime);
        await eventLogger.logResetTriggered(
          homeId,
          roomId,
          currentTemp,
          setpoint
        );

        results.push({
          home: homeName,
          room: roomName,
          currentTemp,
          setpoint,
          action: "drift_reset_triggered",
          drift: {
            tempAtDrop: drift.tempAtDrop!,
            tempRise: drift.tempRise!,
            minutesSinceDrop: drift.minutesSinceDrop!,
          },
        });
      } else {
        results.push({
          home: homeName,
          room: roomName,
          currentTemp,
          setpoint,
          action: "none",
        });
      }
    }

    console.log(
      `[Check] Completed. Checked ${thermostats.length} rooms, found ${driftCount} drifts`
    );

    return c.json({
      status: driftCount > 0 ? "drifts_detected" : "ok",
      checked: thermostats.length,
      drifts: driftCount,
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

export default app;
