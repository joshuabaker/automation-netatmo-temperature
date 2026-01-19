import { Redis } from "@upstash/redis";

export const REDIS_KEYS = {
  ACCESS_TOKEN: "netatmo:access_token",
  REFRESH_TOKEN: "netatmo:refresh_token",
  READING: "netatmo:reading",
} as const;

// Access token TTL - cache for ~2.7 hours (tokens expire in 3 hours)
export const ACCESS_TOKEN_TTL = 10000;

export function createRedis(): Redis {
  return Redis.fromEnv();
}
