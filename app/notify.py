"""
Shared notification sink — used by the reprice loop (price movers) and the deal
radar (flagged auctions). Sends to Telegram and/or Hermes (iMessage) if
configured; always falls back to stdout so a cron run is never silent.
"""

from __future__ import annotations

import json
import urllib.parse

import requests

from config import (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, HERMES_NOTIFY_URL)


def _telegram(text: str) -> bool:
    if not (TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID):
        return False
    try:
        r = requests.post(
            f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
            data={"chat_id": TELEGRAM_CHAT_ID, "text": text,
                  "parse_mode": "Markdown", "disable_web_page_preview": "false"},
            timeout=10,
        )
        return r.status_code == 200
    except Exception:
        return False


def _hermes(text: str) -> bool:
    if not HERMES_NOTIFY_URL:
        return False
    try:
        r = requests.post(HERMES_NOTIFY_URL, json={"text": text}, timeout=10)
        return r.status_code < 400
    except Exception:
        return False


def send(text: str, *, quiet: bool = False) -> list[str]:
    """Deliver `text`. Returns the channels that accepted it."""
    used = []
    if _telegram(text):
        used.append("telegram")
    if _hermes(text):
        used.append("hermes")
    if not used and not quiet:
        print("[notify]\n" + text)
    return used
