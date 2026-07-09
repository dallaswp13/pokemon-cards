"""
Pricing providers — fresh market prices for repricing (A), reference prices for
the deal radar (C), and revaluation.

Providers (verified 2026):
  • pokemontcg.io  — FREE TCGplayer 'market' price for Pokemon raw singles.
                     Works keyless (~1k/day); a free key raises it to ~20k/day.
                     Pokemon-only, raw-only (no graded).
  • PriceCharting  — keyed (~$5/mo). Covers raw + graded Pokemon + sealed +
                     MTG/YGO. The graded-value backbone for the ~50 eBay cards.

TCGplayer has NO first-party API for new devs in 2026 (closed), so we get its
prices indirectly via pokemontcg.io.

All lookups are disk-cached with a TTL so a full-inventory reprice doesn't
re-hit the network for cards priced earlier the same day.
"""

from __future__ import annotations

import json
import re
import time
import urllib.parse
from typing import Optional

import requests

from config import DATA_DIR, POKEMONTCG_API_KEY, PRICECHARTING_TOKEN

CACHE_PATH = DATA_DIR / "price_cache.json"
CACHE_TTL_SECONDS = 12 * 3600      # prices are intraday-stable enough for a daily reprice
USER_AGENT = "SourceOfTruth-SellOps/1.0 (local; dallas)"

_CACHE: dict[str, dict] = {}


def _load_cache() -> None:
    global _CACHE
    if not _CACHE and CACHE_PATH.exists():
        try:
            _CACHE = json.loads(CACHE_PATH.read_text())
        except Exception:
            _CACHE = {}


def _save_cache() -> None:
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    CACHE_PATH.write_text(json.dumps(_CACHE))


def _cache_get(key: str) -> Optional[dict]:
    _load_cache()
    entry = _CACHE.get(key)
    if entry and (time.time() - entry.get("_ts", 0)) < CACHE_TTL_SECONDS:
        return entry["value"]
    return None


def _cache_put(key: str, value: dict | None) -> None:
    _CACHE[key] = {"_ts": time.time(), "value": value}
    _save_cache()


def _get_json(url: str, headers: dict | None = None, timeout: float = 12.0) -> Optional[dict]:
    h = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    if headers:
        h.update(headers)
    try:
        r = requests.get(url, headers=h, timeout=timeout)
        if r.status_code != 200:
            return None
        return r.json()
    except Exception:
        return None


# ---------------------------------------------------------------------------
# pokemontcg.io — free TCGplayer market price
# ---------------------------------------------------------------------------

def _bare_name(name: str) -> str:
    """'Charizard ex - 199/165' → 'Charizard ex'. Mirrors images._try_pokemon."""
    return name.split(" - ")[0].strip()


def _norm_num(number: str) -> str:
    return (number.split("/")[0].lstrip("0") or "0")


def pokemontcg_prices(name: str, set_name: str, number: str) -> Optional[dict]:
    """
    Return the TCGplayer price block for the best-matching Pokemon card, e.g.
    {'holofoil': {'market': 12.3, 'low': ...}, 'normal': {...}}. None if no match.
    """
    key = f"ptcg::{_bare_name(name).lower()}::{_norm_num(number)}::{set_name.lower()}"
    cached = _cache_get(key)
    if cached is not None:
        return cached or None

    q = urllib.parse.quote(f'name:"{_bare_name(name)}" number:{_norm_num(number)}')
    headers = {"X-Api-Key": POKEMONTCG_API_KEY} if POKEMONTCG_API_KEY else None
    data = _get_json(f"https://api.pokemontcg.io/v2/cards?q={q}&pageSize=10", headers=headers)
    cards = (data or {}).get("data", [])
    if not cards:
        _cache_put(key, None)
        return None

    # Prefer the card whose set name shares the most words with the TCGP set.
    target_words = set(re.findall(r"\w+", set_name.lower()))

    def score(c: dict) -> int:
        s = c.get("set", {}).get("name", "").lower()
        return len(target_words & set(re.findall(r"\w+", s)))

    best = max(cards, key=score)
    prices = best.get("tcgplayer", {}).get("prices") or {}
    _cache_put(key, prices)
    return prices or None


def pokemontcg_market(name: str, set_name: str, number: str,
                      variance: str = "") -> Optional[float]:
    """
    Single 'market' price for a Pokemon raw single. Picks the price variant that
    best matches the inventory Variance (Holofoil / Reverse Holofoil / Normal),
    falling back to the highest available market price.
    """
    prices = pokemontcg_prices(name, set_name, number)
    if not prices:
        return None

    v = variance.lower()
    if "reverse" in v:
        order = ["reverseHolofoil", "holofoil", "normal"]
    elif "holo" in v:
        order = ["holofoil", "reverseHolofoil", "normal"]
    else:
        order = ["normal", "holofoil", "reverseHolofoil"]

    for variant in order:
        block = prices.get(variant)
        if block and block.get("market"):
            return float(block["market"])
    # Fallback: any variant with a market price → take the max
    markets = [float(b["market"]) for b in prices.values()
               if isinstance(b, dict) and b.get("market")]
    return max(markets) if markets else None


# ---------------------------------------------------------------------------
# PriceCharting — keyed; raw + graded, all games
# ---------------------------------------------------------------------------

def pricecharting_lookup(query: str) -> Optional[dict]:
    """
    Look up a product on PriceCharting. Returns a dict of USD prices:
      {'loose': 12.34, 'grade9': 45.0, 'grade10_psa': 120.0, ...}
    PriceCharting returns prices in PENNIES; we convert to dollars. None if no
    token configured or no match.
    """
    if not PRICECHARTING_TOKEN:
        return None

    key = f"pc::{query.lower()}"
    cached = _cache_get(key)
    if cached is not None:
        return cached or None

    url = (f"https://www.pricecharting.com/api/product?t={PRICECHARTING_TOKEN}"
           f"&q={urllib.parse.quote(query)}")
    data = _get_json(url)
    if not data or data.get("status") != "success":
        _cache_put(key, None)
        return None

    def cents(field: str) -> Optional[float]:
        v = data.get(field)
        return round(v / 100.0, 2) if isinstance(v, (int, float)) else None

    out = {
        "product": data.get("product-name"),
        "console": data.get("console-name"),
        "loose": cents("loose-price"),          # ungraded / raw
        "grade7": cents("condition-17-price"),
        "grade8": cents("condition-18-price"),
        "grade9": cents("graded-price"),         # PSA 9
        "grade95": cents("box-only-price"),      # PSA 9.5 (BGS)
        "grade10_psa": cents("manual-only-price"),
        "grade10_bgs": cents("bgs-10-price"),
    }
    out = {k: v for k, v in out.items() if v is not None or k in ("product", "console")}
    _cache_put(key, out)
    return out


# ---------------------------------------------------------------------------
# Unified market-price entrypoint
# ---------------------------------------------------------------------------

def market_price(name: str, set_name: str, number: str, category: str,
                 variance: str = "", grade: str = "Ungraded") -> Optional[float]:
    """
    Best available current market price for one card.
      • Ungraded Pokemon → pokemontcg.io (free), PriceCharting loose fallback.
      • Graded / MTG / YGO / sealed → PriceCharting (keyed).
    Returns None if nothing resolved (caller keeps the stale price).
    """
    is_graded = grade and grade != "Ungraded"

    if category == "Pokemon" and not is_graded:
        p = pokemontcg_market(name, set_name, number, variance)
        if p is not None:
            return p

    pc = pricecharting_lookup(f"pokemon {_bare_name(name)} {number}"
                              if category == "Pokemon"
                              else f"{_bare_name(name)} {set_name}")
    if pc:
        if is_graded:
            g = str(grade)
            if "10" in g and pc.get("grade10_psa"):
                return pc["grade10_psa"]
            if "9" in g and pc.get("grade9"):
                return pc["grade9"]
            if "8" in g and pc.get("grade8"):
                return pc["grade8"]
            if "7" in g and pc.get("grade7"):
                return pc["grade7"]
        if pc.get("loose"):
            return pc["loose"]
    return None


if __name__ == "__main__":
    import sys
    args = sys.argv[1:]
    if len(args) >= 3:
        name, set_name, number = args[0], args[1], args[2]
        variance = args[3] if len(args) > 3 else ""
        print(f"pokemontcg.io market: {pokemontcg_market(name, set_name, number, variance)}")
        print(f"full price block:     {pokemontcg_prices(name, set_name, number)}")
    else:
        print('usage: python3 app/pricing.py "<name>" "<set>" "<number>" [variance]')
