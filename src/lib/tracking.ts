import type { Redis } from "@upstash/redis";
import { REDIS_KEYS } from "./redis.js";
import type { CheckErrorRecord, CheckSuccessRecord } from "../types.js";

// Keep the last N failures in Redis. 50 x ~500 bytes is negligible on the free tier.
const ERROR_HISTORY_LIMIT = 50;

// Truncate error text stored/sent so a huge upstream response body can't bloat Redis.
const MAX_MESSAGE_LENGTH = 1000;

function truncate(text: string, max = MAX_MESSAGE_LENGTH): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function serializeError(error: unknown): {
  name: string;
  message: string;
  stack?: string;
} {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: truncate(error.message),
      stack: error.stack ? truncate(error.stack, 2000) : undefined,
    };
  }
  return { name: "UnknownError", message: truncate(String(error)) };
}

/**
 * Record a successful /check run so /status can show when things last worked.
 * Never throws — tracking must not turn a good run into a failure.
 */
export async function recordCheckSuccess(
  redis: Redis,
  record: Omit<CheckSuccessRecord, "at">
): Promise<void> {
  try {
    const entry: CheckSuccessRecord = { ...record, at: new Date().toISOString() };
    await redis.set(REDIS_KEYS.LAST_CHECK, entry);
  } catch (trackingError) {
    console.error(
      JSON.stringify({
        event: "tracking_failed",
        stage: "record_success",
        error: serializeError(trackingError),
      })
    );
  }
}

/**
 * Record a failed /check run:
 *   1. Structured console.error (shows up in Vercel runtime logs)
 *   2. Persist last error + capped history in Redis (survives past Vercel log retention)
 *
 * Never throws and never blocks the error response from being returned; every step
 * is isolated so a Redis outage still leaves the console log, and vice versa.
 */
export async function recordCheckError(
  redis: Redis | null,
  error: unknown,
  status: number
): Promise<void> {
  const entry: CheckErrorRecord = {
    at: new Date().toISOString(),
    status,
    ...serializeError(error),
  };

  // 1. Always log. This is the only channel that needs no configuration.
  console.error(JSON.stringify({ event: "check_failed", ...entry }));

  if (!redis) {
    return;
  }

  // 2. Persist to Redis.
  try {
    await Promise.all([
      redis.set(REDIS_KEYS.LAST_ERROR, entry),
      redis.lpush(REDIS_KEYS.ERROR_HISTORY, JSON.stringify(entry)),
    ]);
    await redis.ltrim(REDIS_KEYS.ERROR_HISTORY, 0, ERROR_HISTORY_LIMIT - 1);
  } catch (trackingError) {
    console.error(
      JSON.stringify({
        event: "tracking_failed",
        stage: "persist_error",
        error: serializeError(trackingError),
      })
    );
  }
}

/**
 * Read back tracking state for the /status endpoint.
 */
export async function getTrackingStatus(
  redis: Redis,
  historyLimit = 10
): Promise<{
  lastCheck: CheckSuccessRecord | null;
  lastError: CheckErrorRecord | null;
  recentErrors: CheckErrorRecord[];
}> {
  const [lastCheck, lastError, history] = await Promise.all([
    redis.get<CheckSuccessRecord>(REDIS_KEYS.LAST_CHECK),
    redis.get<CheckErrorRecord>(REDIS_KEYS.LAST_ERROR),
    redis.lrange<CheckErrorRecord>(REDIS_KEYS.ERROR_HISTORY, 0, historyLimit - 1),
  ]);

  return {
    lastCheck: lastCheck ?? null,
    lastError: lastError ?? null,
    recentErrors: history,
  };
}
