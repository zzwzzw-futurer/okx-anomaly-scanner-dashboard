#!/usr/bin/env python3
"""Send Codex-generated analysis to Telegram using local scanner credentials."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
from pathlib import Path
import sys
import time
from typing import Any
import urllib.parse
import urllib.request


BASE_DIR = Path(__file__).resolve().parents[1]
CONFIG_PATH = BASE_DIR / "config.json"
TELEGRAM_BASE_URL = "https://api.telegram.org"
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X) Codex OKX Telegram notifier"


def utc_now_ms() -> int:
    return int(time.time() * 1000)


def iso_from_ms(ts_ms: int) -> str:
    return dt.datetime.fromtimestamp(ts_ms / 1000, tz=dt.timezone.utc).isoformat()


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return default


def resolve_local_path(path_value: str | None) -> Path | None:
    if not path_value:
        return None
    path = Path(path_value).expanduser()
    return path if path.is_absolute() else BASE_DIR / path


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
    env_file = resolve_local_path(config.get("telegram", {}).get("env_file"))
    file_values = load_env_file(env_file)
    token = os.environ.get("TELEGRAM_BOT_TOKEN") or file_values.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID") or file_values.get("TELEGRAM_CHAT_ID")
    if token and ("replace_with" in token or token.startswith("123456789:")):
        token = None
    if chat_id and ("replace_with" in chat_id or chat_id == "123456789"):
        chat_id = None
    return token, chat_id


def write_status(status: str, detail: str) -> None:
    status_path = BASE_DIR / "data" / "telegram_codex_status.json"
    status_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "ts": utc_now_ms(),
        "iso_ts": iso_from_ms(utc_now_ms()),
        "status": status,
        "detail": detail,
    }
    status_path.write_text(json.dumps(payload, ensure_ascii=True, indent=2), encoding="utf-8")


def chunk_text(text: str, size: int = 3600) -> list[str]:
    text = text.strip()
    if len(text) <= size:
        return [text]
    chunks: list[str] = []
    remaining = text
    while remaining:
        if len(remaining) <= size:
            chunks.append(remaining)
            break
        split_at = remaining.rfind("\n", 0, size)
        if split_at < size // 2:
            split_at = size
        chunks.append(remaining[:split_at].strip())
        remaining = remaining[split_at:].strip()
    return chunks


def send_message(config: dict[str, Any], text: str) -> bool:
    if not config.get("telegram", {}).get("enabled", False):
        write_status("disabled", "telegram.enabled is false")
        return False
    token, chat_id = telegram_credentials(config)
    if not token or not chat_id:
        write_status(
            "missing_credentials",
            "Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in /Users/2f/.codex/okx_anomaly_scanner/telegram.env",
        )
        return False
    chunks = chunk_text(text)
    for index, chunk in enumerate(chunks, start=1):
        body = chunk
        if len(chunks) > 1:
            body = f"Part {index}/{len(chunks)}\n{chunk}"
        payload = urllib.parse.urlencode(
            {
                "chat_id": chat_id,
                "text": body,
                "disable_web_page_preview": "true",
            }
        ).encode("utf-8")
        request = urllib.request.Request(
            f"{TELEGRAM_BASE_URL}/bot{token}/sendMessage",
            data=payload,
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": USER_AGENT,
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                result = json.loads(response.read().decode("utf-8"))
            if result.get("ok") is not True:
                write_status("error", json.dumps(result, ensure_ascii=True))
                return False
        except Exception as exc:  # noqa: BLE001 - keep notifier simple.
            write_status("error", str(exc))
            return False
    write_status("sent", f"delivered {len(chunks)} message(s)")
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Send a Telegram notification.")
    parser.add_argument("--title", default="", help="Optional title prepended to the message")
    parser.add_argument("--text", default="", help="Message text. If omitted, stdin is used.")
    args = parser.parse_args(argv)

    config = load_json(CONFIG_PATH, {})
    text = args.text if args.text else sys.stdin.read()
    text = text.strip()
    if args.title:
        text = f"{args.title.strip()}\n{text}"
    if not text:
        print(json.dumps({"sent": False, "reason": "empty_message"}, ensure_ascii=True, indent=2))
        return 1
    sent = send_message(config, text)
    print(json.dumps({"sent": sent}, ensure_ascii=True, indent=2))
    return 0 if sent else 1


if __name__ == "__main__":
    raise SystemExit(main())
