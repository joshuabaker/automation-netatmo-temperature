# Netatmo Temperature Monitor

## Purpose

Works around a Netatmo thermostat firmware bug where the relay fails to stop heating after the setpoint is reached. Netatmo denies the issue. The workaround: toggle MAX mode on (changing relay state) then off on the next check cycle, effectively replaying the "off" signal to the relay.

## Tech Stack

- **Runtime**: Hono on Vercel serverless (Node.js 20+)
- **State**: Upstash Redis (token cache, last reading)
- **Notifications**: Pushover (optional)
- **Language**: TypeScript (ES modules)
- **Package manager**: pnpm

## Architecture

1. External cron (cron-job.org) calls `GET /check` every 5 minutes with Bearer auth
2. App fetches thermostat status from Netatmo API (first home, first room)
3. If MAX mode is active → reset to home/schedule mode → done
4. Otherwise, evaluate trigger conditions:
   - System is enabled (`ENABLED` env var is not `"false"`)
   - Setpoint > 18°C (heating is actively wanted, not eco/frost mode)
   - Current temp > 22°C (`MIN_TEMP_FOR_MAX`)
   - Temp exceeds setpoint by > 0.5°C for two consecutive checks
   - Temperature is still rising
5. If all conditions met → trigger MAX mode (30s expiry) + Pushover notification
6. Store reading in Redis for next check

## Key Constants (`src/index.ts`)

| Constant | Value | Purpose |
|----------|-------|---------|
| `THRESHOLD` | 0.5°C | Min overshoot above setpoint to consider triggering |
| `MIN_TEMP_FOR_MAX` | 22.0°C | Min ambient temp to trigger MAX mode |
| `MIN_SETPOINT_FOR_MAX` | 18.0°C | Min setpoint to trigger MAX — prevents false triggers in eco/summer mode |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `API_SECRET` | Yes | Bearer token for authenticating cron requests |
| `NETATMO_CLIENT_ID` | Yes | Netatmo OAuth client ID |
| `NETATMO_CLIENT_SECRET` | Yes | Netatmo OAuth client secret |
| `NETATMO_REFRESH_TOKEN` | Yes | Initial Netatmo refresh token (rotated tokens stored in Redis) |
| `UPSTASH_REDIS_REST_URL` | Yes | Upstash Redis endpoint |
| `UPSTASH_REDIS_REST_TOKEN` | Yes | Upstash Redis API token |
| `PUSHOVER_USER` | No | Pushover user/group key for notifications |
| `PUSHOVER_TOKEN` | No | Pushover application token |
| `ENABLED` | No | Set to `"false"` to disable MAX mode triggering. Defaults to enabled. |

## Development

```bash
pnpm install
pnpm dev        # Local dev server on port 3000

# Test the check endpoint
curl -H "Authorization: Bearer $API_SECRET" http://localhost:3000/check
```

## Endpoints

- `GET /health` — Health check (no auth)
- `GET /check` — Main thermostat check (requires Bearer auth)

## Redis Keys

- `netatmo:access_token` — Cached access token (TTL: ~2.7 hours)
- `netatmo:refresh_token` — Current refresh token (persisted, auto-rotated)
- `netatmo:reading` — Last thermostat reading (`{ temp, setpoint }`)
