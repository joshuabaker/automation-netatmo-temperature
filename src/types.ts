// Netatmo API types

export interface NetatmoTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string[];
}

export interface NetatmoRoom {
  id: string;
  reachable: boolean;
  therm_measured_temperature: number;
  therm_setpoint_temperature: number;
  therm_setpoint_mode: "schedule" | "manual" | "max" | "off";
  therm_setpoint_start_time?: number;
  therm_setpoint_end_time?: number;
  heating_power_request?: number;
  anticipating?: boolean;
  open_window?: boolean;
}

export interface NetatmoModule {
  id: string;
  type: "NAPlug" | "NATherm1" | "NRV" | "OTH" | "BNS";
  firmware_revision?: number;
  rf_strength?: number;
  wifi_strength?: number;
  reachable?: boolean;
  boiler_status?: boolean;
  bridge?: string;
  battery_state?: string;
}

export interface NetatmoHomeStatus {
  home: {
    id: string;
    modules: NetatmoModule[];
    rooms: NetatmoRoom[];
  };
  errors?: Array<{ id: string; code: number }>;
}

export interface NetatmoHomeStatusResponse {
  status: string;
  time_exec: string;
  time_server: string;
  body: NetatmoHomeStatus;
}

// Homes data types (for discovery)

export interface NetatmoHomeRoom {
  id: string;
  name: string;
  type: string;
  module_ids?: string[];
}

export interface NetatmoHomeModule {
  id: string;
  type: "NAPlug" | "NATherm1" | "NRV" | "OTH" | "BNS";
  name: string;
  setup_date?: number;
  room_id?: string;
  bridge?: string;
}

export interface NetatmoHome {
  id: string;
  name: string;
  altitude?: number;
  coordinates?: [number, number];
  country?: string;
  timezone?: string;
  rooms?: NetatmoHomeRoom[];
  modules?: NetatmoHomeModule[];
}

export interface NetatmoHomesDataResponse {
  status: string;
  time_exec: string;
  time_server: string;
  body: {
    homes: NetatmoHome[];
    user: {
      email: string;
      language: string;
      locale: string;
      feel_like_algorithm: number;
      unit_pressure: number;
      unit_system: number;
      unit_wind: number;
      id: string;
    };
  };
}

// Redis logging types

export type OverageEventType = "overage_detected" | "reset_triggered" | "reset_completed";

export interface OverageEvent {
  type: OverageEventType;
  currentTemp: number;
  setpoint: number;
  diff: number;
  timestamp: number;
  homeId: string;
  roomId: string;
  homeName?: string;
  roomName?: string;
}

// QStash callback payload

export interface ResetPayload {
  homeId: string;
  roomId: string;
  originalSetpoint: number;
  homeName?: string;
  roomName?: string;
}

// Thermostat info for discovery

export interface ThermostatInfo {
  homeId: string;
  homeName: string;
  roomId: string;
  roomName: string;
  currentTemp: number;
  setpoint: number;
  mode: string;
  reachable: boolean;
}
