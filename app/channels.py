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
import re
from collections import defaultdict
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import fees
from config import Router
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


# ── Routing ─────────────────────────────────────────────────────────────────

@dataclass
class Route:
    inv: InventoryRow
    channel: str
    reason: str
    ebay_net: float
    tcg_net: float
    flags: list[str]

    @property
    def unit_price(self) -> float:
        return self.inv.market_price

    @property
    def total_value(self) -> float:
        return self.inv.market_price * self.inv.quantity


def route_row(inv: InventoryRow) -> Route:
    price = inv.market_price
    e = fees.ebay_net(price)
    t = fees.tcgplayer_net(price)
    flags: list[str] = []

    if price >= fees.EBAY_AUTHENTICITY_THRESHOLD:
        flags.append("ebay-authenticity-$250+")

    # Sub-$5 → bulk lots (Workflow D handles these).
    if price < Router.BULK_CEILING_USD:
        return Route(inv, "Bulk lot", "under $5 — lot/buylist (Workflow D)",
                     e.net, t.net, flags)

    scarce = is_scarce(inv)
    if scarce and price >= Router.EBAY_SCARCE_MIN_USD:
        return Route(inv, "eBay (auction)",
                     "scarce/chase — auction realizes above market", e.net, t.net,
                     flags + ["scarce"])

    # Otherwise: net-best fixed price. Tie → TCGplayer (less friction, existing
    # pipeline, no authentication delay).
    if e.net > t.net:
        return Route(inv, "eBay (fixed)", "net-best fixed price", e.net, t.net, flags)
    return Route(inv, "TCGplayer", "net-best fixed price (or tie)", e.net, t.net, flags)


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
