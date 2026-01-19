# Netatmo Temperature Monitor

A serverless Vercel application that monitors a Netatmo thermostat and works around a firmware bug where the relay fails to stop heating, causing temperatures to overshoot the setpoint.

## How It Works

1. An external cron service (e.g., [cron-job.org](https://cron-job.org)) calls `/check` every 5 minutes
2. The app gets the current temperature and setpoint from the first thermostat
3. If MAX mode is active, it resets to home/schedule mode and exits
4. If the temperature exceeds the setpoint by more than 1°C for two consecutive checks, it triggers MAX mode for 1 minute to reset the relay

## Prerequisites

- Node.js 20+
- A Netatmo developer account and app
- Upstash Redis database
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
2. Note the REST URL and token

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
| `UPSTASH_REDIS_REST_URL` | From Upstash console |
| `UPSTASH_REDIS_REST_TOKEN` | From Upstash console |

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
