"""
Reference-price resolver for the radar.

Priority (verified): eBay 30-day SOLD median (best, via an Apify sold-comps
actor) > TCGplayer market (free, via pokemontcg.io) > PriceCharting (graded).
This module wires the free TCGplayer/PriceCharting path via pricing.py; the
sold-comps actor is an optional upgrade (hook below).

The biggest correctness risk is comp MISMATCH (wrong set/number/variant/raw-vs-
graded). We prefer a parsed identity carried on the listing (card_name/set_name/
card_number); if we only have the raw title, confidence drops to 'low'.
A fixture may carry `reference_override` for deterministic testing.
"""

from __future__ import annotations

import re

import pricing


def _name_from_title(title: str) -> str:
    # crude: strip grading + trailing junk, keep the leading card-ish phrase
    t = re.sub(r"\b(psa|cgc|bgs|gem|mint|nm|lp|mp)\b.*", "", title, flags=re.IGNORECASE)
    return t.strip()


def _number_from_title(title: str) -> str:
    m = re.search(r"\b(\d{1,3})\s*/\s*(\d{1,3})\b", title)
    return f"{m.group(1)}/{m.group(2)}" if m else ""


def get_reference(listing: dict) -> tuple[float | None, str]:
    """Return (market_price, confidence). confidence ∈ {high, medium, low}."""
    if listing.get("reference_override") is not None:
        return float(listing["reference_override"]), "high"

    has_identity = bool(listing.get("card_name"))
    name = listing.get("card_name") or _name_from_title(listing.get("title", ""))
    set_name = listing.get("set_name", "")
    number = listing.get("card_number") or _number_from_title(listing.get("title", ""))
    grade = listing.get("grade") or "Ungraded"

    M = pricing.market_price(name, set_name, number, "Pokemon", "", grade)
    if M is None:
        return None, "low"
    return M, ("medium" if has_identity else "low")


# --- Optional upgrade: eBay sold-comps via Apify ---------------------------
# def sold_median(card_key: str) -> float | None:
#     Run cfg.APIFY_SOLD_ACTOR over a "<card> sold" search, take the 30-day median
#     of >= Radar.MIN_SOLD_COMPS like-for-like results. Wire when APIFY_TOKEN set.
