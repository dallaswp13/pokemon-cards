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
    Run the configured eBay search actor and normalize to the listing schema.

    Default (verified working 2026-07-08): delicious_zebu/ebay-product-listing-
    scraper — feeds the exact Pokémon category URL via `listingUrls` with
    `sortBy=1` (ending soonest) + `buyingFormat=LH_Auction`. If the actor name
    contains "ebay-scraper" we build the keyword-based automation-lab input
    instead. `_normalize_apify` handles both actors' output shapes.

    Note: the feed is leaky (returns some Yu-Gi-Oh!/MTG despite the Pokémon
    category URL) and carries no per-item end time — but the ending-soonest sort
    means page 1 IS the soonest-closing auctions, and non-Pokémon get filtered
    downstream (no pokemontcg.io comp → rejected, plus an explicit game gate).
    """

    def __init__(self, max_pages: int = 1):
        self.max_pages = max_pages

    def _build_input(self) -> dict:
        if "ebay-scraper" in config.APIFY_SEARCH_ACTOR:      # keyword-based alternate
            return {"searchQueries": [config.APIFY_SEARCH_QUERY],
                    "sort": "ending_soonest", "listingType": "auction",
                    "maxProductsPerSearch": 60, "maxSearchPages": self.max_pages}
        return {"listingUrls": [config.EBAY_SEARCH_URL], "maxPages": self.max_pages,
                "sortBy": "1", "buyingFormat": "LH_Auction"}

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


_GRADED_RE = __import__("re").compile(r"\b(psa|bgs|cgc|sgc)\s*(10|9\.5|9|8|7|6)\b",
                                      __import__("re").IGNORECASE)


def _bids_from_attr(attrs) -> float | None:
    import re
    for a in attrs or []:
        m = re.search(r"(\d+)\s+bids?", str(a), re.IGNORECASE)
        if m:
            return float(m.group(1))
    return None


def _normalize_apify(item: dict) -> dict:
    """Map an Apify eBay-scraper item to our listing schema (handles both actors)."""
    if "product_title" in item:                              # delicious_zebu schema
        title = item.get("product_title", "") or ""
        gm = _GRADED_RE.search(title)
        return {
            "title": title,
            "url": item.get("product_url"),
            "current_bid": _num(item.get("price")),          # auction current bid
            "shipping": _num(item.get("shipping_cost")) or 0.0,
            "bid_count": _bids_from_attr(item.get("card_attribute")),
            "image_url": item.get("image_url"),
            "condition": item.get("condition", ""),
            "graded": bool(gm),
            "grade": (gm.group(0) if gm else None),
            "is_auction": True,
            "language": "English",
            # this actor exposes no seller-feedback %, photo count, or end time →
            # leave None so those gates safely skip (sort guarantees ending-soonest).
        }

    def g(*keys, default=None):                              # generic (automation-lab etc.)
        for k in keys:
            if k in item and item[k] not in (None, ""):
                return item[k]
        return default
    title = g("title", "name", default="")
    gm = _GRADED_RE.search(title)
    return {
        "item_id": g("id", "itemId", "epid"),
        "title": title,
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
        "graded": bool(g("graded", default=False)) or bool(gm),
        "grade": g("grade") or (gm.group(0) if gm else None),
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
