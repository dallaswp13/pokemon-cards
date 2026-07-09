"""
[Workflow A] Reprice + re-rank loop.

Refreshes the market price of every raw single from live sources (pokemontcg.io
free; PriceCharting for graded/MTG/YGO), diffs against the last snapshot to flag
movers, and writes an updated ranked sell list. Designed to run on a weekly
launchd cron; movers get pushed to Telegram/Hermes.

Snapshots persist in app/state/sell/reprice_snapshots/ so each run compares to
the previous one. The Collectr export's own "Market Price" column is the
baseline for the very first run.
"""

from __future__ import annotations

import csv
import json
from datetime import date
from pathlib import Path

import pricing
import notify
from config import DATA_DIR, ROOT
from matcher import load_export
from session import natural_key

SNAP_DIR = DATA_DIR / "reprice_snapshots"
SNAP_DIR.mkdir(parents=True, exist_ok=True)
MOVER_PCT = 0.15          # flag a card if |Δ| >= 15%
MOVER_MIN_VALUE = 20.0    # ...and it's worth flagging (unit price >= $20)


def _prev_snapshot() -> dict:
    snaps = sorted(SNAP_DIR.glob("*.json"))
    if not snaps:
        return {}
    try:
        return json.loads(snaps[-1].read_text())
    except Exception:
        return {}


def run_reprice(export_path: str, limit: int = 0, notify_movers: bool = True,
                date_str: str = None) -> dict:
    """
    Fetch fresh prices, snapshot, diff, re-rank. `limit` caps the number of cards
    priced (for a quick test run); 0 = all. Returns a summary + movers.
    """
    date_str = date_str or date.today().strftime("%Y%m%d")
    singles, *_ = load_export(export_path)
    if limit:
        # Price the most valuable cards first — that's where moves matter.
        singles = sorted(singles, key=lambda i: -i.market_price)[:limit]

    prev = _prev_snapshot()
    snapshot: dict[str, dict] = {}
    fetched = 0
    for inv in singles:
        nkey = natural_key(category=inv.category, set_name=inv.set_name,
                           card_number=inv.card_number, variance=inv.variance,
                           product_name=inv.product_name)
        fresh = pricing.market_price(inv.product_name, inv.set_name, inv.card_number,
                                     inv.category, inv.variance, inv.grade)
        if fresh is not None:
            fetched += 1
        market_new = fresh if fresh is not None else inv.market_price
        snapshot[nkey] = {
            "name": inv.product_name, "set": inv.set_name, "number": inv.card_number,
            "category": inv.category, "variance": inv.variance, "qty": inv.quantity,
            "market_baseline": inv.market_price,   # from the export
            "market_new": round(market_new, 2),
            "priced": fresh is not None,
        }

    # Movers: compare to previous snapshot (fallback to export baseline).
    movers = []
    for nkey, cur in snapshot.items():
        old = prev.get(nkey, {}).get("market_new", cur["market_baseline"])
        new = cur["market_new"]
        if old and new and new >= MOVER_MIN_VALUE:
            delta_pct = (new - old) / old
            if abs(delta_pct) >= MOVER_PCT:
                movers.append({**cur, "old": old, "delta_pct": delta_pct,
                               "delta_val": round((new - old) * cur["qty"], 2)})
    movers.sort(key=lambda m: -abs(m["delta_pct"]))

    # Persist snapshot
    (SNAP_DIR / f"{date_str}.json").write_text(json.dumps(snapshot, indent=0))

    # Re-ranked sell list
    ranked = sorted(snapshot.values(), key=lambda c: -c["market_new"] * c["qty"])
    out_path = Path(ROOT / "outputs" / f"reprice_ranked_{date_str}.csv")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    cum = 0.0
    with open(out_path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\r\n")
        w.writerow(["Rank", "Category", "Set", "Product", "Number", "Variance",
                    "Qty", "Market (new)", "Baseline", "Δ%", "Line value",
                    "Cumulative", "Priced?"])
        for i, c in enumerate(ranked, 1):
            line = c["market_new"] * c["qty"]
            cum += line
            base = c["market_baseline"] or 0
            dpct = (c["market_new"] - base) / base if base else 0
            w.writerow([i, c["category"], c["set"], c["name"], c["number"],
                        c["variance"], c["qty"], f"{c['market_new']:.2f}",
                        f"{base:.2f}", f"{dpct:+.0%}", f"{line:.2f}",
                        f"{cum:.2f}", "y" if c["priced"] else "stale"])

    summary = {
        "priced": fetched, "cards": len(singles),
        "coverage": round(fetched / len(singles) * 100, 1) if singles else 0,
        "total_value_new": round(sum(c["market_new"] * c["qty"] for c in ranked), 2),
        "movers": movers[:25], "mover_count": len(movers),
        "ranked_path": str(out_path),
        "compared_to_prev_snapshot": bool(prev),
    }

    if notify_movers and movers:
        up = [m for m in movers if m["delta_pct"] > 0][:5]
        down = [m for m in movers if m["delta_pct"] < 0][:5]
        lines = [f"*Reprice {date_str}* — {len(movers)} movers "
                 f"(value now ${summary['total_value_new']:,.0f})"]
        for m in up:
            lines.append(f"📈 {m['name']} ({m['set']}) {m['old']:.0f}→{m['market_new']:.0f} "
                         f"({m['delta_pct']:+.0%})")
        for m in down:
            lines.append(f"📉 {m['name']} ({m['set']}) {m['old']:.0f}→{m['market_new']:.0f} "
                         f"({m['delta_pct']:+.0%})")
        notify.send("\n".join(lines), quiet=True)

    return summary
