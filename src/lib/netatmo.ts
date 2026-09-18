import { Redis } from "@upstash/redis";
import { REDIS_KEYS, ACCESS_TOKEN_TTL } from "./redis.js";
import { fetchWithRetry, TransientApiError } from "./fetch.js";
import type {
  NetatmoTokenResponse,
  NetatmoHomeStatusResponse,
  NetatmoHomesDataResponse,
  ThermostatStatus,
} from "../types.js";

const NETATMO_API_BASE = "https://api.netatmo.com";

interface NetatmoConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export class NetatmoClient {
  private config: NetatmoConfig;
  private redis: Redis;

  constructor(config: NetatmoConfig, redis: Redis) {
    this.config = config;
    this.redis = redis;
  }

  /**
   * Get the refresh token - prefer Redis (may have been updated), fall back to env var
   */
  private async getRefreshToken(): Promise<string> {
    const cachedToken = await this.redis.get<string>(REDIS_KEYS.REFRESH_TOKEN);
    if (cachedToken) {
      return cachedToken;
    }
    return this.config.refreshToken;
  }

  /**
   * Refresh the access token and cache it, replacing anything already stored.
   */
  private async fetchAndCacheAccessToken(): Promise<string> {
    const tokenResponse = await this.refreshAccessToken();

    await this.redis.set(REDIS_KEYS.ACCESS_TOKEN, tokenResponse.access_token, {
      ex: ACCESS_TOKEN_TTL,
    });

    if (tokenResponse.refresh_token) {
      await this.redis.set(
        REDIS_KEYS.REFRESH_TOKEN,
        tokenResponse.refresh_token
      );
    }

    return tokenResponse.access_token;
  }

  /**
   * Get a valid access token, either from cache or by refreshing
   */
  private async getAccessToken(): Promise<string> {
    const cachedToken = await this.redis.get<string>(REDIS_KEYS.ACCESS_TOKEN);
    if (cachedToken) {
      return cachedToken;
    }

    return this.fetchAndCacheAccessToken();
  }

  /**
   * Refresh the access token using the refresh token
   */
  private async refreshAccessToken(): Promise<NetatmoTokenResponse> {
    const refreshToken = await this.getRefreshToken();

    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });

    // Single attempt only. Netatmo rotates the refresh token on use, so if a
    // request was processed but its response was lost (timeout, 5xx), replaying
    // it would present an already-spent token. Fail as transient and let the
    // next cron run try again with whatever is in Redis.
    const response = await fetchWithRetry(
      `${NETATMO_API_BASE}/oauth2/token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      },
      { retries: 0 }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to refresh Netatmo token: ${response.status} - ${errorText}`
      );
    }

    return (await response.json()) as NetatmoTokenResponse;
  }

  /**
   * Send a single authenticated request. No token handling - the caller owns that.
   */
  private async sendRequest(
    endpoint: string,
    method: "GET" | "POST",
    params: Record<string, string>,
    accessToken: string
  ): Promise<Response> {
    const url = new URL(`${NETATMO_API_BASE}/api${endpoint}`);

    if (method === "GET") {
      Object.entries(params).forEach(([key, value]) => {
        url.searchParams.append(key, value);
      });
    }

    const fetchOptions: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    };

    if (method === "POST") {
      fetchOptions.body = new URLSearchParams(params).toString();
    }

    return fetchWithRetry(url.toString(), fetchOptions);
  }

  /**
   * Make an authenticated API request.
   *
   * Netatmo can invalidate an access token before its cache TTL lapses (seen in
   * production: a token minted at ~23:03 was rejected from 23:10 onwards). Because
   * a 401/403 is below the 5xx threshold, fetchWithRetry passes it straight
   * through, so without this the stale token was re-read from Redis and replayed
   * on every run until the ~2h47m TTL expired - turning a one-request problem into
   * a multi-hour outage. Discard the cached token and retry exactly once.
   */
  private async apiRequest<T>(
    endpoint: string,
    options: {
      method?: "GET" | "POST";
      params?: Record<string, string>;
    } = {}
  ): Promise<T> {
    const { method = "GET", params = {} } = options;

    let response = await this.sendRequest(
      endpoint,
      method,
      params,
      await this.getAccessToken()
    );

    if (response.status === 401 || response.status === 403) {
      await this.redis.del(REDIS_KEYS.ACCESS_TOKEN);
      response = await this.sendRequest(
        endpoint,
        method,
        params,
        await this.fetchAndCacheAccessToken()
      );
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Netatmo API error: ${response.status} - ${errorText}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Get the first home ID from the account
   */
  private async getFirstHomeId(): Promise<string> {
    const homesData = await this.apiRequest<NetatmoHomesDataResponse>(
      "/homesdata",
      { method: "GET" }
    );

    const home = homesData.body.homes[0];
    if (!home) {
      throw new Error("No homes found in Netatmo account");
    }

    return home.id;
  }

  /**
   * Get thermostat status (first home, first room)
   */
  async getThermostatStatus(): Promise<ThermostatStatus> {
    const homeId = await this.getFirstHomeId();

    const homeStatus = await this.apiRequest<NetatmoHomeStatusResponse>(
      "/homestatus",
      { method: "GET", params: { home_id: homeId } }
    );

    // When the relay is offline Netatmo still answers 200 "ok", but drops
    // rooms/modules from the home and lists the device under body.errors
    // (code 6 = unreachable). Nothing to act on until it reconnects, so treat it
    // like any other upstream outage rather than crashing on rooms[0].
    const room = homeStatus.body.home?.rooms?.[0];
    if (!room) {
      const codes = (homeStatus.body.errors ?? []).map((e) => e.code);
      throw new TransientApiError(
        codes.length > 0
          ? `Netatmo relay unreachable: homestatus returned no rooms (error codes: ${codes.join(", ")})`
          : "Netatmo homestatus returned no rooms"
      );
    }

    return {
      homeId,
      roomId: room.id,
      temp: room.therm_measured_temperature,
      setpoint: room.therm_setpoint_temperature,
      mode: room.therm_setpoint_mode,
      serverTime: parseInt(homeStatus.time_server, 10),
    };
  }

  /**
   * Set the temperature/mode for a room
   */
  private async setRoomThermPoint(
    homeId: string,
    roomId: string,
    mode: "manual" | "max" | "home",
    endtime?: number
  ): Promise<void> {
    const params: Record<string, string> = {
      home_id: homeId,
      room_id: roomId,
      mode,
    };

    if (endtime !== undefined) {
      params.endtime = endtime.toString();
    }

    await this.apiRequest<{ status: string }>("/setroomthermpoint", {
      method: "POST",
      params,
    });
  }

  /**
   * Set room to max temperature - triggers heating
   * Auto-expires after 60 seconds
   */
  async setRoomToMax(
    homeId: string,
    roomId: string,
    serverTime: number
  ): Promise<void> {
    const endtime = serverTime + 30;
    await this.setRoomThermPoint(homeId, roomId, "max", endtime);
  }

  /**
   * Set room back to home/schedule mode
   */
  async setRoomToHome(homeId: string, roomId: string): Promise<void> {
    await this.setRoomThermPoint(homeId, roomId, "home");
  }
}

/**
 * Create a Netatmo client from environment variables
 */
export function createNetatmoClient(redis: Redis): NetatmoClient {
  const clientId = process.env.NETATMO_CLIENT_ID;
  const clientSecret = process.env.NETATMO_CLIENT_SECRET;
  const refreshToken = process.env.NETATMO_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Missing required Netatmo environment variables: NETATMO_CLIENT_ID, NETATMO_CLIENT_SECRET, NETATMO_REFRESH_TOKEN"
    );
  }

  return new NetatmoClient({ clientId, clientSecret, refreshToken }, redis);
}
