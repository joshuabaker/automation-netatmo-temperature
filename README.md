# Netatmo Temperature Monitor

A serverless Vercel application that monitors Netatmo thermostats and works around a firmware bug where the relay fails to stop heating, causing temperatures to overshoot the setpoint.

## How It Works

1. An external cron service (e.g., [cron-job.org](https://cron-job.org)) calls `/check` every 10 minutes
2. The app auto-discovers all thermostats across all homes linked to your account
3. For each thermostat, it checks if the temperature exceeds the setpoint by more than 1.0°C
4. If an overage is detected:
   - Sets the thermostat to MAX mode (30°C) to trigger the relay
   - Schedules a callback via Upstash QStash (queue: `netatmo-setpoint`) to reset after 30 seconds
   - Logs the overage event to Upstash Redis
5. When the QStash callback fires, the thermostat returns to "home" (schedule) mode

## Prerequisites

- Node.js 20+
- A Netatmo developer account and app
- Upstash Redis database
- Upstash QStash instance
- Vercel account
- External cron service (e.g., [cron-job.org](https://cron-job.org))

## Setup

### 1. Create a Netatmo App

1. Go to [dev.netatmo.com](https://dev.netatmo.com)
2. Create a new app with scopes: `read_thermostat write_thermostat`
3. Note your Client ID and Client Secret
4. Use the API console to complete an OAuth flow and obtain a refresh token

### 2. Set Up Upstash

1. Create a Redis database at [console.upstash.com](https://console.upstash.com)
2. Create a QStash instance
3. Note the credentials from both

### 3. Deploy to Vercel

```bash
pnpm install
vercel
```

### 4. Configure Environment Variables

Set these in your Vercel project settings:

| Variable | Description |
|----------|-------------|
| `API_SECRET` | Secret for authenticating cron requests (generate with `openssl rand -hex 32`) |
| `NETATMO_CLIENT_ID` | From Netatmo dev portal |
| `NETATMO_CLIENT_SECRET` | From Netatmo dev portal |
| `NETATMO_REFRESH_TOKEN` | From Netatmo OAuth flow |
| `VERCEL_URL` | Auto-set by Vercel in production |
| `UPSTASH_REDIS_REST_URL` | From Upstash console |
| `UPSTASH_REDIS_REST_TOKEN` | From Upstash console |
| `QSTASH_TOKEN` | From Upstash console |
| `QSTASH_CURRENT_SIGNING_KEY` | From Upstash console |
| `QSTASH_NEXT_SIGNING_KEY` | From Upstash console |

### 5. Set Up External Cron

1. Create a free account at [cron-job.org](https://cron-job.org)
2. Create a new cron job:
   - **URL:** `https://your-app.vercel.app/check`
   - **Schedule:** Every 10 minutes (`*/10 * * * *`)
   - **Request method:** GET
   - **Headers:** `Authorization: Bearer YOUR_API_SECRET`

## API Endpoints

### `GET /check`

Checks all thermostats for temperature overages. Requires `Authorization: Bearer <API_SECRET>` header.

### `POST /reset`

Called by QStash after a delay. Resets the thermostat to home mode. Authenticated via QStash signature.

### `GET /health`

Health check endpoint (no authentication required).

## Configuration

### Temperature Threshold

The default threshold is 1.0°C above setpoint. To change it, modify `OVERAGE_THRESHOLD` in `src/api/check.ts`.

### Reset Delay

The default delay before resetting is 30 seconds. To change it, modify `DEFAULT_RESET_DELAY_SECONDS` in `src/lib/qstash.ts`.

### QStash Queue

Messages are sent to the `netatmo-setpoint` queue. This can be changed in `src/lib/qstash.ts`.

## Token Management

The initial refresh token is provided via the `NETATMO_REFRESH_TOKEN` environment variable. When Netatmo rotates the token during a refresh, the new token is automatically stored in Redis and used for subsequent requests.

## Logging

Overage events are stored in Upstash Redis as a sorted set with timestamps. Events include:
- `overage_detected` - When temperature exceeds threshold
- `reset_triggered` - When MAX mode is set
- `reset_completed` - When returned to home mode

## Local Development

```bash
pnpm install
pnpm dev
```

To test the `/check` endpoint locally:

```bash
curl -H "Authorization: Bearer $API_SECRET" http://localhost:3000/check
```

Note: For QStash callbacks to work locally, expose your local server via ngrok or similar and set `VERCEL_URL` accordingly.

## License

MIT
