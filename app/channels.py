"""
[Workflow B] Channel router — tell each sellable single where to go.

Encodes the verified 2026 finding that the "high-value → eBay" default is
partly wrong: TCGplayer's $75 commission cap makes it the CHEAPER structure for
~$100–$900 fixed-price cards. So we compute net proceeds on each channel and
recommend the net-best channel — with one override: genuinely scarce/chase
cards go to an eBay AUCTION, where price discovery beats the fee math.

Reuses matcher.load_export so bucketing (graded/sealed/Japanese excluded) is
identical to the TCGplayer pipeline. Pure logic — no network, no keys.
"""

from __future__ import annotations

import csv
import math
import re
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

import fees
from config import Router, Grading
from matcher import load_export, InventoryRow

# ── Scarcity heuristics ─────────────────────────────────────────────────────
# A card is "scarce/chase" (auction-worthy) if any of these fire.

_SCARCE_RARITY = re.compile(
    r"(secret|special illustration|illustration rare|hyper|rainbow|gold|"
    r"alternate|alt[\- ]?art|shiny|radiant|prime|star|crystal)",
    re.IGNORECASE,
)
_SCARCE_NAME = re.compile(
    r"(alternate art|alt art|\(secret\)|gold star|full art|1st edition|rainbow|"
    r"special illustration|trainer gallery|galarian gallery|character (super )?rare|"
    r"delta species|gold\b)",
    re.IGNORECASE,
)
# WOTC / vintage / EX-era sets where even non-secret cards carry collector premium.
_VINTAGE_SET = re.compile(
    r"^(base set|jungle|fossil|team rocket|gym |neo |legendary collection|"
    r"expedition|aquapolis|skyridge|ex |ex:|crystal guardians|diamond and pearl promos|"
    r"nintendo promos|celebrations|hidden fates)",
    re.IGNORECASE,
)


def _rarity(inv: InventoryRow) -> str:
    return (inv.raw.get("Rarity") or "").strip()


def is_scarce(inv: InventoryRow) -> bool:
    if inv.variance and "1st edition" in inv.variance.lower():
        return True
    if _SCARCE_RARITY.search(_rarity(inv)):
        return True
    if _SCARCE_NAME.search(inv.product_name):
        return True
    if _VINTAGE_SET.match(inv.set_name):
        return True
    # Secret rare: numerator > denominator (e.g. "232/091").
    m = re.match(r"\s*(\d+)\s*/\s*(\d+)", inv.card_number)
    if m and int(m.group(1)) > int(m.group(2)):
        return True
    return False


_TEXTURED_RARITY = re.compile(
    r"(illustration|special|secret|hyper|rainbow|gold|amazing|radiant)", re.IGNORECASE)
_TEXTURED_NAME = re.compile(
    r"(alternate art|alt art|full art|gold star|\(secret\))", re.IGNORECASE)


def card_class(inv: InventoryRow) -> str:
    """vintage | modern_textured | modern_smooth — drives grading multiples + timing."""
    if _VINTAGE_SET.match(inv.set_name):
        return "vintage"
    if _TEXTURED_RARITY.search(_rarity(inv)) or _TEXTURED_NAME.search(inv.product_name):
        return "modern_textured"
    return "modern_smooth"


def _value_tier(price: float) -> str:
    return "HIGH" if price >= 100 else "MID" if price >= 10 else "LOW" if price >= 3 else "BULK"


def _sell_now(price: float, cls: str) -> float:
    """Sell-now priority (0–1): modern decays (sell now), value weights it up.
    v1 proxy — a fuller score folds in live decline momentum from reprice snapshots."""
    modern = 0.0 if cls == "vintage" else 1.0
    val = min(1.0, math.log10(max(price, 1)) / 3)     # $1→0 … $1000→1
    return round(0.55 * modern + 0.45 * val, 3)


# ── Routing ─────────────────────────────────────────────────────────────────

@dataclass
class Route:
    inv: InventoryRow
    channel: str
    reason: str
    ebay_net: float
    tcg_net: float
    flags: list[str]
    rec_net: float = 0.0          # per-unit net via the recommended channel
    net_pct: float = 0.0          # rec_net / (effective) price — the objective function
    value_tier: str = ""
    card_class: str = ""
    sell_now: float = 0.0
    grade: object = None          # GradeDecision
    psa10: float = 0.0            # estimated PSA-10 price (price × class multiple)
    psa10_pct: float = 0.0        # PSA-10 as a multiple of raw (e.g. 2.5 = 250%)
    shop_trade: float = 0.0       # local shop store-credit value
    shop_cash: float = 0.0        # local shop cash value

    @property
    def unit_price(self) -> float:
        return self.inv.market_price

    @property
    def total_value(self) -> float:
        return self.inv.market_price * self.inv.quantity

    @property
    def total_net(self) -> float:
        return self.rec_net * self.inv.quantity


def route_row(inv: InventoryRow, price: float = None) -> Route:
    # `price` lets the caller pass a condition-adjusted effective price; defaults
    # to the export's NM market price.
    price = inv.market_price if price is None else price
    e = fees.ebay_net(price)
    t = fees.tcgplayer_net(price)
    flags: list[str] = []

    if price >= fees.EBAY_AUTHENTICITY_THRESHOLD:
        flags.append("ebay-authenticity-$250+")
    tcgp_tracking = price > Router.TCGP_TRACKING_THRESHOLD
    if tcgp_tracking:
        flags.append("tcgp-tracking-$50+")   # TCGplayer needs tracking → avoid

    scarce = is_scarce(inv)
    if price < Router.BULK_CEILING_USD:
        channel, reason = "LCS", "under $5 — local card shop (80/70% trade)"
    elif scarce and price >= Router.EBAY_SCARCE_MIN_USD:
        channel, reason, flags = "eBay (auction)", "scarce/chase — auction realizes above market", flags + ["scarce"]
    elif tcgp_tracking:
        channel, reason = "eBay (fixed)", "$50+ — avoid TCGplayer tracking requirement"
    elif e.net > t.net:
        channel, reason = "eBay (fixed)", "net-best fixed price"
    else:
        channel, reason = "TCGplayer", "net-best fixed price (or tie)"

    r = Route(inv, channel, reason, e.net, t.net, flags)
    r.shop_trade = round(fees.shop_trade(price), 2)
    r.shop_cash = round(fees.shop_cash(price), 2)
    r.rec_net = (r.shop_trade if channel == "LCS"   # Dallas prefers trade credit
                 else e.net if channel.startswith("eBay") else t.net)
    r.net_pct = (r.rec_net / price) if price else 0.0
    r.value_tier = _value_tier(price)
    r.card_class = card_class(inv)
    r.sell_now = _sell_now(price, r.card_class)
    # Grading / PSA-10 are Pokémon concepts here — suppress for MTG/YGO.
    if inv.category == "Pokemon":
        m10 = Grading.CLASS_PARAMS.get(r.card_class, {}).get("m10", 0)
        r.psa10 = round(price * m10, 2)
        r.psa10_pct = m10
        import grading   # lazy import avoids a channels↔grading cycle
        r.grade = grading.grade_decision(price, r.card_class)
    return r


# ── Run + report ─────────────────────────────────────────────────────────────

def run_channels(export_path: str, out_dir: str = None, date_str: str = None) -> dict:
    """Route every raw single, write channel_plan_<date>.csv, return a summary."""
    from config import ROOT
    out_dir = out_dir or str(ROOT / "outputs")
    date_str = date_str or date.today().strftime("%Y%m%d")

    singles, set_aside, filtered_out, stats = load_export(export_path)
    routes = [route_row(inv) for inv in singles]

    # Summary aggregates
    by_channel_count: dict[str, int] = defaultdict(int)
    by_channel_value: dict[str, float] = defaultdict(float)
    by_channel_net: dict[str, float] = defaultdict(float)
    for r in routes:
        by_channel_count[r.channel] += r.inv.quantity
        by_channel_value[r.channel] += r.total_value
        # Net estimate: use the recommended channel's net * qty (bulk uses buylist).
        if r.channel == "Bulk lot":
            unit_net = fees.bulk_unit_cash(r.unit_price)
        elif r.channel.startswith("eBay"):
            unit_net = r.ebay_net
        else:
            unit_net = r.tcg_net
        by_channel_net[r.channel] += unit_net * r.inv.quantity

    # eBay-vs-TCGplayer savings: how much the router's fee logic saves vs.
    # blindly sending every $5+ card to eBay (the old default).
    naive_ebay_net = sum(r.ebay_net * r.inv.quantity
                         for r in routes if r.unit_price >= Router.BULK_CEILING_USD)
    routed_online_net = sum(
        (r.ebay_net if r.channel.startswith("eBay") else r.tcg_net) * r.inv.quantity
        for r in routes if r.unit_price >= Router.BULK_CEILING_USD)

    out_path = Path(out_dir) / f"channel_plan_{date_str}.csv"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\r\n")
        w.writerow(["Category", "Set", "Product Name", "Card Number", "Variance",
                    "Rarity", "Qty", "Unit Market", "Total Value",
                    "Recommended Channel", "Reason", "eBay net/unit",
                    "TCGplayer net/unit", "Flags"])
        for r in sorted(routes, key=lambda x: -x.total_value):
            inv = r.inv
            w.writerow([inv.category, inv.set_name, inv.product_name, inv.card_number,
                        inv.variance, _rarity(inv), inv.quantity,
                        f"{r.unit_price:.2f}", f"{r.total_value:.2f}",
                        r.channel, r.reason, f"{r.ebay_net:.2f}",
                        f"{r.tcg_net:.2f}", "; ".join(r.flags)])

    return {
        "path": str(out_path),
        "singles": len(singles),
        "by_channel_count": dict(by_channel_count),
        "by_channel_value": dict(by_channel_value),
        "by_channel_net": dict(by_channel_net),
        "authenticity_count": sum(1 for r in routes if "ebay-authenticity-$250+" in r.flags),
        "routing_savings_vs_naive_ebay": routed_online_net - naive_ebay_net,
    }
