# OKX Anomaly Scanner

Local read-only scanner for OKX market anomalies. It stores snapshots in SQLite, writes alert events to JSONL, and exposes `alerts.json` for Codex automations.

The editable source lives in this workspace. The LaunchAgent runtime is installed at `/Users/2f/.codex/okx_anomaly_scanner` so macOS background jobs can read it without `~/Documents` privacy prompts.

The VPS runtime can use `config.vps.json`, which keeps the scanner read-only and disables Telegram by default so local Codex remains responsible for strong-signal strategy analysis and Telegram strategy pushes.

## Files

- `scripts/scanner.py`: 5-minute public market scanner and rules engine.
- `scripts/codex_alerts.py`: helper for Codex to read unseen strong alerts.
- `scripts/telegram_notify.py`: helper for Codex to push generated analysis and strategy text to Telegram.
- `scripts/dashboard_server.py`: read-only local web dashboard for latest and historical monitoring data.
- `scripts/hyperliquid_executor.mjs`: dry-run ticket generator plus strong-signal Hyperliquid testnet trial executor.
- `web/`: dashboard frontend assets.
- `config.json`: module frequencies and alert thresholds.
- `telegram.env`: local private Telegram credentials, stored only in the runtime directory.
- `hyperliquid.testnet.env`: ignored local Hyperliquid testnet signer file created from the example template.
- `data/alerts.json`: current strong and medium alerts.
- `data/events.jsonl`: append-only alert stream.
- `reports/latest_report.md`: human-readable latest report.

## Run

```bash
python3 scripts/scanner.py --once
python3 scripts/codex_alerts.py strong
```

## Dashboard

Start the local dashboard from the runtime directory:

```bash
python3 /Users/2f/.codex/okx_anomaly_scanner/scripts/dashboard_server.py --host 127.0.0.1 --port 8787
```

Open:

```text
http://127.0.0.1:8787
```

The dashboard is read-only. It serves `web/` and exposes `/api/dashboard`, aggregating:
- current `alerts.json` strong and medium signals;
- historical alerts from SQLite;
- recent event history from `events.jsonl`;
- price / OI / funding series for active instruments;
- latest 15-minute RSI / MACD / EMA snapshots;
- latest 15-minute funding-rate overview;
- latest 15-minute public news / sentiment snapshots;
- scanner run health and Telegram delivery status.

## Rules Engine

The alert engine is deterministic and auditable. Every alert now stores `score_components`, `directional_layers`, and a `strategy_plan` inside `metrics_json`.

Candidate filters:
- Spot candidates must be USDT-quoted and have at least 500,000 USDT estimated 24h volume.
- Swap candidates must be USDT-settled perpetuals and have at least 1,000,000 USDT estimated 24h volume.

Scoring layers:
- Ticker / volume: 5m price move, 15m price move, 1h trend, and 5m volume-delta ratio.
- Open interest: 5m and 15m OI change.
- Indicators: RSI14, EMA12/EMA26, and MACD histogram from the local 5m close snapshot series.
- Funding: latest public funding-rate snapshot.
- News / sentiment: recent RSS sentiment for the matched base asset, falling back to broad market context only for display.

Default thresholds:
- Medium alert: score >= 60.
- Strong alert: score >= 85.
- 5m price: 2.5%; 15m price: 5%; 1h price: 8%.
- Volume spike: current 5m volume delta >= 3x recent average and >= 100,000 USDT.
- 5m OI: 3%; 15m OI: 6%.
- Funding absolute rate: 0.0005.
- RSI overbought/oversold: 75 / 25.
- Asset news sentiment: absolute score >= 1.
- Multi-layer confluence: at least 3 aligned directional layers.

The strategy plan remains analysis-first. It gives bias, entry scenarios, invalidation, stop, take-profit, sizing, no-trade conditions, and execution mode. It is not an instruction to trade by itself.

## Hyperliquid Testnet Trial

`scripts/hyperliquid_executor.mjs` still converts the latest alert strategy plan into a dry-run ticket:

```bash
node okx_anomaly_scanner/scripts/hyperliquid_executor.mjs
node okx_anomaly_scanner/scripts/hyperliquid_executor.mjs --alert-id ALERT_ID
```

The same script can run a Hyperliquid testnet-only, strong-signal-only trial:

```bash
cp okx_anomaly_scanner/hyperliquid.testnet.env.example okx_anomaly_scanner/hyperliquid.testnet.env
node okx_anomaly_scanner/scripts/hyperliquid_executor.mjs --auto-once
node okx_anomaly_scanner/scripts/hyperliquid_executor.mjs --auto-loop
```

From the installed local runtime directory, the equivalent commands are:

```bash
cd /Users/2f/.codex/okx_anomaly_scanner
cp hyperliquid.testnet.env.example hyperliquid.testnet.env
node scripts/hyperliquid_executor.mjs --auto-once
node scripts/hyperliquid_executor.mjs --auto-loop
```

Fill `hyperliquid.testnet.env` locally before the autonomous modes run signed actions. `HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS` must be the master or sub-account address queried for positions; `HYPERLIQUID_TESTNET_PRIVATE_KEY` may be an approved API-wallet signer; `HYPERLIQUID_TESTNET_AUTONOMOUS` must keep the example acknowledgement value. Do not paste keys into chat or commit the filled file.

The testnet executor:
- starts a 3-day stateful session from the first `--auto-once` or `--auto-loop` cycle that has a ready testnet signer;
- reads only fresh `strong` OKX alerts, maps the OKX base asset to a Hyperliquid testnet perp, and skips unavailable assets;
- submits testnet IOC entries only when the signer gate is ready;
- checks its stored stop-loss and first take-profit level on later cycles and sends reduce-only testnet exits when hit;
- writes events to `data/hyperliquid_testnet_events.jsonl` and snapshots account positions, fills, and session state to `data/hyperliquid_testnet_state.json`.

The dashboard reads those files and displays the testnet trial next to the strategy panel. `--live` is blocked by this executor; the scanner itself remains OKX public-data only.

For the VPS runtime, install Node 20.19 or newer and run the bounded loop through `okx-hyperliquid-testnet.service`. It uses `/opt/okx_anomaly_scanner/config.vps.json`, reads the private `/opt/okx_anomaly_scanner/hyperliquid.testnet.env`, and exits cleanly once the three-day session ends.

## Telegram

Telegram push is enabled in `config.json`, but it only sends after local credentials exist. Do not paste the bot token into chat.

Create `/Users/2f/.codex/okx_anomaly_scanner/telegram.env`:

```bash
cp /Users/2f/.codex/okx_anomaly_scanner/telegram.env.example /Users/2f/.codex/okx_anomaly_scanner/telegram.env
chmod 600 /Users/2f/.codex/okx_anomaly_scanner/telegram.env
```

Then edit it locally:

```bash
TELEGRAM_BOT_TOKEN=123456789:replace_with_your_bot_token
TELEGRAM_CHAT_ID=123456789
```

Test delivery:

```bash
python3 /Users/2f/.codex/okx_anomaly_scanner/scripts/scanner.py --telegram-test
```

Once configured, the local LaunchAgent sends:
- one compact 5-minute scan result after each scan;
- one 60-minute summary when due.

When a strong alert appears, Codex heartbeat also sends the Codex-generated analysis and demo-first strategy to Telegram through:

```bash
python3 /Users/2f/.codex/okx_anomaly_scanner/scripts/telegram_notify.py --title "OKX strong signal strategy"
```

The analysis is still generated by Codex, not by the local rules engine. The local engine only identifies the signal.

## Schedule

The LaunchAgent in `launchd/com.codex.okx-anomaly-scanner.plist` runs the scanner every 5 minutes from `/Users/2f/.codex/okx_anomaly_scanner`.

Codex heartbeat also checks every 5 minutes. The intended order is: local LaunchAgent scans OKX public market data, writes `alerts.json`, then Codex checks for unseen strong alerts and reports only when action is useful.

## Frequency Layers

- Price / volume: every 5 minutes.
- Open interest: every 5 minutes.
- Kline indicators: RSI, MACD, EMA every 15 minutes, calculated from the local 5-minute close snapshot series for top-volume swaps.
- Funding rate: every 15 minutes, pulled from the OKX public funding endpoint for top-volume swaps.
- News / sentiment: every 15 minutes, using public RSS sources by default and local keyword sentiment scoring.
- Codex strong-alert watch: every 5 minutes, after the local scan writes `alerts.json`.

## Safety

The scanner never places orders and does not require OKX API credentials. Trade strategy suggestions should be treated as analysis only until the user explicitly confirms demo or live execution with a separate trading flow. Real-wallet trading must start with small testnet/dry-run validation, fixed max loss, and explicit per-trade confirmation.
