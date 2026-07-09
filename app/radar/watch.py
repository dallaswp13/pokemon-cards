"""
eBay Browse API watchlist — the free, official, reliable alternative to scraping.

Instead of a firehose of every auction ending soon, this watches *your specific
cards*: it takes the high-value singles the channel router sends to eBay, queries
the Browse API for live AUCTIONS of each, and scores them with the same flip/
collect engine. No proxy, no scraping, no per-result cost — just the free API
(5,000 calls/day). Tradeoff: Browse can't sort by end-time, so this is a per-card
watch (set a Gixen snipe when a good one shows up), not an "everything closing
now" stream.

Needs a free eBay developer app → EBAY_CLIENT_ID / EBAY_CLIENT_SECRET in .env.
Production Buy-API access may require eBay approval; if search 403s, request
"Buy APIs" access on your developer account.
"""

from __future__ import annotations

import base64
import time
from datetime import datetime, timezone

import requests

import config

_TOKEN: dict = {}


def _app_token() -> str:
    if not (config.EBAY_CLIENT_ID and config.EBAY_CLIENT_SECRET):
        raise RuntimeError(
            "eBay Browse API needs credentials — register a free app at "
            "developer.ebay.com and set EBAY_CLIENT_ID / EBAY_CLIENT_SECRET in .env")
    now = time.time()
    if _TOKEN.get("exp", 0) > now + 60:
        return _TOKEN["tok"]
    creds = base64.b64encode(
        f"{config.EBAY_CLIENT_ID}:{config.EBAY_CLIENT_SECRET}".encode()).decode()
    r = requests.post(
        "https://api.ebay.com/identity/v1/oauth2/token",
        headers={"Authorization": f"Basic {creds}",
                 "Content-Type": "application/x-www-form-urlencoded"},
        data={"grant_type": "client_credentials",
              "scope": "https://api.ebay.com/oauth/api_scope"}, timeout=20)
    r.raise_for_status()
    d = r.json()
    _TOKEN.update(tok=d["access_token"], exp=now + int(d.get("expires_in", 7200)))
    return _TOKEN["tok"]


def _minutes_left(iso: str | None) -> float | None:
    if not iso:
        return None
    try:
        end = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        return max(0.0, (end - datetime.now(timezone.utc)).total_seconds() / 60)
    except Exception:
        return None


def _shipping(item: dict) -> float:
    opts = item.get("shippingOptions") or []
    if opts:
        try:
            return float((opts[0].get("shippingCost") or {}).get("value", 0) or 0)
        except (ValueError, TypeError):
            return 0.0
    return 0.0


def search_card(name: str, number: str, limit: int = 10) -> list[dict]:
    """Live AUCTION listings for one card via Browse API, in the listing schema."""
    tok = _app_token()
    q = " ".join(x for x in (name, number.split("/")[0]) if x).strip()
    r = requests.get(
        "https://api.ebay.com/buy/browse/v1/item_summary/search",
        headers={"Authorization": f"Bearer {tok}",
                 "X-EBAY-C-MARKETPLACE-ID": "EBAY_US"},
        params={"q": q, "category_ids": config.EBAY_POKEMON_CATEGORY,
                "filter": "buyingOptions:{AUCTION}", "limit": str(limit)},
        timeout=20)
    if r.status_code != 200:
        return []
    out = []
    for it in r.json().get("itemSummaries", []) or []:
        price = it.get("currentBidPrice") or it.get("price") or {}
        seller = it.get("seller") or {}
        out.append({
            "title": it.get("title", ""),
            "url": it.get("itemWebUrl"),
            "current_bid": float(price.get("value", 0) or 0),
            "bid_count": it.get("bidCount"),
            "end_time": it.get("itemEndDate"),
            "minutes_left": _minutes_left(it.get("itemEndDate")),
            "shipping": _shipping(it),
            "image_url": (it.get("image") or {}).get("imageUrl"),
            "condition": it.get("condition", ""),
            "is_auction": "AUCTION" in (it.get("buyingOptions") or []),
            "language": "English",
            "seller_feedback_pct": _num(seller.get("feedbackPercentage")),
            "seller_feedback_count": _num(seller.get("feedbackScore")),
            "card_name": name, "card_number": number,   # exact identity → precise comp
        })
    return out


def build_watchlist(export_path: str, top_n: int = 30) -> list[tuple[str, str]]:
    """The eBay-auction-routed singles, highest value first (dedup by name+number)."""
    import channels
    from matcher import load_export
    singles, *_ = load_export(export_path)
    ebay = [r for r in (channels.route_row(i) for i in singles)
            if r.channel.startswith("eBay")]
    ebay.sort(key=lambda r: -r.total_value)
    seen, wl = set(), []
    for r in ebay:
        key = (r.inv.product_name.lower(), r.inv.card_number)
        if key in seen:
            continue
        seen.add(key)
        wl.append((r.inv.product_name, r.inv.card_number))
        if len(wl) >= top_n:
            break
    return wl


class WatchSource:
    def __init__(self, export_path: str, top_n: int = 30, per_card: int = 10):
        self.export_path = export_path
        self.top_n = top_n
        self.per_card = per_card

    def fetch(self) -> list[dict]:
        listings = []
        for name, number in build_watchlist(self.export_path, self.top_n):
            listings.extend(search_card(name, number, self.per_card))
        return listings


def _num(v):
    try:
        return float(v)
    except (ValueError, TypeError):
        return None
