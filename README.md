# OKX Anomaly Scanner Dashboard

This repository contains the OKX anomaly scanner, a read-only VPS deployment, and a Vercel-hosted dashboard.

## Roles

- VPS `152.42.237.209`: runs the OKX public-market scanner and dashboard API 24/7.
- Vercel: serves the static frontend and proxies `/api/*` to the VPS dashboard API.
- Local Codex runtime: keeps the existing local scanner/heartbeat flow for Codex strong-signal strategy analysis and Telegram strategy pushes.

## VPS

The VPS copy uses `okx_anomaly_scanner/config.vps.json`. Telegram is disabled there by default to avoid duplicate local/Codex notifications.

Services:

- `okx-anomaly-scanner.service`
- `okx-dashboard.service`

Dashboard API:

```text
http://152.42.237.209:8787/api/dashboard
```

## Vercel

Production dashboard:

```text
https://hype-hazel.vercel.app
```

`vercel.json` builds the static frontend from `okx_anomaly_scanner/web` into `dist` and rewrites:

```text
/api/:path* -> http://152.42.237.209:8787/api/:path*
```

No trading credentials or Telegram secrets are committed.
