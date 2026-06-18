#!/usr/bin/env python3
"""CLI driver for matcher.py — run a full match pass and print a summary."""

import argparse
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from matcher import run_match, MatchResult
from output import export_outputs

ROOT = Path(__file__).parent.parent

def main():
    p = argparse.ArgumentParser(description="Run the TCGP inventory matcher.")
    p.add_argument("--export",  default=str(ROOT / "inputs" / "export.csv"))
    p.add_argument("--pokemon", default=str(ROOT / "inputs" / "TCGplayer_pokemon.csv"))
    p.add_argument("--mtg",     default=str(ROOT / "inputs" / "TCGplayer_mtg.csv"))
    p.add_argument("--spot-check", type=int, default=20,
                   help="Print N random auto-matches for hand verification")
    p.add_argument("--show-unmatched", action="store_true")
    p.add_argument("--show-review", action="store_true")
    p.add_argument("--export-outputs", action="store_true",
                   help="Write filled TCGP CSVs (auto-confirmed only) plus reports")
    args = p.parse_args()

    print("Loading files…")
    results, set_aside, stats = run_match(args.export, args.pokemon, args.mtg)

    print("\n=== Summary ===")
    print(f"Category breakdown:  {stats['category_counts']}")
    print(f"Filtered out (other categories): {stats['filtered_out']}")
    print(f"Sealed product (set aside):      {stats['sealed']}")
    print(f"Graded (set aside):              {stats['graded']}")
    print(f"Raw singles entering matcher:    {stats['raw_singles']}")
    print()
    total = stats["total_singles"]
    auto_pct  = stats["auto_matched"]  / total * 100 if total else 0
    rev_pct   = stats["review"]        / total * 100 if total else 0
    unm_pct   = stats["unmatched"]     / total * 100 if total else 0
    print(f"  Auto-matched : {stats['auto_matched']:4d}  ({auto_pct:.1f}%)")
    print(f"  Review queue : {stats['review']:4d}  ({rev_pct:.1f}%)")
    print(f"  Unmatched    : {stats['unmatched']:4d}  ({unm_pct:.1f}%)")

    # ── Spot-check random auto-matches ──────────────────────────────────────
    auto_results = [r for r in results if r.confidence == "auto"]
    sample_size = min(args.spot_check, len(auto_results))
    sample = random.sample(auto_results, sample_size)

    print(f"\n=== Spot-check: {sample_size} random auto-matches ===")
    print(f"{'Export set':<35} {'#':<8} {'Variance':<25} {'TCGP set':<40} {'TCGP #':<10} {'TCGP Condition'}")
    print("-" * 150)
    for r in sample:
        inv = r.inventory_row
        m   = r.matched_row
        print(
            f"{inv.set_name:<35} {inv.card_number:<8} {inv.variance:<25} "
            f"{m.set_name:<40} {m.number:<10} {m.condition}"
        )

    # ── Review queue sample ──────────────────────────────────────────────────
    if args.show_review:
        review_results = [r for r in results if r.confidence == "review"]
        print(f"\n=== Review queue ({len(review_results)} rows) ===")
        for r in review_results[:40]:
            inv = r.inventory_row
            print(f"  {inv.set_name} #{inv.card_number} [{inv.variance}] — {r.reason}")
            for c in r.candidates[:3]:
                print(f"    → [{c.condition}] {c.set_name} #{c.number} {c.product_name}")

    # ── Unmatched sample ─────────────────────────────────────────────────────
    if args.show_unmatched:
        unmatched = [r for r in results if r.confidence == "unmatched"]
        print(f"\n=== Unmatched ({len(unmatched)} rows) ===")
        for r in unmatched[:60]:
            inv = r.inventory_row
            print(f"  [{inv.category}] {inv.set_name} #{inv.card_number} "
                  f"[{inv.variance}] — {r.reason}")

    # ── Unmatched reason breakdown ───────────────────────────────────────────
    unmatched = [r for r in results if r.confidence == "unmatched"]
    reasons: dict[str, int] = {}
    for r in unmatched:
        key = r.reason.split("'")[0].strip()  # group by reason prefix
        reasons[key] = reasons.get(key, 0) + 1
    if reasons:
        print("\n=== Unmatched reason breakdown ===")
        for reason, count in sorted(reasons.items(), key=lambda x: -x[1]):
            print(f"  {count:4d}  {reason}")

    # ── Output writer ────────────────────────────────────────────────────────
    if args.export_outputs:
        print("\n=== Writing outputs ===")
        out = export_outputs(
            results=results,
            set_aside_rows=set_aside,
            pokemon_src=args.pokemon,
            mtg_src=args.mtg,
        )
        print(f"  Pokemon : {out['pokemon']['rows']:4d} rows, "
              f"qty={out['pokemon']['quantity']}, "
              f"filled prices={out['pokemon']['filled_prices']}  → {out['pokemon']['path']}")
        print(f"  MTG     : {out['mtg']['rows']:4d} rows, "
              f"qty={out['mtg']['quantity']}, "
              f"filled prices={out['mtg']['filled_prices']}  → {out['mtg']['path']}")
        print(f"  Set-aside: {out['set_aside']['rows']:3d} rows, "
              f"value=${out['set_aside']['value']:.2f}  → {out['set_aside']['path']}")
        print(f"  Unmatched: {out['unmatched']['rows']:3d} rows  → {out['unmatched']['path']}")


if __name__ == "__main__":
    main()
