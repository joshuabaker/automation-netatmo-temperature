import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { Redis } from "@upstash/redis";
import { createNetatmoClient } from "./lib/netatmo.js";
import { TransientApiError } from "./lib/fetch.js";
import { sendPushoverNotification } from "./lib/pushover.js";
import { createRedis, REDIS_KEYS } from "./lib/redis.js";
import {
  getTrackingStatus,
  recordCheckError,
  recordCheckSuccess,
  recordTransientFailure,
} from "./lib/tracking.js";
import type { ThermostatReading } from "./types.js";

const THRESHOLD = 0.5; // Threshold for temperature difference to trigger MAX mode
const MIN_TEMP_FOR_MAX = 22.0; // Minimum temperature to activate MAX mode
const MIN_SETPOINT_FOR_MAX = 18.0; // Minimum setpoint to activate MAX mode (skip in eco/summer)
const TRANSIENT_ALERT_THRESHOLD = 3; // Consecutive Netatmo outages before /check returns 502 (and the cron caller alerts)

const app = new Hono();

/**
 * Bearer auth for endpoints the cron caller and the operator hit.
 */
const requireAuth = createMiddleware(async (c, next) => {
  const authHeader = c.req.header("Authorization");
  const apiSecret = process.env.API_SECRET;

  if (!apiSecret) {
    console.error(
      JSON.stringify({ event: "misconfigured", missing: "API_SECRET" })
    );
    return c.json({ error: "Server misconfigured" }, 500);
  }

  if (authHeader !== `Bearer ${apiSecret}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  await next();
});

app.get("/health", (c) => {
  return c.json({ status: "healthy", timestamp: new Date().toISOString() });
});

app.get("/status", requireAuth, async (c) => {
  try {
    const redis = createRedis();
    const status = await getTrackingStatus(redis);
    return c.json({
      enabled: process.env.ENABLED !== "false",
      ...status,
    });
  } catch (error) {
    return c.json(
      {
        error: "Failed to read status",
        details: error instanceof Error ? error.message : String(error),
      },
      500
    );
  }
});

app.get("/check", requireAuth, async (c) => {
  if (process.env.ENABLED === "false") {
    return c.json({ action: "disabled" });
  }

  // Created outside the try so the catch can still persist the error if the
  // failure happened after Redis was set up.
  let redis: Redis | null = null;

  try {
    redis = createRedis();
    const netatmo = createNetatmoClient(redis);

    // Get thermostat status (first home, first room)
    const { homeId, roomId, temp, setpoint, mode, serverTime } =
      await netatmo.getThermostatStatus();

    // Read previous reading from Redis
    const prevReading = await redis.get<ThermostatReading>(REDIS_KEYS.READING);

    // If MAX mode is on, toggle off, store reading, and exit
    if (mode === "max") {
      await netatmo.setRoomToHome(homeId, roomId);
      await recordCheckSuccess(redis, { action: "reset_max", temp, setpoint });
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

    if (
      setpoint > MIN_SETPOINT_FOR_MAX && // Setpoint indicates heating is actively wanted (not eco/summer)
      temp > MIN_TEMP_FOR_MAX && // Current temperature is greater than minimum temperature to trigger MAX mode
      prevDiff > THRESHOLD && // Previous temperature is greater than previous setpoint
      currDiff > THRESHOLD && // Current temperature is greater than current setpoint
      prevReading && // A previous reading exists
      temp > prevReading.temp // Current temperature is greater than previous temperature (indicates heating is on)
    ) {
      await netatmo.setRoomToMax(homeId, roomId, serverTime);
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
    await recordCheckSuccess(redis, { action, temp, setpoint });

    return c.json({
      action,
      temp,
      setpoint,
      diff: currDiff,
      prevDiff: prevReading ? prevDiff : null,
    });
  } catch (error) {
    const isTransient = error instanceof TransientApiError;
    const status = isTransient ? 502 : 500;

    // Netatmo 503s are frequent and self-resolving, and the next run retries
    // anyway. Answer 200 for isolated ones so the cron caller doesn't email (or
    // auto-disable the job); only a sustained outage surfaces as 502. Every
    // failure is still recorded, suppressed or not.
    const streak = isTransient ? await recordTransientFailure(redis) : null;
    const suppressed = streak !== null && streak < TRANSIENT_ALERT_THRESHOLD;

    await recordCheckError(redis, error, status, suppressed);

    const details = error instanceof Error ? error.message : String(error);

    if (suppressed) {
      return c.json({ action: "transient_failure", streak, details });
    }

    return c.json(
      {
        error: isTransient
          ? "Netatmo API temporarily unavailable"
          : "Failed to check temperature",
        details,
      },
      status
    );
  }
});

export default app;
