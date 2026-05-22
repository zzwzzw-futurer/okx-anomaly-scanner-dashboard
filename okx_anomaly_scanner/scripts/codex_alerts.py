#!/usr/bin/env python3
"""Helpers for Codex automations that read scanner outputs."""

from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path
import sys
import time
from typing import Any


BASE_DIR = Path(__file__).resolve().parents[1]
CONFIG_PATH = BASE_DIR / "config.json"


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return default


def load_config() -> dict[str, Any]:
    return load_json(CONFIG_PATH, {})


def path_from_config(config: dict[str, Any], key: str) -> Path:
    return BASE_DIR / config["paths"][key]


def iso_from_ms(ts_ms: int) -> str:
    return dt.datetime.fromtimestamp(ts_ms / 1000, tz=dt.timezone.utc).isoformat()


def read_seen(path: Path) -> set[str]:
    payload = load_json(path, {"seen_alert_ids": []})
    return set(payload.get("seen_alert_ids", []))


def read_state(path: Path) -> dict[str, Any]:
    payload = load_json(path, {})
    return {
        "seen_alert_ids": list(payload.get("seen_alert_ids", [])),
        "last_hourly_summary_ms": int(payload.get("last_hourly_summary_ms", 0) or 0),
    }


def write_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "updated_at": iso_from_ms(int(time.time() * 1000)),
        "seen_alert_ids": sorted(set(state.get("seen_alert_ids", []))),
        "last_hourly_summary_ms": int(state.get("last_hourly_summary_ms", 0) or 0),
    }
    path.write_text(json.dumps(payload, ensure_ascii=True, indent=2), encoding="utf-8")


def write_seen(path: Path, seen: set[str]) -> None:
    state = read_state(path)
    state["seen_alert_ids"] = sorted(seen)
    write_state(path, state)


STRONG_ALERT_ANALYSIS_LAYERS = [
    "SPOT/SWAP tickers, price change, and volume",
    "SWAP open-interest change",
    "K-line indicators: RSI, MACD, and EMA",
    "Funding rate",
    "News and sentiment",
]


def strong_unseen(mark_seen: bool) -> int:
    config = load_config()
    alerts_path = path_from_config(config, "alerts_json")
    seen_path = path_from_config(config, "codex_seen_alerts")
    alerts = load_json(alerts_path, {})
    seen = read_seen(seen_path)
    strong = alerts.get("strong_alerts", [])
    unseen = [item for item in strong if item.get("alert_id") not in seen]
    result = {
        "mode": "strong",
        "has_unseen_strong_alerts": bool(unseen),
        "unseen_count": len(unseen),
        "generated_at": alerts.get("generated_at"),
        "alerts": unseen,
        "alerts_path": str(alerts_path),
        "report_path": str(path_from_config(config, "latest_report")),
        "analysis_layers": STRONG_ALERT_ANALYSIS_LAYERS,
        "instruction": (
            "If alerts is non-empty, analyze immediately using every analysis layer. "
            "Keep it concise and concrete. Do not execute trades. Give scenarios, "
            "invalidation, stop, take-profit, sizing, risk controls, and demo-first strategy ideas."
        ),
    }
    print(json.dumps(result, ensure_ascii=True, indent=2))
    if mark_seen and unseen:
        seen.update(item["alert_id"] for item in unseen if item.get("alert_id"))
        write_seen(seen_path, seen)
    return 0


def hourly_summary(minutes: int) -> int:
    config = load_config()
    result = build_hourly_summary(config, minutes)
    print(json.dumps(result, ensure_ascii=True, indent=2))
    return 0


def build_hourly_summary(config: dict[str, Any], minutes: int) -> dict[str, Any]:
    events_path = path_from_config(config, "events_jsonl")
    cutoff_ms = int(time.time() * 1000) - minutes * 60_000
    events: list[dict[str, Any]] = []
    if events_path.exists():
        with events_path.open("r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if int(item.get("ts", 0)) >= cutoff_ms:
                    events.append(item)
    events.sort(key=lambda item: (item.get("score", 0), item.get("ts", 0)), reverse=True)
    return {
        "mode": "hourly",
        "window_minutes": minutes,
        "event_count": len(events),
        "strong_count": sum(1 for item in events if item.get("severity") == "strong"),
        "medium_count": sum(1 for item in events if item.get("severity") == "medium"),
        "top_events": events[:20],
        "events_path": str(events_path),
        "report_path": str(path_from_config(config, "latest_report")),
        "instruction": "Summarize recent events. Do not execute trades.",
    }


def heartbeat(mark: bool) -> int:
    config = load_config()
    alerts_path = path_from_config(config, "alerts_json")
    state_path = path_from_config(config, "codex_seen_alerts")
    state = read_state(state_path)
    seen = set(state.get("seen_alert_ids", []))
    alerts = load_json(alerts_path, {})
    strong = alerts.get("strong_alerts", [])
    unseen = [item for item in strong if item.get("alert_id") not in seen]

    result = {
        "mode": "heartbeat",
        "has_work": bool(unseen),
        "has_unseen_strong_alerts": bool(unseen),
        "unseen_strong_count": len(unseen),
        "hourly_due": False,
        "alerts_generated_at": alerts.get("generated_at"),
        "strong_alerts": unseen,
        "hourly_summary": None,
        "alerts_path": str(alerts_path),
        "report_path": str(path_from_config(config, "latest_report")),
        "state_path": str(state_path),
        "analysis_layers": STRONG_ALERT_ANALYSIS_LAYERS,
        "instruction": (
            "If has_unseen_strong_alerts is true, report immediately. Base the concise strategy analysis on all "
            "five layers: SPOT/SWAP tickers price/volume, SWAP OI change, RSI/MACD/EMA, funding rate, "
            "and news/sentiment. Provide concrete demo-first strategy ideas with entry scenarios, invalidation, "
            "stop, take-profit, sizing/risk notes, and risks. Do not execute trades."
        ),
    }
    print(json.dumps(result, ensure_ascii=True, indent=2))

    if mark:
        if unseen:
            seen.update(item["alert_id"] for item in unseen if item.get("alert_id"))
            state["seen_alert_ids"] = sorted(seen)
        write_state(state_path, state)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read Codex-facing scanner alerts.")
    sub = parser.add_subparsers(dest="command", required=True)
    strong = sub.add_parser("strong", help="Print unseen strong alerts")
    strong.add_argument("--mark-seen", action="store_true", help="Mark printed alerts as seen")
    hourly = sub.add_parser("hourly", help="Print recent event summary")
    hourly.add_argument("--minutes", type=int, default=60)
    beat = sub.add_parser("heartbeat", help="Print strong-alert work for Codex")
    beat.add_argument("--mark", action="store_true", help="Mark printed strong alerts as handled")
    args = parser.parse_args(argv)
    if args.command == "strong":
        return strong_unseen(args.mark_seen)
    if args.command == "hourly":
        return hourly_summary(args.minutes)
    if args.command == "heartbeat":
        return heartbeat(args.mark)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
