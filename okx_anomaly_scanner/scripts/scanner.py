#!/usr/bin/env python3
"""OKX public-market anomaly scanner.

The scanner is intentionally read-only. It gathers public OKX market data,
stores snapshots in SQLite, computes price/volume/OI/funding anomalies, and
writes alerts for Codex or a human to review. It never places orders.
"""

from __future__ import annotations

import argparse
import datetime as dt
import email.utils
import hashlib
import json
import math
import os
from pathlib import Path
import sqlite3
import statistics
import sys
import time
from typing import Any
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET


BASE_DIR = Path(__file__).resolve().parents[1]
CONFIG_PATH = BASE_DIR / "config.json"
OKX_BASE_URL = "https://www.okx.com"
TELEGRAM_BASE_URL = "https://api.telegram.org"
HEADERS = {
    "Accept": "application/json",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X) Codex OKX anomaly scanner",
}

NEWS_SOURCES = [
    {"name": "CoinDesk", "url": "https://www.coindesk.com/arc/outboundfeeds/rss/"},
    {"name": "Cointelegraph", "url": "https://cointelegraph.com/rss"},
]
POSITIVE_TERMS = {
    "bullish",
    "surge",
    "rally",
    "gain",
    "gains",
    "jump",
    "jumps",
    "rise",
    "rises",
    "up",
    "record",
    "approval",
    "approved",
    "inflow",
    "inflows",
    "breakout",
    "adoption",
    "partnership",
}
NEGATIVE_TERMS = {
    "bearish",
    "drop",
    "drops",
    "fall",
    "falls",
    "plunge",
    "crash",
    "selloff",
    "hack",
    "exploit",
    "lawsuit",
    "probe",
    "ban",
    "outflow",
    "outflows",
    "liquidation",
    "liquidations",
    "risk",
    "scam",
}
ASSET_TERMS = {
    "BTC": ("BTC", "Bitcoin"),
    "ETH": ("ETH", "Ether", "Ethereum"),
    "SOL": ("SOL", "Solana"),
    "XRP": ("XRP", "Ripple"),
    "DOGE": ("DOGE", "Dogecoin"),
    "BNB": ("BNB", "Binance"),
    "OKB": ("OKB", "OKX"),
    "TRX": ("TRX", "Tron"),
    "ADA": ("ADA", "Cardano"),
    "AVAX": ("AVAX", "Avalanche"),
    "LINK": ("LINK", "Chainlink"),
}


def utc_now_ms() -> int:
    return int(time.time() * 1000)


def iso_from_ms(ts_ms: int) -> str:
    return dt.datetime.fromtimestamp(ts_ms / 1000, tz=dt.timezone.utc).isoformat()


def to_float(value: Any, default: float | None = None) -> float | None:
    if value in (None, ""):
        return default
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    if math.isnan(out) or math.isinf(out):
        return default
    return out


def load_config(path: Path = CONFIG_PATH) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def path_from_config(config: dict[str, Any], key: str) -> Path:
    return BASE_DIR / config["paths"][key]


def resolve_local_path(path_value: str | None) -> Path | None:
    if not path_value:
        return None
    path = Path(path_value).expanduser()
    return path if path.is_absolute() else BASE_DIR / path


def okx_get(endpoint: str, params: dict[str, Any] | None = None, retries: int = 3) -> list[dict[str, Any]]:
    query = urllib.parse.urlencode({k: v for k, v in (params or {}).items() if v is not None})
    url = f"{OKX_BASE_URL}{endpoint}"
    if query:
        url = f"{url}?{query}"
    last_error: Exception | None = None
    for attempt in range(retries):
        request = urllib.request.Request(url, headers=HEADERS)
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                payload = json.loads(response.read().decode("utf-8"))
            if payload.get("code") != "0":
                raise RuntimeError(f"OKX API error {payload.get('code')}: {payload.get('msg')}")
            data = payload.get("data")
            return data if isinstance(data, list) else []
        except Exception as exc:  # noqa: BLE001 - keep scanner resilient.
            last_error = exc
            if attempt < retries - 1:
                time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"OKX request failed for {url}: {last_error}")


def load_env_file(path: Path | None) -> dict[str, str]:
    values: dict[str, str] = {}
    if path is None or not path.exists():
        return values
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def telegram_credentials(config: dict[str, Any]) -> tuple[str | None, str | None]:
    telegram_cfg = config.get("telegram", {})
    env_file = resolve_local_path(telegram_cfg.get("env_file"))
    file_values = load_env_file(env_file)
    token = os.environ.get("TELEGRAM_BOT_TOKEN") or file_values.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID") or file_values.get("TELEGRAM_CHAT_ID")
    if token and ("replace_with" in token or token.startswith("123456789:")):
        token = None
    if chat_id and ("replace_with" in chat_id or chat_id == "123456789"):
        chat_id = None
    return token, chat_id


def write_telegram_status(status: str, detail: str) -> None:
    status_path = BASE_DIR / "data" / "telegram_status.json"
    status_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "ts": utc_now_ms(),
        "iso_ts": iso_from_ms(utc_now_ms()),
        "status": status,
        "detail": detail,
    }
    status_path.write_text(json.dumps(payload, ensure_ascii=True, indent=2), encoding="utf-8")


def send_telegram_message(config: dict[str, Any], text: str) -> bool:
    telegram_cfg = config.get("telegram", {})
    if not telegram_cfg.get("enabled", False):
        write_telegram_status("disabled", "telegram.enabled is false")
        return False
    token, chat_id = telegram_credentials(config)
    if not token or not chat_id:
        write_telegram_status(
            "missing_credentials",
            "Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in /Users/2f/.codex/okx_anomaly_scanner/telegram.env",
        )
        return False
    url = f"{TELEGRAM_BASE_URL}/bot{token}/sendMessage"
    payload = urllib.parse.urlencode(
        {
            "chat_id": chat_id,
            "text": text[:3900],
            "disable_web_page_preview": "true",
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": HEADERS["User-Agent"],
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            result = json.loads(response.read().decode("utf-8"))
        if result.get("ok") is not True:
            write_telegram_status("error", json.dumps(result, ensure_ascii=True))
            return False
        write_telegram_status("sent", "message delivered")
        return True
    except Exception as exc:  # noqa: BLE001 - notifications must not break scanning.
        write_telegram_status("error", str(exc))
        return False


def connect_db(config: dict[str, Any]) -> sqlite3.Connection:
    db_path = path_from_config(config, "database")
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    init_db(conn)
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          status TEXT NOT NULL,
          spot_count INTEGER DEFAULT 0,
          swap_count INTEGER DEFAULT 0,
          oi_count INTEGER DEFAULT 0,
          alert_count INTEGER DEFAULT 0,
          strong_alert_count INTEGER DEFAULT 0,
          duration_ms INTEGER DEFAULT 0,
          error TEXT
        );

        CREATE TABLE IF NOT EXISTS snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          inst_id TEXT NOT NULL,
          inst_type TEXT NOT NULL,
          last REAL,
          open24h REAL,
          high24h REAL,
          low24h REAL,
          volume_usd_24h REAL,
          raw_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_snapshots_inst_ts ON snapshots(inst_id, ts);

        CREATE TABLE IF NOT EXISTS oi_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          inst_id TEXT NOT NULL,
          oi REAL,
          oi_ccy REAL,
          oi_usd REAL,
          raw_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_oi_inst_ts ON oi_snapshots(inst_id, ts);

        CREATE TABLE IF NOT EXISTS funding_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          inst_id TEXT NOT NULL,
          funding_rate REAL,
          next_funding_rate REAL,
          funding_time INTEGER,
          raw_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_funding_inst_ts ON funding_snapshots(inst_id, ts);

        CREATE TABLE IF NOT EXISTS indicator_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          inst_id TEXT NOT NULL,
          bar TEXT NOT NULL,
          close REAL,
          rsi14 REAL,
          ema12 REAL,
          ema26 REAL,
          macd REAL,
          macd_signal REAL,
          macd_hist REAL,
          sample_count INTEGER DEFAULT 0,
          raw_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_indicator_inst_ts ON indicator_snapshots(inst_id, ts);

        CREATE TABLE IF NOT EXISTS news_sentiment_snapshots (
          item_id TEXT PRIMARY KEY,
          ts INTEGER NOT NULL,
          source TEXT NOT NULL,
          title TEXT NOT NULL,
          link TEXT,
          published_ms INTEGER,
          sentiment_score REAL,
          sentiment_label TEXT,
          matched_assets_json TEXT NOT NULL,
          raw_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_news_sentiment_ts ON news_sentiment_snapshots(ts);

        CREATE TABLE IF NOT EXISTS alerts (
          alert_id TEXT PRIMARY KEY,
          ts INTEGER NOT NULL,
          inst_id TEXT NOT NULL,
          inst_type TEXT NOT NULL,
          severity TEXT NOT NULL,
          score INTEGER NOT NULL,
          direction TEXT,
          signals_json TEXT NOT NULL,
          metrics_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(ts);

        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        """
    )
    for column, definition in {
        "indicator_count": "INTEGER DEFAULT 0",
        "news_count": "INTEGER DEFAULT 0",
    }.items():
        try:
            conn.execute(f"ALTER TABLE runs ADD COLUMN {column} {definition}")
        except sqlite3.OperationalError as exc:
            if "duplicate column name" not in str(exc).lower():
                raise
    conn.commit()


def get_meta_int(conn: sqlite3.Connection, key: str, default: int = 0) -> int:
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    if not row:
        return default
    try:
        return int(row["value"])
    except ValueError:
        return default


def set_meta(conn: sqlite3.Connection, key: str, value: Any) -> None:
    conn.execute(
        "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, str(value)),
    )


def is_due(conn: sqlite3.Connection, key: str, interval_minutes: int, now_ms: int) -> bool:
    last_ms = get_meta_int(conn, key, 0)
    return now_ms - last_ms >= interval_minutes * 60_000


def volume_usd_from_ticker(ticker: dict[str, Any]) -> float | None:
    inst_id = str(ticker.get("instId", ""))
    last = to_float(ticker.get("last"))
    vol_ccy = to_float(ticker.get("volCcy24h"))
    vol = to_float(ticker.get("vol24h"))
    if vol_ccy is None:
        return None
    if inst_id.endswith("-USDT") and not inst_id.endswith("-USDT-SWAP"):
        return vol_ccy
    if inst_id.endswith("-USDT-SWAP") and last is not None:
        return vol_ccy * last
    if vol is not None and last is not None:
        return vol * last
    return vol_ccy


def normalize_ticker(ticker: dict[str, Any]) -> dict[str, Any]:
    ts = int(ticker.get("ts") or utc_now_ms())
    return {
        "ts": ts,
        "inst_id": ticker.get("instId"),
        "inst_type": ticker.get("instType"),
        "last": to_float(ticker.get("last")),
        "open24h": to_float(ticker.get("open24h")),
        "high24h": to_float(ticker.get("high24h")),
        "low24h": to_float(ticker.get("low24h")),
        "volume_usd_24h": volume_usd_from_ticker(ticker),
        "raw_json": json.dumps(ticker, separators=(",", ":"), sort_keys=True),
    }


def fetch_market_data(config: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    quote = config["markets"]["spot_quote_ccy"]
    settle = config["markets"]["swap_settle_ccy"]
    spot = [
        normalize_ticker(row)
        for row in okx_get("/api/v5/market/tickers", {"instType": "SPOT"})
        if str(row.get("instId", "")).endswith(f"-{quote}")
    ]
    swap = [
        normalize_ticker(row)
        for row in okx_get("/api/v5/market/tickers", {"instType": "SWAP"})
        if str(row.get("instId", "")).endswith(f"-{settle}-SWAP")
    ]
    oi = [
        {
            "ts": int(row.get("ts") or utc_now_ms()),
            "inst_id": row.get("instId"),
            "oi": to_float(row.get("oi")),
            "oi_ccy": to_float(row.get("oiCcy")),
            "oi_usd": to_float(row.get("oiUsd")),
            "raw_json": json.dumps(row, separators=(",", ":"), sort_keys=True),
        }
        for row in okx_get("/api/v5/public/open-interest", {"instType": "SWAP"})
        if str(row.get("instId", "")).endswith(f"-{settle}-SWAP")
    ]
    return spot, swap, oi


def save_snapshots(conn: sqlite3.Connection, tickers: list[dict[str, Any]], oi_rows: list[dict[str, Any]]) -> None:
    conn.executemany(
        """
        INSERT INTO snapshots(ts, inst_id, inst_type, last, open24h, high24h, low24h, volume_usd_24h, raw_json)
        VALUES(:ts, :inst_id, :inst_type, :last, :open24h, :high24h, :low24h, :volume_usd_24h, :raw_json)
        """,
        tickers,
    )
    conn.executemany(
        """
        INSERT INTO oi_snapshots(ts, inst_id, oi, oi_ccy, oi_usd, raw_json)
        VALUES(:ts, :inst_id, :oi, :oi_ccy, :oi_usd, :raw_json)
        """,
        oi_rows,
    )
    conn.commit()


def fetch_and_save_funding(conn: sqlite3.Connection, config: dict[str, Any], swap_rows: list[dict[str, Any]], now_ms: int) -> int:
    if not is_due(conn, "last_funding_scan_ms", config["module_frequencies_minutes"]["funding"], now_ms):
        return 0
    top_n = int(config["markets"]["funding_top_swaps"])
    candidates = sorted(
        [row for row in swap_rows if row.get("volume_usd_24h") is not None],
        key=lambda row: row["volume_usd_24h"],
        reverse=True,
    )[:top_n]
    saved = 0
    for row in candidates:
        inst_id = row["inst_id"]
        try:
            data = okx_get("/api/v5/public/funding-rate", {"instId": inst_id}, retries=2)
        except RuntimeError:
            continue
        for item in data:
            payload = {
                "ts": int(item.get("ts") or now_ms),
                "inst_id": item.get("instId"),
                "funding_rate": to_float(item.get("fundingRate")),
                "next_funding_rate": to_float(item.get("nextFundingRate")),
                "funding_time": int(item.get("fundingTime") or 0),
                "raw_json": json.dumps(item, separators=(",", ":"), sort_keys=True),
            }
            conn.execute(
                """
                INSERT INTO funding_snapshots(ts, inst_id, funding_rate, next_funding_rate, funding_time, raw_json)
                VALUES(:ts, :inst_id, :funding_rate, :next_funding_rate, :funding_time, :raw_json)
                """,
                payload,
            )
            saved += 1
        time.sleep(0.08)
    set_meta(conn, "last_funding_scan_ms", now_ms)
    conn.commit()
    return saved


def ema(values: list[float], period: int) -> list[float]:
    if not values:
        return []
    multiplier = 2 / (period + 1)
    output = [values[0]]
    for value in values[1:]:
        output.append((value - output[-1]) * multiplier + output[-1])
    return output


def rsi(values: list[float], period: int = 14) -> float | None:
    if len(values) <= period:
        return None
    gains: list[float] = []
    losses: list[float] = []
    for newer, older in zip(values[-period:], values[-period - 1 : -1]):
        delta = newer - older
        gains.append(max(delta, 0))
        losses.append(max(-delta, 0))
    avg_gain = statistics.mean(gains)
    avg_loss = statistics.mean(losses)
    if avg_loss == 0:
        return 100.0
    relative_strength = avg_gain / avg_loss
    return 100 - (100 / (1 + relative_strength))


def compute_indicator_values(values: list[float]) -> dict[str, float | None]:
    if len(values) < 35:
        return {
            "rsi14": None,
            "ema12": None,
            "ema26": None,
            "macd": None,
            "macd_signal": None,
            "macd_hist": None,
        }
    ema12_series = ema(values, 12)
    ema26_series = ema(values, 26)
    macd_series = [fast - slow for fast, slow in zip(ema12_series, ema26_series)]
    signal_series = ema(macd_series, 9)
    macd_value = macd_series[-1]
    signal_value = signal_series[-1]
    return {
        "rsi14": rsi(values, 14),
        "ema12": ema12_series[-1],
        "ema26": ema26_series[-1],
        "macd": macd_value,
        "macd_signal": signal_value,
        "macd_hist": macd_value - signal_value,
    }


def fetch_and_save_indicators(conn: sqlite3.Connection, config: dict[str, Any], swap_rows: list[dict[str, Any]], now_ms: int) -> int:
    if not is_due(conn, "last_indicator_scan_ms", config["module_frequencies_minutes"]["indicators"], now_ms):
        return 0
    top_n = int(config.get("markets", {}).get("indicator_top_swaps", 80))
    candidates = sorted(
        [row for row in swap_rows if row.get("volume_usd_24h") is not None],
        key=lambda row: row["volume_usd_24h"],
        reverse=True,
    )[:top_n]
    saved = 0
    for row in candidates:
        inst_id = row["inst_id"]
        rows = conn.execute(
            """
            SELECT ts, last
            FROM snapshots
            WHERE inst_id = ? AND last IS NOT NULL
            ORDER BY ts DESC
            LIMIT 120
            """,
            (inst_id,),
        ).fetchall()
        closes = [float(item["last"]) for item in reversed(rows) if item["last"] is not None]
        if len(closes) < 35:
            continue
        values = compute_indicator_values(closes)
        payload = {
            "ts": now_ms,
            "inst_id": inst_id,
            "bar": "5m_snapshot",
            "close": closes[-1],
            "sample_count": len(closes),
            **values,
        }
        raw = {
            "method": "close-series-from-5m-snapshots",
            "sample_count": len(closes),
            "close": closes[-1],
            **values,
        }
        conn.execute(
            """
            INSERT INTO indicator_snapshots(
              ts, inst_id, bar, close, rsi14, ema12, ema26, macd, macd_signal, macd_hist, sample_count, raw_json
            )
            VALUES(:ts, :inst_id, :bar, :close, :rsi14, :ema12, :ema26, :macd, :macd_signal, :macd_hist, :sample_count, :raw_json)
            """,
            {**payload, "raw_json": json.dumps(raw, separators=(",", ":"), sort_keys=True)},
        )
        saved += 1
    set_meta(conn, "last_indicator_scan_ms", now_ms)
    conn.commit()
    return saved


def parse_news_time(value: str | None, default_ms: int) -> int:
    if not value:
        return default_ms
    try:
        parsed = email.utils.parsedate_to_datetime(value)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=dt.timezone.utc)
        return int(parsed.timestamp() * 1000)
    except Exception:
        return default_ms


def sentiment_for_text(text: str) -> tuple[float, str, list[str]]:
    lowered = text.lower()
    positive = sum(1 for term in POSITIVE_TERMS if term in lowered)
    negative = sum(1 for term in NEGATIVE_TERMS if term in lowered)
    score = float(positive - negative)
    if score >= 1:
        label = "positive"
    elif score <= -1:
        label = "negative"
    else:
        label = "neutral"
    matched: list[str] = []
    for asset, terms in ASSET_TERMS.items():
        if any(term.lower() in lowered for term in terms):
            matched.append(asset)
    return score, label, matched


def fetch_rss_items(source: dict[str, str], now_ms: int, limit: int) -> list[dict[str, Any]]:
    request = urllib.request.Request(source["url"], headers=HEADERS)
    with urllib.request.urlopen(request, timeout=12) as response:
        xml = response.read()
    root = ET.fromstring(xml)
    items: list[dict[str, Any]] = []
    for item in root.findall(".//item")[:limit]:
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        published = item.findtext("pubDate") or item.findtext("{http://purl.org/dc/elements/1.1/}date")
        if not title:
            continue
        score, label, matched_assets = sentiment_for_text(title)
        item_id = hashlib.sha256(f"{source['name']}:{link or title}".encode("utf-8")).hexdigest()[:24]
        payload = {
            "item_id": item_id,
            "ts": now_ms,
            "source": source["name"],
            "title": title,
            "link": link,
            "published_ms": parse_news_time(published, now_ms),
            "sentiment_score": score,
            "sentiment_label": label,
            "matched_assets": matched_assets,
        }
        items.append(payload)
    return items


def fetch_and_save_news_sentiment(conn: sqlite3.Connection, config: dict[str, Any], now_ms: int) -> int:
    if not is_due(conn, "last_news_sentiment_scan_ms", config["module_frequencies_minutes"]["news_sentiment"], now_ms):
        return 0
    news_cfg = config.get("news_sentiment", {})
    if news_cfg.get("enabled", True) is False:
        set_meta(conn, "last_news_sentiment_scan_ms", now_ms)
        conn.commit()
        return 0
    sources = news_cfg.get("sources") or NEWS_SOURCES
    limit = int(news_cfg.get("max_items_per_source", 20))
    inserted = 0
    for source in sources:
        try:
            items = fetch_rss_items(source, now_ms, limit)
        except Exception:
            continue
        for item in items:
            before = conn.total_changes
            conn.execute(
                """
                INSERT OR IGNORE INTO news_sentiment_snapshots(
                  item_id, ts, source, title, link, published_ms, sentiment_score, sentiment_label, matched_assets_json, raw_json
                )
                VALUES(:item_id, :ts, :source, :title, :link, :published_ms, :sentiment_score, :sentiment_label, :matched_assets_json, :raw_json)
                """,
                {
                    **item,
                    "matched_assets_json": json.dumps(item["matched_assets"], separators=(",", ":"), sort_keys=True),
                    "raw_json": json.dumps(item, separators=(",", ":"), sort_keys=True),
                },
            )
            if conn.total_changes > before:
                inserted += 1
    set_meta(conn, "last_news_sentiment_scan_ms", now_ms)
    conn.commit()
    return inserted


def previous_snapshot(conn: sqlite3.Connection, inst_id: str, target_ts: int, tolerance_ms: int) -> sqlite3.Row | None:
    return conn.execute(
        """
        SELECT * FROM snapshots
        WHERE inst_id = ? AND ts <= ? AND ts >= ?
        ORDER BY ts DESC
        LIMIT 1
        """,
        (inst_id, target_ts, target_ts - tolerance_ms),
    ).fetchone()


def previous_oi(conn: sqlite3.Connection, inst_id: str, target_ts: int, tolerance_ms: int) -> sqlite3.Row | None:
    return conn.execute(
        """
        SELECT * FROM oi_snapshots
        WHERE inst_id = ? AND ts <= ? AND ts >= ?
        ORDER BY ts DESC
        LIMIT 1
        """,
        (inst_id, target_ts, target_ts - tolerance_ms),
    ).fetchone()


def latest_funding(conn: sqlite3.Connection, inst_id: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM funding_snapshots WHERE inst_id = ? ORDER BY ts DESC LIMIT 1",
        (inst_id,),
    ).fetchone()


def pct_change(current: float | None, previous: float | None) -> float | None:
    if current is None or previous in (None, 0):
        return None
    return ((current - previous) / previous) * 100


def volume_delta_stats(conn: sqlite3.Connection, inst_id: str) -> tuple[float | None, float | None]:
    rows = conn.execute(
        """
        SELECT ts, volume_usd_24h
        FROM snapshots
        WHERE inst_id = ? AND volume_usd_24h IS NOT NULL
        ORDER BY ts DESC
        LIMIT 16
        """,
        (inst_id,),
    ).fetchall()
    if len(rows) < 3:
        return None, None
    deltas: list[float] = []
    for newer, older in zip(rows, rows[1:]):
        delta = float(newer["volume_usd_24h"]) - float(older["volume_usd_24h"])
        if delta >= 0:
            deltas.append(delta)
    if not deltas:
        return None, None
    current_delta = deltas[0]
    baseline = deltas[1:] or deltas
    average = statistics.mean(baseline) if baseline else None
    ratio = current_delta / average if average and average > 0 else None
    return current_delta, ratio


def compute_metrics(
    conn: sqlite3.Connection,
    row: dict[str, Any],
    oi_by_inst: dict[str, dict[str, Any]],
    now_ms: int,
) -> dict[str, Any]:
    inst_id = row["inst_id"]
    last = row.get("last")
    metrics: dict[str, Any] = {
        "last": last,
        "volume_usd_24h": row.get("volume_usd_24h"),
    }
    windows = {
        "5m": (5 * 60_000, 4 * 60_000),
        "15m": (15 * 60_000, 7 * 60_000),
        "1h": (60 * 60_000, 20 * 60_000),
    }
    for label, (window_ms, tolerance_ms) in windows.items():
        prior = previous_snapshot(conn, inst_id, now_ms - window_ms, tolerance_ms)
        metrics[f"price_change_{label}_pct"] = pct_change(last, prior["last"] if prior else None)
    delta, ratio = volume_delta_stats(conn, inst_id)
    metrics["volume_delta_usd_5m"] = delta
    metrics["volume_ratio"] = ratio

    oi = oi_by_inst.get(inst_id)
    if oi:
        metrics["oi_usd"] = oi.get("oi_usd")
        for label, (window_ms, tolerance_ms) in {"5m": (5 * 60_000, 4 * 60_000), "15m": (15 * 60_000, 7 * 60_000)}.items():
            prior_oi = previous_oi(conn, inst_id, now_ms - window_ms, tolerance_ms)
            metrics[f"oi_delta_{label}_pct"] = pct_change(oi.get("oi_usd"), prior_oi["oi_usd"] if prior_oi else None)
    funding = latest_funding(conn, inst_id)
    if funding:
        metrics["funding_rate"] = funding["funding_rate"]
        metrics["funding_time"] = funding["funding_time"]
    return metrics


def classify_alert(config: dict[str, Any], row: dict[str, Any], metrics: dict[str, Any]) -> dict[str, Any] | None:
    thresholds = config["thresholds"]
    score = 0
    signals: list[str] = []
    direction = "neutral"
    price_5m = metrics.get("price_change_5m_pct")
    price_15m = metrics.get("price_change_15m_pct")
    price_1h = metrics.get("price_change_1h_pct")
    volume_ratio = metrics.get("volume_ratio")
    volume_delta = metrics.get("volume_delta_usd_5m")
    oi_5m = metrics.get("oi_delta_5m_pct")
    oi_15m = metrics.get("oi_delta_15m_pct")
    funding = metrics.get("funding_rate")

    if price_5m is not None and abs(price_5m) >= thresholds["price_change_5m_pct"]:
        score += 25
        direction = "up" if price_5m > 0 else "down"
        signals.append(f"price_5m_{direction}")
    if price_15m is not None and abs(price_15m) >= thresholds["price_change_15m_pct"]:
        score += 25
        signals.append("price_15m_breakout" if price_15m > 0 else "price_15m_breakdown")
    if price_1h is not None and abs(price_1h) >= thresholds["price_change_1h_pct"]:
        score += 15
        signals.append("price_1h_trend")

    if (
        volume_ratio is not None
        and volume_delta is not None
        and volume_ratio >= thresholds["volume_ratio"]
        and volume_delta >= thresholds["min_volume_delta_usd_5m"]
    ):
        score += 20
        signals.append("volume_spike")

    if oi_5m is not None and abs(oi_5m) >= thresholds["oi_delta_5m_pct"]:
        score += 25
        signals.append("oi_5m_up" if oi_5m > 0 else "oi_5m_down")
    if oi_15m is not None and abs(oi_15m) >= thresholds["oi_delta_15m_pct"]:
        score += 15
        signals.append("oi_15m_up" if oi_15m > 0 else "oi_15m_down")

    if funding is not None and abs(funding) >= thresholds["funding_abs_rate"]:
        score += 10
        signals.append("high_positive_funding" if funding > 0 else "high_negative_funding")

    if price_5m is not None and oi_5m is not None:
        price_trigger = abs(price_5m) >= thresholds["price_change_5m_pct"]
        oi_trigger = abs(oi_5m) >= thresholds["oi_delta_5m_pct"]
        if price_trigger and oi_trigger:
            if price_5m > 0 and oi_5m > 0:
                score += 15
                signals.append("long_building")
            elif price_5m < 0 and oi_5m > 0:
                score += 15
                signals.append("short_building")
            elif price_5m > 0 and oi_5m < 0:
                score += 10
                signals.append("short_covering")
            elif price_5m < 0 and oi_5m < 0:
                score += 10
                signals.append("long_liquidation_or_deleveraging")

    score = min(score, 100)
    severity = None
    if score >= thresholds["strong_score"]:
        severity = "strong"
    elif score >= thresholds["medium_score"]:
        severity = "medium"
    if not severity:
        return None

    bucket = int((row["ts"] or utc_now_ms()) // 300_000)
    key = f"{row['inst_id']}:{bucket}:{severity}:{','.join(sorted(set(signals)))}"
    alert_id = hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]
    return {
        "alert_id": alert_id,
        "ts": int(row["ts"] or utc_now_ms()),
        "iso_ts": iso_from_ms(int(row["ts"] or utc_now_ms())),
        "inst_id": row["inst_id"],
        "inst_type": row["inst_type"],
        "severity": severity,
        "score": score,
        "direction": direction,
        "signals": sorted(set(signals)),
        "metrics": metrics,
    }


def insert_alerts(conn: sqlite3.Connection, alerts: list[dict[str, Any]], config: dict[str, Any]) -> list[dict[str, Any]]:
    inserted: list[dict[str, Any]] = []
    for alert in alerts:
        before = conn.total_changes
        conn.execute(
            """
            INSERT OR IGNORE INTO alerts(alert_id, ts, inst_id, inst_type, severity, score, direction, signals_json, metrics_json)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                alert["alert_id"],
                alert["ts"],
                alert["inst_id"],
                alert["inst_type"],
                alert["severity"],
                int(alert["score"]),
                alert["direction"],
                json.dumps(alert["signals"], separators=(",", ":"), sort_keys=True),
                json.dumps(alert["metrics"], separators=(",", ":"), sort_keys=True),
            ),
        )
        if conn.total_changes > before:
            inserted.append(alert)
    conn.commit()
    if inserted:
        events_path = path_from_config(config, "events_jsonl")
        events_path.parent.mkdir(parents=True, exist_ok=True)
        with events_path.open("a", encoding="utf-8") as handle:
            for alert in inserted:
                handle.write(json.dumps({"type": "alert", **alert}, ensure_ascii=True, separators=(",", ":")) + "\n")
    return inserted


def recent_alerts(conn: sqlite3.Connection, minutes: int, severity: str | None = None) -> list[dict[str, Any]]:
    cutoff = utc_now_ms() - minutes * 60_000
    params: list[Any] = [cutoff]
    where = "ts >= ?"
    if severity:
        where += " AND severity = ?"
        params.append(severity)
    rows = conn.execute(
        f"SELECT * FROM alerts WHERE {where} ORDER BY score DESC, ts DESC LIMIT 50",
        params,
    ).fetchall()
    output: list[dict[str, Any]] = []
    for row in rows:
        output.append(
            {
                "alert_id": row["alert_id"],
                "ts": row["ts"],
                "iso_ts": iso_from_ms(row["ts"]),
                "inst_id": row["inst_id"],
                "inst_type": row["inst_type"],
                "severity": row["severity"],
                "score": row["score"],
                "direction": row["direction"],
                "signals": json.loads(row["signals_json"]),
                "metrics": json.loads(row["metrics_json"]),
            }
        )
    return output


def write_outputs(
    conn: sqlite3.Connection,
    config: dict[str, Any],
    inserted: list[dict[str, Any]],
    run_stats: dict[str, Any],
) -> None:
    alert_window = int(config["thresholds"]["alert_window_minutes"])
    strong_recent = recent_alerts(conn, alert_window, "strong")
    medium_recent = recent_alerts(conn, alert_window, "medium")
    new_strong_ids = [alert["alert_id"] for alert in inserted if alert["severity"] == "strong"]
    alerts_payload = {
        "generated_at": iso_from_ms(utc_now_ms()),
        "generated_at_ms": utc_now_ms(),
        "schema_version": 1,
        "source": "okx_public_market_api",
        "trading_executed": False,
        "new_strong_alert_ids": new_strong_ids,
        "strong_alerts": strong_recent,
        "medium_alerts": medium_recent[:20],
        "run_stats": run_stats,
        "notes": [
            "Scanner is read-only and never places orders.",
            "Strong alerts are candidates for Codex analysis, not trade instructions.",
        ],
    }
    alerts_path = path_from_config(config, "alerts_json")
    alerts_path.parent.mkdir(parents=True, exist_ok=True)
    alerts_path.write_text(json.dumps(alerts_payload, ensure_ascii=True, indent=2), encoding="utf-8")

    if new_strong_ids:
        flag_path = path_from_config(config, "strong_alert_flag")
        flag_path.write_text(
            json.dumps(
                {
                    "generated_at": alerts_payload["generated_at"],
                    "new_strong_alert_ids": new_strong_ids,
                },
                ensure_ascii=True,
                indent=2,
            ),
            encoding="utf-8",
        )

    report_path = path_from_config(config, "latest_report")
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(render_report(alerts_payload), encoding="utf-8")


def fmt_pct(value: Any) -> str:
    return "n/a" if value is None else f"{float(value):+.2f}%"


def fmt_num(value: Any) -> str:
    if value is None:
        return "n/a"
    value = float(value)
    if abs(value) >= 1_000_000_000:
        return f"{value / 1_000_000_000:.2f}B"
    if abs(value) >= 1_000_000:
        return f"{value / 1_000_000:.2f}M"
    if abs(value) >= 1_000:
        return f"{value / 1_000:.2f}K"
    return f"{value:.2f}"


def render_report(payload: dict[str, Any]) -> str:
    lines = [
        "# OKX Anomaly Scanner Report",
        "",
        f"Generated: {payload['generated_at']}",
        "",
        "No trades were executed. This is a read-only market anomaly report.",
        "",
        "## Strong Alerts",
        "",
    ]
    if not payload["strong_alerts"]:
        lines.append("No strong alerts in the active window.")
    else:
        lines.append("| Score | Instrument | Type | Signals | 5m Px | 15m Px | 5m OI | Vol Ratio |")
        lines.append("|---:|---|---|---|---:|---:|---:|---:|")
        for alert in payload["strong_alerts"][:20]:
            m = alert["metrics"]
            lines.append(
                "| {score} | {inst} | {typ} | {signals} | {p5} | {p15} | {oi5} | {vr} |".format(
                    score=alert["score"],
                    inst=alert["inst_id"],
                    typ=alert["inst_type"],
                    signals=", ".join(alert["signals"]),
                    p5=fmt_pct(m.get("price_change_5m_pct")),
                    p15=fmt_pct(m.get("price_change_15m_pct")),
                    oi5=fmt_pct(m.get("oi_delta_5m_pct")),
                    vr="n/a" if m.get("volume_ratio") is None else f"{float(m['volume_ratio']):.2f}x",
                )
            )
    lines.extend(["", "## Medium Alerts", ""])
    if not payload["medium_alerts"]:
        lines.append("No medium alerts in the active window.")
    else:
        for alert in payload["medium_alerts"][:10]:
            lines.append(f"- {alert['inst_id']} score={alert['score']} signals={', '.join(alert['signals'])}")
    lines.extend(
        [
            "",
            "## Run Stats",
            "",
            "```json",
            json.dumps(payload["run_stats"], indent=2, ensure_ascii=True),
            "```",
            "",
        ]
    )
    return "\n".join(lines)


def local_time_label(ts_ms: int) -> str:
    tz = dt.timezone(dt.timedelta(hours=8))
    return dt.datetime.fromtimestamp(ts_ms / 1000, tz=tz).strftime("%Y-%m-%d %H:%M:%S CST")


def compact_alert_line(alert: dict[str, Any]) -> str:
    metrics = alert.get("metrics", {})
    return (
        f"- {alert.get('severity', '').upper()} {alert.get('inst_id')} "
        f"分数={alert.get('score')} 信号={','.join(alert.get('signals', []))} "
        f"5分钟价格={fmt_pct(metrics.get('price_change_5m_pct'))} "
        f"15分钟价格={fmt_pct(metrics.get('price_change_15m_pct'))} "
        f"5分钟OI={fmt_pct(metrics.get('oi_delta_5m_pct'))} "
        f"资金费率={metrics.get('funding_rate', 'n/a')}"
    )


def build_scan_telegram_message(
    config: dict[str, Any],
    inserted: list[dict[str, Any]],
    run_stats: dict[str, Any],
    now_ms: int,
) -> str:
    max_items = int(config.get("telegram", {}).get("max_alerts_per_message", 5))
    strong = [alert for alert in inserted if alert["severity"] == "strong"]
    medium = [alert for alert in inserted if alert["severity"] == "medium"]
    lines = [
        "OKX 5分钟扫描",
        f"时间：{local_time_label(now_ms)}",
        (
        f"状态：{run_stats.get('status')}；现货={run_stats.get('spot_count')}；"
        f"永续={run_stats.get('swap_count')}；OI={run_stats.get('oi_count')}；"
            f"资金费率更新={run_stats.get('funding_count')}；"
            f"指标更新={run_stats.get('indicator_count')}；新闻情绪={run_stats.get('news_count')}"
        ),
        f"新增信号：{len(inserted)} 条；强信号={len(strong)}；中等信号={len(medium)}",
    ]
    if inserted:
        lines.append("新增异动：")
        for alert in sorted(inserted, key=lambda item: item["score"], reverse=True)[:max_items]:
            lines.append(compact_alert_line(alert))
    else:
        lines.append("本轮没有新的中等/强信号。")
    return "\n".join(lines)


def send_telegram_notifications(
    conn: sqlite3.Connection,
    config: dict[str, Any],
    inserted: list[dict[str, Any]],
    run_stats: dict[str, Any],
    now_ms: int,
) -> None:
    telegram_cfg = config.get("telegram", {})
    if not telegram_cfg.get("enabled", False):
        return
    if telegram_cfg.get("send_scan_result", False):
        send_telegram_message(config, build_scan_telegram_message(config, inserted, run_stats, now_ms))


def prune_old_data(conn: sqlite3.Connection, config: dict[str, Any], now_ms: int) -> None:
    cutoff = now_ms - int(config["retention_days"]) * 24 * 60 * 60_000
    for table in ("snapshots", "oi_snapshots", "funding_snapshots", "alerts", "runs"):
        conn.execute(f"DELETE FROM {table} WHERE ts < ?", (cutoff,))
    for table in ("indicator_snapshots", "news_sentiment_snapshots"):
        conn.execute(f"DELETE FROM {table} WHERE ts < ?", (cutoff,))
    conn.commit()


def run_once(config: dict[str, Any]) -> dict[str, Any]:
    started = utc_now_ms()
    conn = connect_db(config)
    run_stats: dict[str, Any] = {
        "started_at": iso_from_ms(started),
        "spot_count": 0,
        "swap_count": 0,
        "oi_count": 0,
        "funding_count": 0,
        "indicator_count": 0,
        "news_count": 0,
        "alert_count": 0,
        "strong_alert_count": 0,
    }
    try:
        spot, swap, oi = fetch_market_data(config)
        run_stats.update({"spot_count": len(spot), "swap_count": len(swap), "oi_count": len(oi)})
        all_tickers = spot + swap
        save_snapshots(conn, all_tickers, oi)
        funding_count = fetch_and_save_funding(conn, config, swap, started)
        run_stats["funding_count"] = funding_count
        indicator_count = fetch_and_save_indicators(conn, config, swap, started)
        run_stats["indicator_count"] = indicator_count
        news_count = fetch_and_save_news_sentiment(conn, config, started)
        run_stats["news_count"] = news_count

        oi_by_inst = {row["inst_id"]: row for row in oi}
        thresholds = config["thresholds"]
        candidates = []
        for row in all_tickers:
            vol = row.get("volume_usd_24h")
            if row["inst_type"] == "SPOT" and (vol is None or vol < config["markets"]["min_spot_volume_usd_24h"]):
                continue
            if row["inst_type"] == "SWAP" and (vol is None or vol < config["markets"]["min_swap_volume_usd_24h"]):
                continue
            metrics = compute_metrics(conn, row, oi_by_inst, started)
            alert = classify_alert(config, row, metrics)
            if alert:
                candidates.append(alert)

        inserted = insert_alerts(conn, candidates, config)
        strong_inserted = [alert for alert in inserted if alert["severity"] == "strong"]
        run_stats["alert_count"] = len(inserted)
        run_stats["strong_alert_count"] = len(strong_inserted)
        run_stats["duration_ms"] = utc_now_ms() - started
        run_stats["status"] = "ok"
        write_outputs(conn, config, inserted, run_stats)
        send_telegram_notifications(conn, config, inserted, run_stats, started)
        prune_old_data(conn, config, utc_now_ms())
        conn.execute(
            """
            INSERT INTO runs(
              ts, status, spot_count, swap_count, oi_count, alert_count, strong_alert_count,
              indicator_count, news_count, duration_ms
            )
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                started,
                "ok",
                run_stats["spot_count"],
                run_stats["swap_count"],
                run_stats["oi_count"],
                run_stats["alert_count"],
                run_stats["strong_alert_count"],
                run_stats["indicator_count"],
                run_stats["news_count"],
                run_stats["duration_ms"],
            ),
        )
        conn.commit()
        return run_stats
    except Exception as exc:  # noqa: BLE001 - write failure state for automation.
        run_stats["status"] = "error"
        run_stats["error"] = str(exc)
        run_stats["duration_ms"] = utc_now_ms() - started
        conn.execute(
            """
            INSERT INTO runs(ts, status, duration_ms, error)
            VALUES(?, ?, ?, ?)
            """,
            (started, "error", run_stats["duration_ms"], str(exc)),
        )
        conn.commit()
        write_outputs(conn, config, [], run_stats)
        raise
    finally:
        conn.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run OKX anomaly scanner.")
    parser.add_argument("--config", default=str(CONFIG_PATH), help="Path to config.json")
    parser.add_argument("--once", action="store_true", help="Run one scan and exit")
    parser.add_argument("--loop", action="store_true", help="Run forever using scan_interval_seconds")
    parser.add_argument("--telegram-test", action="store_true", help="Send a Telegram test message and exit")
    args = parser.parse_args(argv)

    config = load_config(Path(args.config))
    if args.telegram_test:
        ok = send_telegram_message(config, f"OKX scanner Telegram test\n{local_time_label(utc_now_ms())}")
        print(json.dumps({"telegram_test_sent": ok}, indent=2, ensure_ascii=True))
        return 0 if ok else 1
    if not args.loop:
        args.once = True
    while True:
        stats = run_once(config)
        print(json.dumps(stats, indent=2, ensure_ascii=True))
        if args.once:
            return 0
        sleep_for = max(30, int(config["scan_interval_seconds"]) - int(stats.get("duration_ms", 0) / 1000))
        time.sleep(sleep_for)


if __name__ == "__main__":
    raise SystemExit(main())
