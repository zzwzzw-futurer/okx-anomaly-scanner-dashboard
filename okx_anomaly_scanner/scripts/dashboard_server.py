#!/usr/bin/env python3
"""Read-only dashboard server for the OKX anomaly scanner."""

from __future__ import annotations

import argparse
import datetime as dt
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
from pathlib import Path
import sqlite3
import time
from typing import Any
from urllib.parse import parse_qs, urlparse


BASE_DIR = Path(__file__).resolve().parents[1]
CONFIG_PATH = BASE_DIR / "config.json"
WEB_DIR = BASE_DIR / "web"


def now_ms() -> int:
    return int(time.time() * 1000)


def iso_from_ms(ts_ms: int | float | None) -> str | None:
    if not ts_ms:
        return None
    return dt.datetime.fromtimestamp(float(ts_ms) / 1000, tz=dt.timezone.utc).isoformat()


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def load_jsonl(path: Path, limit: int = 500) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    rows: list[dict[str, Any]] = []
    for line in lines[-limit:]:
        if not line.strip():
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(item, dict):
            rows.append(item)
    rows.sort(key=lambda item: int(item.get("ts", 0) or 0), reverse=True)
    return rows


def load_config() -> dict[str, Any]:
    return load_json(CONFIG_PATH, {})


def path_from_config(config: dict[str, Any], key: str) -> Path:
    return BASE_DIR / config.get("paths", {}).get(key, "")


def sqlite_connect(db_path: Path) -> sqlite3.Connection | None:
    if not db_path.exists():
        return None
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=3)
    except sqlite3.Error:
        return None
    conn.row_factory = sqlite3.Row
    return conn


def decode_row(row: sqlite3.Row) -> dict[str, Any]:
    return {key: row[key] for key in row.keys()}


def decode_alert_row(row: sqlite3.Row) -> dict[str, Any]:
    item = decode_row(row)
    for src, dest in (("signals_json", "signals"), ("metrics_json", "metrics")):
        try:
            item[dest] = json.loads(item.pop(src, "null"))
        except json.JSONDecodeError:
            item[dest] = [] if dest == "signals" else {}
    item["iso_ts"] = iso_from_ms(item.get("ts"))
    return item


def query_all(conn: sqlite3.Connection | None, sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    if conn is None:
        return []
    try:
        return [decode_row(row) for row in conn.execute(sql, params).fetchall()]
    except sqlite3.Error:
        return []


def query_one(conn: sqlite3.Connection | None, sql: str, params: tuple[Any, ...] = ()) -> dict[str, Any] | None:
    if conn is None:
        return None
    try:
        row = conn.execute(sql, params).fetchone()
    except sqlite3.Error:
        return None
    return decode_row(row) if row else None


def query_alerts(conn: sqlite3.Connection | None, limit: int = 250) -> list[dict[str, Any]]:
    if conn is None:
        return []
    try:
        rows = conn.execute(
            """
            SELECT alert_id, ts, inst_id, inst_type, severity, score, direction, signals_json, metrics_json
            FROM alerts
            ORDER BY ts DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    except sqlite3.Error:
        return []
    return [decode_alert_row(row) for row in rows]


def table_count(conn: sqlite3.Connection | None, table: str) -> int:
    if conn is None:
        return 0
    try:
        return int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
    except sqlite3.Error:
        return 0


def table_columns(conn: sqlite3.Connection | None, table: str) -> set[str]:
    if conn is None:
        return set()
    try:
        return {str(row["name"]) for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    except sqlite3.Error:
        return set()


def int_or_none(value: Any) -> int | None:
    try:
        if value in (None, ""):
            return None
        return int(float(value))
    except (TypeError, ValueError):
        return None


def meta_values(conn: sqlite3.Connection | None) -> dict[str, str]:
    if conn is None:
        return {}
    try:
        return {str(row["key"]): str(row["value"]) for row in conn.execute("SELECT key, value FROM meta").fetchall()}
    except sqlite3.Error:
        return {}


def module_status(config: dict[str, Any], latest_run: dict[str, Any] | None, meta: dict[str, str]) -> dict[str, Any]:
    frequencies = config.get("module_frequencies_minutes", {})
    current = now_ms()

    def status_item(key: str, last_ms: int | None) -> dict[str, Any]:
        freq = int(frequencies.get(key) or 0)
        age_minutes = ((current - last_ms) / 60_000) if last_ms else None
        interval_ms = freq * 60_000 if freq else 0
        return {
            "frequency_minutes": freq,
            "last_ms": last_ms,
            "iso_ts": iso_from_ms(last_ms),
            "age_minutes": age_minutes,
            "due": bool(interval_ms and (not last_ms or current - last_ms >= interval_ms)),
            "stale": bool(interval_ms and (not last_ms or current - last_ms > interval_ms * 1.6)),
        }

    latest_run_ms = int_or_none((latest_run or {}).get("ts"))
    return {
        "price_volume": status_item("price_volume", latest_run_ms),
        "open_interest": status_item("open_interest", latest_run_ms),
        "indicators": status_item("indicators", int_or_none(meta.get("last_indicator_scan_ms"))),
        "funding": status_item("funding", int_or_none(meta.get("last_funding_scan_ms"))),
        "news_sentiment": status_item("news_sentiment", int_or_none(meta.get("last_news_sentiment_scan_ms"))),
    }


def event_hourly_buckets(events: list[dict[str, Any]], hours: int = 24) -> list[dict[str, Any]]:
    current = now_ms()
    bucket_ms = 60 * 60_000
    start = current - hours * bucket_ms
    buckets: dict[int, dict[str, Any]] = {}
    for idx in range(hours):
        ts = start + idx * bucket_ms
        buckets[ts] = {"ts": ts, "iso_ts": iso_from_ms(ts), "strong": 0, "medium": 0, "up": 0, "down": 0, "neutral": 0}
    for event in events:
        ts = int(event.get("ts", 0) or 0)
        if ts < start:
            continue
        bucket_ts = start + ((ts - start) // bucket_ms) * bucket_ms
        bucket = buckets.get(bucket_ts)
        if not bucket:
            continue
        severity = event.get("severity")
        direction = event.get("direction") or "neutral"
        if severity in ("strong", "medium"):
            bucket[severity] += 1
        if direction in ("up", "down", "neutral"):
            bucket[direction] += 1
    return [buckets[key] for key in sorted(buckets)]


def summarize_events(events: list[dict[str, Any]]) -> dict[str, Any]:
    cutoff = now_ms() - 60 * 60_000
    recent = [item for item in events if int(item.get("ts", 0) or 0) >= cutoff]
    by_direction = {"up": 0, "down": 0, "neutral": 0}
    for item in recent:
        direction = item.get("direction") or "neutral"
        if direction in by_direction:
            by_direction[direction] += 1
    top_volume = sorted(
        recent,
        key=lambda item: float((item.get("metrics") or {}).get("volume_ratio") or 0),
        reverse=True,
    )[:8]
    top_oi = sorted(
        recent,
        key=lambda item: abs(float((item.get("metrics") or {}).get("oi_delta_5m_pct") or 0)),
        reverse=True,
    )[:8]
    extreme_funding = sorted(
        [item for item in recent if (item.get("metrics") or {}).get("funding_rate") is not None],
        key=lambda item: abs(float((item.get("metrics") or {}).get("funding_rate") or 0)),
        reverse=True,
    )[:8]
    return {
        "last_60m_count": len(recent),
        "last_60m_strong": sum(1 for item in recent if item.get("severity") == "strong"),
        "last_60m_medium": sum(1 for item in recent if item.get("severity") == "medium"),
        "direction_counts": by_direction,
        "top_volume_ratio": top_volume,
        "top_oi_abs_change": top_oi,
        "extreme_funding": extreme_funding,
    }


def latest_market_rows(conn: sqlite3.Connection | None, limit: int = 160) -> list[dict[str, Any]]:
    max_row = query_one(conn, "SELECT MAX(ts) AS max_ts FROM snapshots")
    max_ts = int((max_row or {}).get("max_ts") or 0)
    if not max_ts:
        return []
    rows = query_all(
        conn,
        """
        SELECT ts, inst_id, inst_type, last, open24h, high24h, low24h, volume_usd_24h
        FROM snapshots
        WHERE ts >= ?
        ORDER BY volume_usd_24h DESC
        LIMIT ?
        """,
        (max_ts - 8 * 60_000, limit),
    )
    for row in rows:
        row["iso_ts"] = iso_from_ms(row.get("ts"))
        last = row.get("last")
        open24h = row.get("open24h")
        if last not in (None, 0) and open24h not in (None, 0):
            row["change_24h_pct"] = ((float(last) - float(open24h)) / float(open24h)) * 100
    return rows


def latest_indicator_rows(conn: sqlite3.Connection | None, limit: int = 80) -> list[dict[str, Any]]:
    rows = query_all(
        conn,
        """
        SELECT i.ts, i.inst_id, i.bar, i.close, i.rsi14, i.ema12, i.ema26,
               i.macd, i.macd_signal, i.macd_hist, i.sample_count
        FROM indicator_snapshots i
        JOIN (
          SELECT inst_id, MAX(ts) AS ts
          FROM indicator_snapshots
          GROUP BY inst_id
        ) latest ON latest.inst_id = i.inst_id AND latest.ts = i.ts
        ORDER BY ABS(COALESCE(i.macd_hist, 0)) DESC, ABS(COALESCE(i.rsi14, 50) - 50) DESC
        LIMIT ?
        """,
        (limit,),
    )
    for row in rows:
        row["iso_ts"] = iso_from_ms(row.get("ts"))
    return rows


def latest_funding_rows(conn: sqlite3.Connection | None, limit: int = 80) -> list[dict[str, Any]]:
    rows = query_all(
        conn,
        """
        SELECT f.ts, f.inst_id, f.funding_rate, f.next_funding_rate, f.funding_time
        FROM funding_snapshots f
        JOIN (
          SELECT inst_id, MAX(ts) AS ts
          FROM funding_snapshots
          GROUP BY inst_id
        ) latest ON latest.inst_id = f.inst_id AND latest.ts = f.ts
        ORDER BY ABS(COALESCE(f.funding_rate, 0)) DESC
        LIMIT ?
        """,
        (limit,),
    )
    for row in rows:
        row["iso_ts"] = iso_from_ms(row.get("ts"))
        row["funding_time_iso"] = iso_from_ms(row.get("funding_time"))
    return rows


def latest_news_sentiment_rows(conn: sqlite3.Connection | None, limit: int = 80) -> list[dict[str, Any]]:
    rows = query_all(
        conn,
        """
        SELECT item_id, ts, source, title, link, published_ms, sentiment_score,
               sentiment_label, matched_assets_json
        FROM news_sentiment_snapshots
        ORDER BY COALESCE(published_ms, ts) DESC, ts DESC
        LIMIT ?
        """,
        (limit,),
    )
    for row in rows:
        row["iso_ts"] = iso_from_ms(row.get("ts"))
        row["published_iso"] = iso_from_ms(row.get("published_ms"))
        try:
            row["matched_assets"] = json.loads(row.pop("matched_assets_json", "[]"))
        except json.JSONDecodeError:
            row["matched_assets"] = []
    return rows


def series_for_instruments(conn: sqlite3.Connection | None, inst_ids: list[str], hours: int = 24) -> dict[str, Any]:
    if conn is None:
        return {}
    out: dict[str, Any] = {}
    cutoff = now_ms() - hours * 60 * 60_000
    for inst_id in inst_ids:
        if not inst_id:
            continue
        price_rows = query_all(
            conn,
            """
            SELECT ts, last, volume_usd_24h
            FROM snapshots
            WHERE inst_id = ? AND ts >= ?
            ORDER BY ts ASC
            """,
            (inst_id, cutoff),
        )
        oi_rows = query_all(
            conn,
            """
            SELECT ts, oi_usd
            FROM oi_snapshots
            WHERE inst_id = ? AND ts >= ?
            ORDER BY ts ASC
            """,
            (inst_id, cutoff),
        )
        funding_rows = query_all(
            conn,
            """
            SELECT ts, funding_rate, funding_time
            FROM funding_snapshots
            WHERE inst_id = ? AND ts >= ?
            ORDER BY ts ASC
            """,
            (inst_id, cutoff),
        )
        out[inst_id] = {
            "price": price_rows[-288:],
            "oi": oi_rows[-288:],
            "funding": funding_rows[-96:],
        }
    return out


def build_dashboard_payload() -> dict[str, Any]:
    config = load_config()
    alerts_path = path_from_config(config, "alerts_json")
    events_path = path_from_config(config, "events_jsonl")
    db_path = path_from_config(config, "database")
    alerts_json = load_json(alerts_path, {})
    events = load_jsonl(events_path, limit=2000)
    conn = sqlite_connect(db_path)
    try:
        run_columns = table_columns(conn, "runs")
        indicator_count_expr = "indicator_count" if "indicator_count" in run_columns else "0 AS indicator_count"
        news_count_expr = "news_count" if "news_count" in run_columns else "0 AS news_count"
        alert_history = query_alerts(conn, 250)
        latest_run = query_one(
            conn,
            f"""
            SELECT id, ts, status, spot_count, swap_count, oi_count, alert_count,
                   strong_alert_count, {indicator_count_expr}, {news_count_expr}, duration_ms, error
            FROM runs
            ORDER BY ts DESC
            LIMIT 1
            """,
        )
        runs = query_all(
            conn,
            f"""
            SELECT id, ts, status, spot_count, swap_count, oi_count, alert_count,
                   strong_alert_count, {indicator_count_expr}, {news_count_expr}, duration_ms, error
            FROM runs
            ORDER BY ts DESC
            LIMIT 60
            """,
        )
        for row in runs:
            row["iso_ts"] = iso_from_ms(row.get("ts"))
        if latest_run:
            latest_run["iso_ts"] = iso_from_ms(latest_run.get("ts"))
        top_market = latest_market_rows(conn)
        current_alerts = (alerts_json.get("strong_alerts") or []) + (alerts_json.get("medium_alerts") or [])
        candidates = []
        for item in current_alerts + alert_history:
            inst_id = item.get("inst_id")
            if inst_id and inst_id not in candidates:
                candidates.append(inst_id)
        series = series_for_instruments(conn, candidates[:16])
        meta = meta_values(conn)
        module_statuses = module_status(config, latest_run, meta)
        indicators = latest_indicator_rows(conn)
        funding_overview = latest_funding_rows(conn)
        news_sentiment = latest_news_sentiment_rows(conn)
        db_stats = {
            "runs": table_count(conn, "runs"),
            "snapshots": table_count(conn, "snapshots"),
            "oi_snapshots": table_count(conn, "oi_snapshots"),
            "funding_snapshots": table_count(conn, "funding_snapshots"),
            "indicator_snapshots": table_count(conn, "indicator_snapshots"),
            "news_sentiment_snapshots": table_count(conn, "news_sentiment_snapshots"),
            "alerts": table_count(conn, "alerts"),
        }
    finally:
        if conn is not None:
            conn.close()

    latest_report = path_from_config(config, "latest_report").read_text(encoding="utf-8", errors="replace") if path_from_config(config, "latest_report").exists() else ""
    telegram_status = load_json(BASE_DIR / "data" / "telegram_status.json", {})
    telegram_codex_status = load_json(BASE_DIR / "data" / "telegram_codex_status.json", {})
    codex_state = load_json(path_from_config(config, "codex_seen_alerts"), {})
    hyperliquid_testnet_state = load_json(BASE_DIR / "data" / "hyperliquid_testnet_state.json", {})
    hyperliquid_testnet_events = load_jsonl(BASE_DIR / "data" / "hyperliquid_testnet_events.jsonl", limit=120)
    entry_events = [
        item
        for item in hyperliquid_testnet_events
        if item.get("event") in ("entry_submitted", "exit_submitted")
    ]

    return {
        "generated_at_ms": now_ms(),
        "generated_at": iso_from_ms(now_ms()),
        "base_dir": str(BASE_DIR),
        "trading_executed": bool(entry_events),
        "config": {
            "scan_interval_seconds": config.get("scan_interval_seconds"),
            "retention_days": config.get("retention_days"),
            "markets": config.get("markets", {}),
            "module_frequencies_minutes": config.get("module_frequencies_minutes", {}),
            "thresholds": config.get("thresholds", {}),
            "strategy": config.get("strategy", {}),
            "execution": config.get("execution", {}),
            "telegram": {
                "enabled": bool((config.get("telegram") or {}).get("enabled")),
                "send_scan_result": bool((config.get("telegram") or {}).get("send_scan_result")),
                "send_hourly_summary": bool((config.get("telegram") or {}).get("send_hourly_summary")),
                "send_codex_strategy": bool((config.get("telegram") or {}).get("send_codex_strategy")),
            },
        },
        "latest_alerts": alerts_json,
        "events": events[:500],
        "event_summary": summarize_events(events),
        "hourly_buckets": event_hourly_buckets(events, 24),
        "alert_history": alert_history,
        "latest_market": top_market,
        "indicators": indicators,
        "funding_overview": funding_overview,
        "news_sentiment": news_sentiment,
        "module_status": module_statuses,
        "hyperliquid_testnet": {
            "state": hyperliquid_testnet_state,
            "events": hyperliquid_testnet_events[:80],
        },
        "series": series,
        "runs": runs,
        "latest_run": latest_run,
        "db_stats": db_stats,
        "status": {
            "telegram_scan": telegram_status,
            "telegram_codex": telegram_codex_status,
            "codex_seen": {
                "updated_at": codex_state.get("updated_at"),
                "seen_count": len(codex_state.get("seen_alert_ids", [])),
                "last_hourly_summary_ms": codex_state.get("last_hourly_summary_ms"),
                "last_hourly_summary_iso": iso_from_ms(codex_state.get("last_hourly_summary_ms")),
            },
        },
        "latest_report": latest_report,
    }


class DashboardHandler(SimpleHTTPRequestHandler):
    server_version = "OKXDashboard/1.0"

    def send_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_cors_headers()
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def do_HEAD(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/dashboard":
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_cors_headers()
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return
        target = WEB_DIR / "index.html" if parsed.path in ("", "/") else (WEB_DIR / parsed.path.lstrip("/")).resolve()
        if not target.exists() or not target.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        content_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(target.stat().st_size))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/dashboard":
            self.send_json(build_dashboard_payload())
            return
        if parsed.path == "/api/instrument":
            query = parse_qs(parsed.query)
            inst_id = (query.get("inst_id") or [""])[0]
            config = load_config()
            conn = sqlite_connect(path_from_config(config, "database"))
            try:
                payload = {"inst_id": inst_id, "series": series_for_instruments(conn, [inst_id]).get(inst_id, {})}
            finally:
                if conn is not None:
                    conn.close()
            self.send_json(payload)
            return
        if parsed.path in ("", "/"):
            self.serve_file(WEB_DIR / "index.html")
            return
        target = (WEB_DIR / parsed.path.lstrip("/")).resolve()
        if WEB_DIR.resolve() not in target.parents and target != WEB_DIR.resolve():
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        self.serve_file(target)

    def serve_file(self, path: Path) -> None:
        if not path.exists() or not path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        content_type = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        data = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, payload: Any) -> None:
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_cors_headers()
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format: str, *args: Any) -> None:
        return


def main() -> int:
    global CONFIG_PATH
    parser = argparse.ArgumentParser(description="Serve the OKX anomaly scanner dashboard.")
    parser.add_argument("--config", default=str(CONFIG_PATH), help="Path to config.json")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()
    CONFIG_PATH = Path(args.config)
    server = ThreadingHTTPServer((args.host, args.port), DashboardHandler)
    print(f"OKX dashboard: http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
