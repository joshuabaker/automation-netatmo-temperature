import { Redis } from "@upstash/redis";
import type { OverageEvent, OverageEventType } from "../types.js";

const OVERAGE_EVENTS_KEY = "netatmo:overages";
const MAX_EVENTS_TO_KEEP = 1000; // Keep last 1000 events

export class EventLogger {
  private redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  /**
   * Log an overage event to Redis sorted set
   * Uses timestamp as score for chronological ordering
   */
  async logEvent(event: Omit<OverageEvent, "timestamp">): Promise<void> {
    const timestamp = Date.now();
    const fullEvent: OverageEvent = {
      ...event,
      timestamp,
    };

    console.log(`[EventLogger] Logging event: ${event.type}`, fullEvent);

    // Add to sorted set with timestamp as score
    await this.redis.zadd(OVERAGE_EVENTS_KEY, {
      score: timestamp,
      member: JSON.stringify(fullEvent),
    });

    // Trim to keep only the most recent events
    const count = await this.redis.zcard(OVERAGE_EVENTS_KEY);
    if (count > MAX_EVENTS_TO_KEEP) {
      // Remove oldest events
      await this.redis.zremrangebyrank(
        OVERAGE_EVENTS_KEY,
        0,
        count - MAX_EVENTS_TO_KEEP - 1
      );
    }
  }

  /**
   * Log when an overage is detected
   */
  async logOverageDetected(
    homeId: string,
    roomId: string,
    currentTemp: number,
    setpoint: number
  ): Promise<void> {
    await this.logEvent({
      type: "overage_detected",
      homeId,
      roomId,
      currentTemp,
      setpoint,
      diff: currentTemp - setpoint,
    });
  }

  /**
   * Log when a reset is triggered (max mode set)
   */
  async logResetTriggered(
    homeId: string,
    roomId: string,
    currentTemp: number,
    setpoint: number
  ): Promise<void> {
    await this.logEvent({
      type: "reset_triggered",
      homeId,
      roomId,
      currentTemp,
      setpoint,
      diff: currentTemp - setpoint,
    });
  }

  /**
   * Log when a reset is completed (back to home mode)
   */
  async logResetCompleted(
    homeId: string,
    roomId: string,
    currentTemp: number,
    setpoint: number
  ): Promise<void> {
    await this.logEvent({
      type: "reset_completed",
      homeId,
      roomId,
      currentTemp,
      setpoint,
      diff: currentTemp - setpoint,
    });
  }

  /**
   * Get recent events within a time range
   *
   * @param startTime - Start timestamp (defaults to 24 hours ago)
   * @param endTime - End timestamp (defaults to now)
   */
  async getRecentEvents(
    startTime?: number,
    endTime?: number
  ): Promise<OverageEvent[]> {
    const start = startTime ?? Date.now() - 24 * 60 * 60 * 1000; // 24 hours ago
    const end = endTime ?? Date.now();

    const results = await this.redis.zrange<string[]>(
      OVERAGE_EVENTS_KEY,
      start,
      end,
      { byScore: true }
    );

    return results.map((item: string) => JSON.parse(item) as OverageEvent);
  }

  /**
   * Get event count by type within a time range
   */
  async getEventCounts(
    startTime?: number,
    endTime?: number
  ): Promise<Record<OverageEventType, number>> {
    const events = await this.getRecentEvents(startTime, endTime);

    const counts: Record<OverageEventType, number> = {
      overage_detected: 0,
      reset_triggered: 0,
      reset_completed: 0,
    };

    for (const event of events) {
      counts[event.type]++;
    }

    return counts;
  }

  /**
   * Get all events (paginated)
   */
  async getAllEvents(
    offset: number = 0,
    limit: number = 100
  ): Promise<OverageEvent[]> {
    const results = await this.redis.zrange<string[]>(
      OVERAGE_EVENTS_KEY,
      offset,
      offset + limit - 1,
      { rev: true } // Most recent first
    );

    return results.map((item: string) => JSON.parse(item) as OverageEvent);
  }
}

/**
 * Create a Redis client from environment variables
 */
export function createRedis(): Redis {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error(
      "Missing required Redis environment variables: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN"
    );
  }

  return new Redis({
    url,
    token,
  });
}

/**
 * Create an event logger from environment variables
 */
export function createEventLogger(): EventLogger {
  return new EventLogger(createRedis());
}
