"""
Auction data sources for the radar. All return a list of listing dicts:

    {item_id, title, url, current_bid, bid_count, minutes_left, end_time,
     shipping, image_url, seller_feedback_pct, seller_feedback_count,
     is_auction, condition, graded, grade, language, photos_count,
     card_name, set_name, card_number}   # identity fields optional

Verified feasibility ranking for the ending-soonest firehose:
  1. Apify scrapeworks/ebay-search-scraper — preserves eBay's native
     _sop=1 sort, ~$1/1k results, no monthly fee. (This module's ApifySource.)
  2. eBay Browse API — free but CANNOT sort by end-time (watchlist only).
  3. DIY HTML scrape — free but anti-bot 403s; brittle. (HtmlSource; best-effort.)
"""

from __future__ import annotations

import json
from pathlib import Path

import requests

import config


class FixtureSource:
    """Load listings from a JSON file — for tests and offline development."""

    def __init__(self, path: str):
        self.path = path

    def fetch(self) -> list[dict]:
        return json.loads(Path(self.path).read_text())


class ApifySource:
    """
    Run the configured eBay search actor synchronously and return its dataset.

    Default input matches automation-lab/ebay-scraper's verified schema
    (keyword-based: searchQueries + sort=ending_soonest + listingType=auction).
    If you switch to a URL-based actor (e.g. delicious_zebu/…), override
    `_build_input` to pass `listingUrls: [config.EBAY_SEARCH_URL]` so the exact
    Pokémon category + ending-soonest sort is preserved. Output field names also
    vary by actor — `_normalize_apify` is a best-guess mapper; adjust after a
    successful run reveals the real keys.
    """

    def __init__(self, max_items: int = 60):
        self.max_items = max_items

    def _build_input(self) -> dict:
        return {"searchQueries": [config.APIFY_SEARCH_QUERY],
                "sort": "ending_soonest",
                "listingType": "auction",
                "maxProductsPerSearch": self.max_items,
                "maxSearchPages": 1}

    def fetch(self) -> list[dict]:
        if not config.APIFY_TOKEN:
            raise RuntimeError("APIFY_TOKEN not set — add it to .env (see .env.example)")
        actor = config.APIFY_SEARCH_ACTOR.replace("/", "~")
        url = (f"https://api.apify.com/v2/acts/{actor}/run-sync-get-dataset-items"
               f"?token={config.APIFY_TOKEN}")
        r = requests.post(url, json=self._build_input(), timeout=180)
        r.raise_for_status()
        return [_normalize_apify(item) for item in r.json()]


class HtmlSource:
    """
    Best-effort $0 fallback: fetch the public search HTML directly. eBay serves
    listing data server-rendered, but anti-bot frequently returns 403 to plain
    requests — treat empty results as "blocked, use Apify or headless Chrome".
    """

    def __init__(self, search_url: str = None):
        self.search_url = search_url or config.EBAY_SEARCH_URL

    def fetch(self) -> list[dict]:
        import re
        headers = {"User-Agent": ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                                  "Chrome/124.0 Safari/537.36")}
        try:
            r = requests.get(self.search_url, headers=headers, timeout=20)
        except Exception:
            return []
        if r.status_code != 200 or "s-item__title" not in r.text:
            return []  # blocked or layout changed
        out = []
        for block in re.findall(r'<li class="s-item.*?</li>', r.text, re.S)[:60]:
            title = _first(re.findall(r's-item__title[^>]*>(?:<span[^>]*>)?([^<]{6,})', block))
            price = _first(re.findall(r'\$([\d,]+\.\d{2})', block))
            url = _first(re.findall(r'href="(https://www\.ebay\.com/itm/[^"]+)"', block))
            if not title:
                continue
            out.append({"title": title, "url": url, "is_auction": True,
                        "current_bid": float(price.replace(",", "")) if price else 0.0})
        return out


def _first(xs):
    return xs[0] if xs else None


def _normalize_apify(item: dict) -> dict:
    """Map common Apify eBay-scraper field names to our listing schema."""
    def g(*keys, default=None):
        for k in keys:
            if k in item and item[k] not in (None, ""):
                return item[k]
        return default
    return {
        "item_id": g("id", "itemId", "epid"),
        "title": g("title", "name", default=""),
        "url": g("url", "itemUrl", "link"),
        "current_bid": _num(g("price", "currentBid", "currentPrice", "bidPrice")),
        "bid_count": _num(g("bids", "bidCount")),
        "minutes_left": _num(g("minutesLeft", "timeLeftMinutes")),
        "end_time": g("endTime", "endDate"),
        "shipping": _num(g("shipping", "shippingPrice", default=0)),
        "image_url": g("image", "imageUrl", "thumbnail"),
        "seller_feedback_pct": _num(g("sellerFeedbackPercent", "feedbackPercent")),
        "seller_feedback_count": _num(g("sellerFeedbackScore", "feedbackScore")),
        "is_auction": True,
        "condition": g("condition", default=""),
        "graded": bool(g("graded", default=False)),
        "grade": g("grade"),
        "language": g("language", default="English"),
        "photos_count": _num(g("imageCount", "photosCount")),
    }


def _num(v):
    if v is None:
        return None
    try:
        return float(str(v).replace("$", "").replace(",", "").split()[0])
    except (ValueError, IndexError):
        return None


def get_source(kind: str, fixture: str = ""):
    if kind == "fixture":
        return FixtureSource(fixture or str(Path(__file__).parent / "fixtures" / "example.json"))
    if kind == "apify":
        return ApifySource()
    if kind == "html":
        return HtmlSource()
    raise ValueError(f"unknown source '{kind}'")
