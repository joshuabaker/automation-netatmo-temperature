import { Redis } from "@upstash/redis";

export const REDIS_KEYS = {
  ACCESS_TOKEN: "netatmo:access_token",
  REFRESH_TOKEN: "netatmo:refresh_token",
  READING: "netatmo:reading",
  LAST_CHECK: "netatmo:last_check",
  LAST_ERROR: "netatmo:last_error",
  ERROR_HISTORY: "netatmo:errors",
  ERROR_ALERTED: "netatmo:error_alerted",
} as const;

// Access token TTL - cache for ~2.7 hours (tokens expire in 3 hours)
export const ACCESS_TOKEN_TTL = 10000;

export function createRedis(): Redis {
  return Redis.fromEnv();
}
