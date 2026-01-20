import { Hono } from "hono";
import { createNetatmoClient } from "./lib/netatmo.js";
import { sendPushoverNotification } from "./lib/pushover.js";
import { createRedis, REDIS_KEYS } from "./lib/redis.js";
import type { ThermostatReading } from "./types.js";

const THRESHOLD = 1.0;

const app = new Hono();

app.get("/health", (c) => {
  return c.json({ status: "healthy", timestamp: new Date().toISOString() });
});

app.get("/check", async (c) => {
  const authHeader = c.req.header("Authorization");
  const apiSecret = process.env.API_SECRET;

  if (!apiSecret) {
    return c.json({ error: "Server misconfigured" }, 500);
  }

  if (authHeader !== `Bearer ${apiSecret}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const redis = createRedis();
    const netatmo = createNetatmoClient(redis);

    // Get thermostat status (first home, first room)
    const { homeId, roomId, temp, setpoint, mode, serverTime } =
      await netatmo.getThermostatStatus();

    // Read previous reading from Redis
    const prevReading = await redis.get<ThermostatReading>(REDIS_KEYS.READING);

    // If MAX mode is on, toggle off, store reading, and exit
    if (mode === "max") {
      await netatmo.setRoomToHome(homeId, roomId);
      return c.json({
        action: "reset_max",
        temp,
        setpoint,
      });
    }

    // Check for consecutive overages
    const currDiff = temp - setpoint;
    const prevDiff = prevReading ? prevReading.temp - prevReading.setpoint : 0;

    let action = "normal";

    if (currDiff > THRESHOLD && prevDiff > THRESHOLD) {
      // await netatmo.setRoomToMax(homeId, roomId, serverTime);
      await sendPushoverNotification(
        "Heating MAX Triggered",
        `Temperature ${temp}°C exceeded setpoint ${setpoint}°C by ${currDiff.toFixed(
          1
        )}°C`
      );
      action = "triggered_max";
    }

    // Always store the current reading for next check
    await redis.set(REDIS_KEYS.READING, { temp, setpoint });

    return c.json({
      action,
      temp,
      setpoint,
      diff: currDiff,
      prevDiff: prevReading ? prevDiff : null,
    });
  } catch (error) {
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
