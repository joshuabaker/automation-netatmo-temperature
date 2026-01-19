import { Redis } from "@upstash/redis";
import type {
  NetatmoTokenResponse,
  NetatmoHomeStatusResponse,
  NetatmoHomesDataResponse,
  NetatmoRoom,
  ThermostatInfo,
  RoomMeasureResponse,
  MeasurePoint,
  DriftDetection,
} from "../types.js";

const NETATMO_API_BASE = "https://api.netatmo.com";
const ACCESS_TOKEN_KEY = "netatmo:access_token";
const REFRESH_TOKEN_KEY = "netatmo:refresh_token";
const ACCESS_TOKEN_TTL = 10000; // Cache for ~2.7 hours (tokens expire in 3 hours)

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
    // Check Redis first for an updated token
    const cachedToken = await this.redis.get<string>(REFRESH_TOKEN_KEY);
    if (cachedToken) {
      return cachedToken;
    }
    // Fall back to env var
    return this.config.refreshToken;
  }

  /**
   * Get a valid access token, either from cache or by refreshing
   */
  private async getAccessToken(): Promise<string> {
    // Try to get cached token
    const cachedToken = await this.redis.get<string>(ACCESS_TOKEN_KEY);
    if (cachedToken) {
      console.log("[Netatmo] Using cached access token");
      return cachedToken;
    }

    // Refresh the token
    console.log("[Netatmo] Refreshing access token");
    const tokenResponse = await this.refreshAccessToken();

    // Cache the new access token with TTL
    await this.redis.set(ACCESS_TOKEN_KEY, tokenResponse.access_token, {
      ex: ACCESS_TOKEN_TTL,
    });

    // Store updated refresh token in Redis (Netatmo may rotate it)
    if (tokenResponse.refresh_token) {
      await this.redis.set(REFRESH_TOKEN_KEY, tokenResponse.refresh_token);
      console.log("[Netatmo] Refresh token updated in Redis");
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

    const data = (await response.json()) as NetatmoTokenResponse;
    console.log("[Netatmo] Token refreshed successfully");
    return data;
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

    // For GET requests, add params to URL
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

    // For POST requests, add params to body
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
   * Get all homes and their topology (rooms, modules)
   */
  async getHomesData(): Promise<NetatmoHomesDataResponse> {
    console.log("[Netatmo] Getting homes data");
    return this.apiRequest<NetatmoHomesDataResponse>("/homesdata", {
      method: "GET",
    });
  }

  /**
   * Get the current status of a home (temperature, setpoints, etc.)
   */
  async getHomeStatus(homeId: string): Promise<NetatmoHomeStatusResponse> {
    console.log(`[Netatmo] Getting home status for ${homeId}`);
    return this.apiRequest<NetatmoHomeStatusResponse>("/homestatus", {
      method: "GET",
      params: { home_id: homeId },
    });
  }

  /**
   * Get room status from home status response
   */
  getRoomFromStatus(
    homeStatus: NetatmoHomeStatusResponse,
    roomId: string
  ): NetatmoRoom | undefined {
    return homeStatus.body.home.rooms.find((room) => room.id === roomId);
  }

  /**
   * Discover all thermostats across all homes
   */
  async getAllThermostats(): Promise<ThermostatInfo[]> {
    console.log("[Netatmo] Discovering all thermostats");

    const homesData = await this.getHomesData();
    const thermostats: ThermostatInfo[] = [];

    for (const home of homesData.body.homes) {
      // Check if home has thermostat modules
      const hasThermostat = home.modules?.some(
        (m) => m.type === "NAPlug" || m.type === "NATherm1" || m.type === "NRV"
      );

      if (!hasThermostat) {
        console.log(`[Netatmo] Home "${home.name}" has no thermostat modules`);
        continue;
      }

      try {
        const homeStatus = await this.getHomeStatus(home.id);
        const serverTime = parseInt(homeStatus.time_server, 10);

        for (const room of homeStatus.body.home.rooms) {
          const roomInfo = home.rooms?.find((r) => r.id === room.id);
          const roomName = roomInfo?.name || `Room ${room.id}`;

          thermostats.push({
            homeId: home.id,
            homeName: home.name,
            roomId: room.id,
            roomName,
            currentTemp: room.therm_measured_temperature,
            setpoint: room.therm_setpoint_temperature,
            mode: room.therm_setpoint_mode,
            reachable: room.reachable,
            serverTime,
          });
        }
      } catch (error) {
        console.error(
          `[Netatmo] Failed to get status for home "${home.name}":`,
          error
        );
      }
    }

    console.log(`[Netatmo] Found ${thermostats.length} thermostat-controlled rooms`);
    return thermostats;
  }

  /**
   * Set the temperature/mode for a room
   */
  async setRoomThermPoint(
    homeId: string,
    roomId: string,
    mode: "manual" | "max" | "home",
    temp?: number,
    endtime?: number
  ): Promise<{ status: string }> {
    console.log(
      `[Netatmo] Setting room ${roomId} to mode: ${mode}${temp ? `, temp: ${temp}` : ""}`
    );

    const params: Record<string, string> = {
      home_id: homeId,
      room_id: roomId,
      mode,
    };

    if (mode === "manual" && temp !== undefined) {
      params.temp = temp.toString();
    }

    if (endtime !== undefined) {
      params.endtime = endtime.toString();
    }

    return this.apiRequest<{ status: string }>("/setroomthermpoint", {
      method: "POST",
      params,
    });
  }

  /**
   * Set room to max temperature (30°C) - triggers heating
   * Auto-expires after 60 seconds as a failsafe
   * @param serverTime - Optional Netatmo server time for clock sync
   */
  async setRoomToMax(homeId: string, roomId: string, serverTime?: number): Promise<void> {
    const baseTime = serverTime ?? Math.floor(Date.now() / 1000);
    const endtime = baseTime + 60; // 1 minute from base time
    await this.setRoomThermPoint(homeId, roomId, "max", undefined, endtime);
    console.log(`[Netatmo] Room ${roomId} set to MAX mode (expires in 60s)`);
  }

  /**
   * Set room back to home/schedule mode
   */
  async setRoomToHome(homeId: string, roomId: string): Promise<void> {
    await this.setRoomThermPoint(homeId, roomId, "home");
    console.log(`[Netatmo] Room ${roomId} set to HOME mode`);
  }

  /**
   * Get historical temperature and setpoint data for a room
   * @param scale - Data granularity: "30min", "1hour", "3hours", "1day"
   * @param dateBegin - Start timestamp (Unix seconds)
   * @param dateEnd - End timestamp (Unix seconds), or "last" for most recent
   */
  async getRoomMeasure(
    homeId: string,
    roomId: string,
    scale: string = "30min",
    dateBegin?: number,
    dateEnd?: number
  ): Promise<RoomMeasureResponse> {
    console.log(`[Netatmo] Getting room measure for ${roomId} (scale: ${scale})`);

    const params: Record<string, string> = {
      home_id: homeId,
      room_id: roomId,
      scale,
      type: "temperature,sp_temperature",
    };

    if (dateBegin !== undefined) {
      params.date_begin = dateBegin.toString();
    }
    if (dateEnd !== undefined) {
      params.date_end = dateEnd.toString();
    }

    return this.apiRequest<RoomMeasureResponse>("/getroommeasure", {
      method: "GET",
      params,
    });
  }

  /**
   * Parse room measure response into individual data points
   */
  parseMeasureData(response: RoomMeasureResponse): MeasurePoint[] {
    const points: MeasurePoint[] = [];

    for (const series of response.body) {
      const { beg_time, step_time, value } = series;

      for (let i = 0; i < value.length; i++) {
        const [temperature, setpoint] = value[i];
        points.push({
          timestamp: beg_time + i * step_time,
          temperature,
          setpoint,
        });
      }
    }

    return points.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Detect if temperature is drifting up while setpoint has dropped
   * This indicates the thermostat failed to turn off heating
   *
   * @param points - Historical measure points
   * @param serverTime - Current server time for reference
   * @param minMinutesSinceDrop - Minimum minutes since setpoint drop to consider (default: 10)
   * @param minTempRise - Minimum temperature rise to trigger (default: 0.5°C)
   */
  detectDrift(
    points: MeasurePoint[],
    serverTime: number,
    minMinutesSinceDrop: number = 10,
    minTempRise: number = 0.5
  ): DriftDetection {
    if (points.length < 2) {
      return { isDrifting: false };
    }

    const minSecondsSinceDrop = minMinutesSinceDrop * 60;
    const currentPoint = points[points.length - 1];

    // Find the most recent setpoint drop
    for (let i = points.length - 1; i > 0; i--) {
      const prev = points[i - 1];
      const curr = points[i];

      // Check if setpoint dropped
      if (curr.setpoint < prev.setpoint) {
        const secondsSinceDrop = serverTime - curr.timestamp;
        const minutesSinceDrop = secondsSinceDrop / 60;

        // Only consider if enough time has passed
        if (secondsSinceDrop >= minSecondsSinceDrop) {
          const tempAtDrop = curr.temperature;
          const tempRise = currentPoint.temperature - tempAtDrop;

          // Temperature has risen since setpoint dropped - drift detected
          if (tempRise >= minTempRise) {
            return {
              isDrifting: true,
              setpointDropTime: curr.timestamp,
              tempAtDrop,
              currentTemp: currentPoint.temperature,
              tempRise,
              minutesSinceDrop: Math.round(minutesSinceDrop),
            };
          }
        }

        // Found the most recent drop, stop searching
        break;
      }
    }

    return { isDrifting: false };
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
