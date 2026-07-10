#!/usr/bin/env python3
"""
Unified selling-ops CLI for the Pokemon-cards tool.

    python3 app/sell.py channels        # [B] where each single should sell
    python3 app/sell.py lots            # [D] bulk-lot plan + eBay warm-up picks
    python3 app/sell.py reprice         # [A] refresh prices, re-rank, flag movers   (next)
    python3 app/sell.py radar           # [C] eBay deal radar                         (next)

The existing matcher CLI (app/cli.py) is unchanged.
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
ROOT = Path(__file__).parent.parent
DEFAULT_EXPORT = str(ROOT / "inputs" / "export.csv")


def _fmt_money(x: float) -> str:
    return f"${x:,.2f}"


def cmd_channels(args) -> None:
    import channels
    s = channels.run_channels(args.export)
    print(f"\n=== Channel plan — {s['singles']} raw singles routed ===")
    print(f"{'Channel':<18} {'Cards':>7} {'Market value':>15} {'Est. net':>13}")
    print("-" * 56)
    order = ["eBay (auction)", "eBay (fixed)", "TCGplayer", "Bulk lot"]
    seen = set()
    for ch in order + [c for c in s["by_channel_count"] if c not in order]:
        if ch in seen or ch not in s["by_channel_count"]:
            continue
        seen.add(ch)
        print(f"{ch:<18} {s['by_channel_count'][ch]:>7} "
              f"{_fmt_money(s['by_channel_value'][ch]):>15} "
              f"{_fmt_money(s['by_channel_net'][ch]):>13}")
    print("-" * 56)
    print(f"Cards $250+ (eBay Authenticity Guarantee delay): {s['authenticity_count']}")
    print(f"Fee savings vs. sending every $5+ card to eBay:  "
          f"{_fmt_money(s['routing_savings_vs_naive_ebay'])}")
    print(f"\nWrote {s['path']}")


def cmd_lots(args) -> None:
    import lots
    s = lots.run_lots(args.export)
    print("\n=== Bulk-lot plan (sub-$5 singles, all games) ===")
    print(f"$1–5 cards : {s['low']['cards']:>6}  market {_fmt_money(s['low']['market'])}"
          f"  → themed lots ~{_fmt_money(s['low']['lot_estimate'])}")
    print(f"<$1 commons: {s['penny']['cards']:>6}  market {_fmt_money(s['penny']['market'])}"
          f"  → bulk dump ~{_fmt_money(s['penny']['dump_estimate'])}")
    print(f"\nBuckets by (game, set, tier): {s['buckets']}  → {s['path']}")

    w = s["warmup"]
    print(f"\n=== eBay account warm-up (clear the new-seller payout hold) ===")
    print(f"Sell these {w['count']} cheap liquid singles first "
          f"(total {_fmt_money(w['total'])}, target ≥12 sales / $175):")
    for name, sset, price in w["picks"]:
        print(f"  {_fmt_money(price):>8}  {name}  ({sset})")


def cmd_reprice(args) -> None:
    import reprice
    s = reprice.run_reprice(args.export, limit=args.limit,
                            notify_movers=not args.no_notify)
    print(f"\n=== Reprice — priced {s['priced']}/{s['cards']} "
          f"({s['coverage']}% coverage) ===")
    print(f"Sell-pool value (fresh): {_fmt_money(s['total_value_new'])}")
    print(f"Movers (≥15%, ≥$20): {s['mover_count']}"
          f"{'' if s['compared_to_prev_snapshot'] else ' (first run — vs export baseline)'}")
    for m in s["movers"][:12]:
        arrow = "📈" if m["delta_pct"] > 0 else "📉"
        print(f"  {arrow} {m['old']:>7.2f} → {m['market_new']:>7.2f}  "
              f"({m['delta_pct']:+.0%})  {m['name']} ({m['set']})")
    print(f"\nRanked list → {s['ranked_path']}")


def cmd_radar(args) -> None:
    from radar import run
    try:
        s = run.run_radar(source=args.source, mode=args.mode, fixture=args.fixture,
                          export_path=args.export, top_n=args.top,
                          notify_deals=not args.no_notify)
    except RuntimeError as e:
        print(f"radar: {e}")
        return
    print(f"\n=== Deal radar ({s['source']}, mode={s['mode']}) — "
          f"{s['fetched']} fetched, {s['flagged']} flagged ===")
    for d in s["deals"]:
        star = "⭐" if d["priority"] else ("💰" if d["mode"] == "flip" else "🎴")
        prof = f", profit ~{_fmt_money(d['expected_profit'])}" if d["expected_profit"] is not None else ""
        print(f"\n{star} [{d['mode']}/{d['confidence']}] {d['ratio']:.0%} of "
              f"{_fmt_money(d['reference'])} — bid {_fmt_money(d['all_in'])}, "
              f"max {_fmt_money(d['max_bid'])}{prof}")
        print(f"   {d['title']}")
        for r in d["reasons"][:2]:
            print(f"   · {r}")
    rej = s["rejected"]
    if rej:
        print(f"\n— Rejected {len(rej)} (gates): " +
              "; ".join(f"{r['title'][:34]}→{r['gate_failures'][0]}"
                        for r in rej if r["gate_failures"])[:400])


def cmd_push(args) -> None:
    import cloudsync
    r = cloudsync.push()
    print(f"pushed {r['pushed']} cards to the cloud cockpit as {r['user']}")


def cmd_pull(args) -> None:
    import cloudsync
    r = cloudsync.pull()
    print(f"pulled {r['pulled']} rows; applied tags/condition/keep to {r['applied']} cards")


def main() -> None:
    p = argparse.ArgumentParser(description="Pokemon-cards selling-ops CLI")
    p.add_argument("--export", default=DEFAULT_EXPORT,
                   help=f"Collectr export CSV (default: {DEFAULT_EXPORT})")
    sub = p.add_subparsers(dest="command", required=True)
    for name, fn, help_ in [
        ("channels", cmd_channels, "[B] route each single to its best channel"),
        ("lots", cmd_lots, "[D] bulk-lot plan + eBay warm-up picks"),
        ("reprice", cmd_reprice, "[A] refresh prices, re-rank, flag movers"),
        ("radar", cmd_radar, "[C] eBay deal radar"),
        ("push", cmd_push, "sync inventory up to the cloud cockpit (Supabase)"),
        ("pull", cmd_pull, "bring cloud tag/condition edits back into local"),
    ]:
        sp = sub.add_parser(name, help=help_)
        sp.set_defaults(func=fn)
        if name == "reprice":
            sp.add_argument("--limit", type=int, default=0,
                            help="price only the top-N most valuable cards (0=all)")
            sp.add_argument("--no-notify", action="store_true",
                            help="don't push movers to Telegram/Hermes")
        if name == "radar":
            sp.add_argument("--mode", choices=["flip", "collect", "both"],
                            default="both", help="deal-detection mode")
            sp.add_argument("--source", choices=["ebay_watch", "apify", "html", "fixture"],
                            default="fixture",
                            help="auction data source (ebay_watch = free Browse API watchlist)")
            sp.add_argument("--fixture", default="", help="path to a listings JSON fixture")
            sp.add_argument("--top", type=int, default=30,
                            help="ebay_watch: how many top cards to watch")
            sp.add_argument("--no-notify", action="store_true")

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
