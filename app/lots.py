"""
[Workflow D] Bulk-lot dispositioner — turn the long tail into cash decisions.

Verified 2026 bulk economics: unsorted dumps fetch ~$0.02–0.03/card, but sorted
themed lots hit ~$0.30–0.60/card (4–10×). So the sub-$5 pool is only worth real
money if the $1–5 cards are pulled into lots; true commons + MTG/YGO bulk belong
in one cash dump to a buylist/card show (~60% of market, instant).

Also picks an eBay account WARM-UP set: the cheapest liquid singles that clear
the new-seller payout hold (10+ sales totaling $150+) before the pricey cards
get listed — otherwise high-value proceeds freeze for weeks.

Pure logic — no network, no keys. Reads the raw export directly so it includes
YuGiOh and everything the TCGplayer matcher filters out.
"""

from __future__ import annotations

import csv
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

import fees
from config import Router, ROOT
from matcher import (SEALED_KEYWORDS, SEALED_BRACKET_PATTERN, load_export)


def _market_col(row: dict) -> float:
    key = next((k for k in row if k.startswith("Market Price")), None)
    try:
        return float(row.get(key, 0) or 0) if key else 0.0
    except ValueError:
        return 0.0


@dataclass
class Bucket:
    category: str
    set_name: str
    tier: str                    # 'penny' (<$1) or 'low' ($1–5)
    count: int = 0
    market_value: float = 0.0
    examples: list[str] = field(default_factory=list)


def build_buckets(export_path: str) -> list[Bucket]:
    """Group ungraded, non-sealed sub-$5 singles (all games) by (category, set, tier)."""
    buckets: dict[tuple, Bucket] = {}
    with open(export_path, newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            grade = (row.get("Grade") or "Ungraded").strip()
            if grade != "Ungraded":
                continue                                   # graded → keeper
            name = (row.get("Product Name") or "").strip()
            if SEALED_KEYWORDS.search(name) or SEALED_BRACKET_PATTERN.search(name):
                continue                                   # sealed → keeper
            unit = _market_col(row)
            if unit >= Router.BULK_CEILING_USD:
                continue                                   # not bulk — routed by channels.py
            try:
                qty = int(row.get("Quantity", 0) or 0)
            except ValueError:
                qty = 0
            if qty <= 0:
                continue
            cat = (row.get("Category") or "").strip()
            sset = (row.get("Set") or "").strip()
            tier = "penny" if unit < 1.0 else "low"
            key = (cat, sset, tier)
            b = buckets.get(key) or Bucket(cat, sset, tier)
            b.count += qty
            b.market_value += unit * qty
            if len(b.examples) < 3:
                b.examples.append(name)
            buckets[key] = b
    return sorted(buckets.values(), key=lambda b: -b.market_value)


@dataclass
class WarmupPick:
    name: str
    set_name: str
    unit_price: float


def warmup_picks(export_path: str) -> list[WarmupPick]:
    """
    Cheapest *liquid* singles ($3–$25, non-scarce) that clear the eBay new-seller
    hold: accumulate until count >= WARMUP_SALES_COUNT and total >= WARMUP_TARGET.
    """
    import channels  # local import avoids a cycle
    singles, *_ = load_export(export_path)
    liquid = [inv for inv in singles
              if 3.0 <= inv.market_price <= 25.0 and not channels.is_scarce(inv)]
    liquid.sort(key=lambda inv: inv.market_price)
    picks: list[WarmupPick] = []
    total = 0.0
    for inv in liquid:
        picks.append(WarmupPick(inv.product_name, inv.set_name, inv.market_price))
        total += inv.market_price
        if len(picks) >= Router.WARMUP_SALES_COUNT and total >= Router.WARMUP_TARGET_USD:
            break
    return picks


def run_lots(export_path: str, out_dir: str = None, date_str: str = None) -> dict:
    """Build buckets, write lots_plan_<date>.csv, return a summary with warm-up picks."""
    out_dir = out_dir or str(ROOT / "outputs")
    date_str = date_str or date.today().strftime("%Y%m%d")
    buckets = build_buckets(export_path)

    out_path = Path(out_dir) / f"lots_plan_{date_str}.csv"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    totals = {"penny": [0, 0.0], "low": [0, 0.0]}
    with open(out_path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\r\n")
        w.writerow(["Category", "Set", "Tier", "Cards", "Market Value (paper)",
                    "Realistic Cash", "Recommended action", "Examples"])
        for b in buckets:
            if b.tier == "low":
                cash = b.market_value * fees.BULK_LOT_KEEP
                action = "Themed 10–20 card lots (or leave on TCGplayer)"
            else:
                cash = b.count * fees.BULK_DUMP_RATE
                action = "Bulk dump / sort to set lots → buylist / card show"
            totals[b.tier][0] += b.count
            totals[b.tier][1] += b.market_value
            w.writerow([b.category, b.set_name, b.tier, b.count,
                        f"{b.market_value:.2f}", f"{cash:.2f}", action,
                        " · ".join(b.examples)])

    picks = warmup_picks(export_path)
    return {
        "path": str(out_path),
        "buckets": len(buckets),
        "penny": {"cards": totals["penny"][0], "market": totals["penny"][1],
                  "dump_estimate": totals["penny"][0] * fees.BULK_DUMP_RATE},
        "low": {"cards": totals["low"][0], "market": totals["low"][1],
                "lot_estimate": totals["low"][1] * fees.BULK_LOT_KEEP},
        "warmup": {"count": len(picks),
                   "total": round(sum(p.unit_price for p in picks), 2),
                   "picks": [(p.name, p.set_name, round(p.unit_price, 2)) for p in picks]},
    }
