# Netatmo Temperature Monitor

A serverless Vercel application that monitors a Netatmo thermostat and works around a firmware bug where the relay fails to stop heating, causing temperatures to overshoot the setpoint.

## How It Works

1. An external cron service (e.g., [cron-job.org](https://cron-job.org)) calls `/check` every 5 minutes
2. The app gets the current temperature and setpoint from the first thermostat
3. If MAX mode is active, it resets to home/schedule mode and exits
4. If the setpoint is above 18°C (i.e. heating is actively wanted, not eco/frost mode) and the temperature exceeds the setpoint by more than 0.5°C for two consecutive checks, it triggers MAX mode for 30 seconds to reset the relay

## Prerequisites

- Node.js 20+
- A Netatmo developer account and app
- Upstash Redis database
- Vercel account
- External cron service (e.g., [cron-job.org](https://cron-job.org))
- (Optional) Pushover account for notifications

## Setup

### 1. Create a Netatmo App

1. Go to [dev.netatmo.com](https://dev.netatmo.com)
2. Create a new app with scopes: `read_thermostat write_thermostat`
3. Note your Client ID and Client Secret
4. Use the API console to complete an OAuth flow and obtain a refresh token

### 2. Set Up Upstash

1. Create a Redis database at [console.upstash.com](https://console.upstash.com)
2. Note the REST URL and token

### 3. Deploy to Vercel

```bash
pnpm install
vercel
```

### 4. Configure Environment Variables

Set these in your Vercel project settings:

| Variable                   | Description                                                                    |
| -------------------------- | ------------------------------------------------------------------------------ |
| `API_SECRET`               | Secret for authenticating cron requests (generate with `openssl rand -hex 32`) |
| `NETATMO_CLIENT_ID`        | From Netatmo dev portal                                                        |
| `NETATMO_CLIENT_SECRET`    | From Netatmo dev portal                                                        |
| `NETATMO_REFRESH_TOKEN`    | From Netatmo OAuth flow                                                        |
| `UPSTASH_REDIS_REST_URL`   | From Upstash console                                                           |
| `UPSTASH_REDIS_REST_TOKEN` | From Upstash console                                                           |
| `PUSHOVER_USER`            | (Optional) Your Pushover user/group key                                        |
| `PUSHOVER_TOKEN`           | (Optional) Your Pushover application token                                     |
| `ENABLED`                  | (Optional) Set to `"false"` to disable MAX mode triggering entirely            |

### 5. Set Up External Cron

1. Create a free account at [cron-job.org](https://cron-job.org)
2. Create a new cron job:
   - **URL:** `https://your-app.vercel.app/check`
   - **Schedule:** Every 5 minutes (`*/5 * * * *`)
   - **Request method:** GET
   - **Headers:** `Authorization: Bearer YOUR_API_SECRET`

## API Endpoints

### `GET /check`

Checks the thermostat for temperature overages. Requires `Authorization: Bearer <API_SECRET>` header.

Returns:

- `action`: One of `normal`, `triggered_max`, or `reset_max`
- `temp`: Current temperature
- `setpoint`: Current setpoint
- `diff`: Current temperature difference (temp - setpoint)
- `prevDiff`: Previous temperature difference (null on first run)

### `GET /health`

Health check endpoint (no authentication required).

### `GET /status`

Returns tracking state for debugging failed cron runs. Requires `Authorization: Bearer <API_SECRET>` header.

- `enabled`: Whether MAX mode triggering is enabled
- `lastCheck`: Last successful `/check` run (`{ at, action, temp, setpoint }`)
- `lastError`: Last failed `/check` run (`{ at, status, name, message, stack }`)
- `recentErrors`: The last 10 failed runs, newest first (Redis keeps 50)

```bash
curl -H "Authorization: Bearer $API_SECRET" https://your-app.vercel.app/status
```

## Error Tracking

Every failed `/check` run is recorded in two places, using only services already required by the app:

1. **Vercel runtime logs** — a structured JSON line (`"event":"check_failed"`) via `console.error`. Note that Vercel's Hobby plan only retains runtime logs for about an hour.
2. **Redis** — the last error and a capped history of the last 50, so failures are still inspectable long after Vercel's logs have rolled over. Read them via `GET /status`.

Tracking is best-effort: if Redis is itself unreachable, the original error is still returned to the caller and logged.

### Quiet handling of Netatmo outages

Netatmo's API returns sporadic 503s. An isolated one is harmless — the next run simply tries again — so `/check` answers `200` with `{"action":"transient_failure"}` rather than failing the cron job and triggering an alert email. If the outage persists for 3 consecutive runs, `/check` returns `502` so your cron service notifies you. Suppressed failures are still recorded (with `"suppressed": true`) and visible via `GET /status`.

## Notifications

If Pushover credentials are configured, you'll receive a push notification when MAX mode is triggered. To set this up:

1. Create an account at [pushover.net](https://pushover.net)
2. Create an application to get an API token
3. Set `PUSHOVER_USER` and `PUSHOVER_TOKEN` environment variables

If the variables are not set, notifications are silently skipped.

## Token Management

The initial refresh token is provided via the `NETATMO_REFRESH_TOKEN` environment variable. When Netatmo rotates the token during a refresh, the new token is automatically stored in Redis and used for subsequent requests.

## Local Development

```bash
pnpm install
pnpm dev
```

To test the `/check` endpoint locally:

```bash
curl -H "Authorization: Bearer $API_SECRET" http://localhost:3000/check
```

## License

MIT
