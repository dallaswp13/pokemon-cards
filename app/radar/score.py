"""
Deal-detection scorer — the verified FLAG ruleset, as pure logic.

Two modes (Dallas wants both):
  • flip    — snipe to resell. Must clear ~13% fees + a profit floor, so the
              all-in cost must be <= ~65% of the reference market.
  • collect — personal keeper. Only needs to be meaningfully below market
              (~90%); Eeveelutions get priority.

A listing FLAGS iff every HARD GATE passes AND the price test passes. Because a
basic scrape can't see everything (cert numbers, shill patterns), missing
signals DOWN-RANK confidence rather than hard-fail — the scorer never claims
more certainty than the data supports.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

import fees
from config import Radar

# Keywords that make a "deal" fake or not a clean single.
BAD_KEYWORDS = re.compile(
    r"(proxy|reprint|orica|custom|repack|re-?pack|as[\- ]?is|damaged|heavily played|"
    r"read (the )?description|not (psa|authentic|real)|fake|replica|\blot\b|\bbulk\b|"
    r"playset|\bx\d+\b|choose|you pick|pick a card)",
    re.IGNORECASE,
)
JAPANESE = re.compile(r"(japanese|japan|\bjpn?\b|日本|ポケモン)", re.IGNORECASE)
# The auction feed leaks other TCGs — reject clear non-Pokémon before scoring.
OTHER_GAME = re.compile(r"(yu-?gi-?oh|yugioh|konami|\bmtg\b|magic the gathering|"
                        r"\bjotl\b|-en\d{3}|lorcana|one piece card)", re.IGNORECASE)

_COND_ALIASES = {
    "near mint": "NM", "nm": "NM", "mint": "NM", "lightly played": "LP", "lp": "LP",
    "moderately played": "MP", "mp": "MP", "heavily played": "HP", "hp": "HP",
    "damaged": "DMG", "played": "MP",
}


def _condition_factor(listing: dict) -> tuple[float, bool]:
    cond = (listing.get("condition") or "").strip().lower()
    for alias, key in _COND_ALIASES.items():
        if alias in cond:
            return Radar.CONDITION_FACTOR[key], True
    return Radar.CONDITION_FACTOR["NM"], False   # assume NM, but flag as unknown


@dataclass
class Score:
    flag: bool
    mode: str
    reference: float | None          # comp market (M) after condition/trend haircut
    all_in: float                    # current bid + shipping
    ratio: float | None              # all_in / reference (lower = better deal)
    expected_profit: float | None    # flip only
    max_bid: float | None            # highest all-in that still clears the floor
    confidence: str                  # high | medium | low
    priority: bool                   # collect-mode Eeveelution etc.
    reasons: list[str] = field(default_factory=list)
    gate_failures: list[str] = field(default_factory=list)


def score_listing(listing: dict, reference: float | None, mode: str = "flip",
                  ref_confidence: str = "medium", window_min: float | None = None) -> Score:
    title = listing.get("title", "") or ""
    win = window_min if window_min is not None else Radar.SNIPE_WINDOW_MIN
    fails: list[str] = []
    reasons: list[str] = []

    # ── HARD GATES ──────────────────────────────────────────────────────────
    if not listing.get("is_auction", True):
        fails.append("not an auction")
    if JAPANESE.search(title) or str(listing.get("language", "English")).lower().startswith("ja"):
        fails.append("Japanese (English-only radar)")
    if OTHER_GAME.search(title):
        fails.append("not Pokémon (other TCG in feed)")
    if BAD_KEYWORDS.search(title):
        fails.append("suspect keyword in title (lot/proxy/damaged/…)")
    ml = listing.get("minutes_left")
    if ml is not None and ml > win:
        fails.append(f"ends in {ml:.0f}m (> {win:.0f}m window)")
    fb = listing.get("seller_feedback_pct")
    if fb is not None and fb < Radar.MIN_SELLER_FEEDBACK_PCT:
        fails.append(f"seller feedback {fb:.0f}% < {Radar.MIN_SELLER_FEEDBACK_PCT:.0f}%")
    fc = listing.get("seller_feedback_count")
    if fc is not None and fc < Radar.MIN_SELLER_FEEDBACK_COUNT:
        fails.append(f"seller history thin ({fc} < {Radar.MIN_SELLER_FEEDBACK_COUNT})")
    pc = listing.get("photos_count")
    if pc is not None and pc < 2:
        fails.append("<2 photos")
    if reference is None:
        fails.append("no reference price (can't value)")

    # ── PRICE TEST ──────────────────────────────────────────────────────────
    current = float(listing.get("current_bid", 0) or 0)
    shipping = float(listing.get("shipping", 0) or 0)
    all_in = current + shipping

    cond_factor, cond_known = _condition_factor(listing)
    graded = bool(listing.get("graded"))
    if graded:
        cond_factor = 1.0  # graded price already reflects the grade
    M = (reference * cond_factor * (1 - Radar.MARKET_DOWNTREND)) if reference else None
    ratio = (all_in / M) if M else None

    expected_profit = None
    max_bid = None
    priority = _is_priority(title)

    if M:
        per_order = fees.EBAY_PER_ORDER_LOW if M <= 10 else fees.EBAY_PER_ORDER_HIGH
        resale_net = M * (1 - fees.EBAY_FVF) - fees._ship_out(M) - per_order
        if mode == "flip":
            expected_profit = resale_net - all_in
            max_bid = resale_net - Radar.MIN_PROFIT_USD          # highest all-in that clears the floor
            price_ok = ratio <= Radar.FLIP_DISCOUNT and expected_profit >= Radar.MIN_PROFIT_USD
            reasons.append(f"resale net ~${resale_net:.0f}; buy ≤${max_bid:.0f} to clear "
                           f"${Radar.MIN_PROFIT_USD:.0f} profit")
        else:  # collect
            max_bid = Radar.COLLECT_DISCOUNT * M
            price_ok = ratio <= Radar.COLLECT_DISCOUNT
            reasons.append(f"market ~${M:.0f}; keeper if ≤${max_bid:.0f}")
    else:
        price_ok = False

    # ── Confidence ──────────────────────────────────────────────────────────
    confidence = "high"
    if ref_confidence == "low" or not cond_known:
        confidence = "medium"
    if ref_confidence == "low" and not cond_known:
        confidence = "low"
    if not graded and listing.get("grade"):
        reasons.append("graded price vs raw listing? verify")
        confidence = "low"

    flag = bool(price_ok and not fails)
    if flag:
        tag = "⭐ " if priority else ""
        reasons.insert(0, f"{tag}{mode.upper()} DEAL: all-in ${all_in:.0f} = "
                          f"{ratio:.0%} of ${M:.0f} market")

    return Score(flag=flag, mode=mode, reference=round(M, 2) if M else None,
                 all_in=round(all_in, 2), ratio=round(ratio, 3) if ratio else None,
                 expected_profit=round(expected_profit, 2) if expected_profit is not None else None,
                 max_bid=round(max_bid, 2) if max_bid is not None else None,
                 confidence=confidence, priority=priority,
                 reasons=reasons, gate_failures=fails)


def _is_priority(title: str) -> bool:
    t = title.lower()
    return any(k in t for k in Radar.COLLECT_KEYWORDS)


def best_score(listing: dict, reference: float | None, mode: str,
               ref_confidence: str = "medium", window_min: float | None = None) -> Score:
    """For mode='both', return whichever mode flags (flip preferred if both do)."""
    if mode in ("flip", "collect"):
        return score_listing(listing, reference, mode, ref_confidence, window_min)
    flip = score_listing(listing, reference, "flip", ref_confidence, window_min)
    collect = score_listing(listing, reference, "collect", ref_confidence, window_min)
    if flip.flag:
        return flip
    if collect.flag:
        return collect
    return flip  # neither flagged — return flip's diagnostics
