"""
Radar orchestrator: fetch ending-soon auctions → resolve a reference price →
score (flip/collect) → notify flagged deals → snapshot for back-testing.

Wire to a launchd cron for continuous watching. Snapshots land in
app/state/sell/radar/ so thresholds can be retuned against real outcomes.
"""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import notify
from config import DATA_DIR
from radar import sources, comps, score

RADAR_DIR = DATA_DIR / "radar"
RADAR_DIR.mkdir(parents=True, exist_ok=True)


def run_radar(source: str = "fixture", mode: str = "both", fixture: str = "",
              notify_deals: bool = True, date_str: str = None) -> dict:
    date_str = date_str or date.today().strftime("%Y%m%d")
    listings = sources.get_source(source, fixture).fetch()

    # Prefilter on cheap title/auction gates BEFORE any network comp lookup —
    # the feed leaks non-Pokémon/junk, and a comp call per listing is the slow
    # part. Only fetch a reference for listings that clear the free gates.
    scored = []
    probe_mode = "flip" if mode == "both" else mode
    for lst in listings:
        dry = score.score_listing(lst, None, probe_mode)
        other_fails = [f for f in dry.gate_failures if "no reference price" not in f]
        if other_fails:
            scored.append((lst, dry))               # rejected on gates; skip the network
            continue
        M, conf = comps.get_reference(lst)
        scored.append((lst, score.best_score(lst, M, mode, conf)))

    flagged = [(l, s) for l, s in scored if s.flag]
    # Sort best deals first (lowest all-in / reference).
    flagged.sort(key=lambda ls: ls[1].ratio if ls[1].ratio is not None else 9)

    # Snapshot everything (flagged + rejected + reasons) for back-testing.
    snap = [{"title": l.get("title"), "url": l.get("url"),
             "flag": s.flag, "mode": s.mode, "all_in": s.all_in,
             "reference": s.reference, "ratio": s.ratio, "max_bid": s.max_bid,
             "expected_profit": s.expected_profit, "confidence": s.confidence,
             "priority": s.priority, "reasons": s.reasons,
             "gate_failures": s.gate_failures} for l, s in scored]
    (RADAR_DIR / f"{date_str}.json").write_text(json.dumps(snap, indent=1))

    if notify_deals and flagged:
        lines = [f"*eBay deal radar* — {len(flagged)} flagged ({mode})"]
        for l, s in flagged[:8]:
            star = "⭐" if s.priority else ("💰" if s.mode == "flip" else "🎴")
            lines.append(f"{star} *{s.mode}* {s.ratio:.0%} of ${s.reference:.0f} — "
                         f"bid ${s.all_in:.0f}, max ${s.max_bid:.0f}\n{l.get('title','')[:70]}\n{l.get('url','')}")
        notify.send("\n\n".join(lines), quiet=True)

    return {
        "source": source, "mode": mode,
        "fetched": len(listings), "flagged": len(flagged),
        "deals": [{
            "title": l.get("title"), "url": l.get("url"), "mode": s.mode,
            "all_in": s.all_in, "reference": s.reference, "ratio": s.ratio,
            "max_bid": s.max_bid, "expected_profit": s.expected_profit,
            "confidence": s.confidence, "priority": s.priority, "reasons": s.reasons,
        } for l, s in flagged],
        "rejected": [{
            "title": l.get("title"), "gate_failures": s.gate_failures,
        } for l, s in scored if not s.flag],
    }
