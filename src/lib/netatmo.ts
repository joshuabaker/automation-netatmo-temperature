import { Redis } from "@upstash/redis";
import { REDIS_KEYS, ACCESS_TOKEN_TTL } from "./redis.js";
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
   * Get a valid access token, either from cache or by refreshing
   */
  private async getAccessToken(): Promise<string> {
    const cachedToken = await this.redis.get<string>(REDIS_KEYS.ACCESS_TOKEN);
    if (cachedToken) {
      return cachedToken;
    }

    const tokenResponse = await this.refreshAccessToken();

    await this.redis.set(REDIS_KEYS.ACCESS_TOKEN, tokenResponse.access_token, {
      ex: ACCESS_TOKEN_TTL,
    });

    if (tokenResponse.refresh_token) {
      await this.redis.set(REDIS_KEYS.REFRESH_TOKEN, tokenResponse.refresh_token);
    }

    return tokenResponse.access_token;
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

    const response = await fetch(`${NETATMO_API_BASE}/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to refresh Netatmo token: ${response.status} - ${errorText}`
      );
    }

    return (await response.json()) as NetatmoTokenResponse;
  }

  /**
   * Make an authenticated API request
   */
  private async apiRequest<T>(
    endpoint: string,
    options: {
      method?: "GET" | "POST";
      params?: Record<string, string>;
    } = {}
  ): Promise<T> {
    const { method = "GET", params = {} } = options;
    const accessToken = await this.getAccessToken();

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

    const response = await fetch(url.toString(), fetchOptions);

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

    const room = homeStatus.body.home.rooms[0];
    if (!room) {
      throw new Error("No rooms found in home");
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
