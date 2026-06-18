"""
Output writer: produce filled TCGP CSVs and set-aside / unmatched reports.

Preserves the source TCGP file format byte-for-similarly:
  - CRLF line endings
  - Unquoted header row, fully-quoted data rows (csv.QUOTE_ALL)
"""

import csv
from collections import defaultdict
from datetime import date
from pathlib import Path
from typing import Iterable

from matcher import MatchResult


def _aggregate_quantities(results: Iterable[MatchResult]) -> dict[str, int]:
    """
    Sum quantities by TCGplayer Id across all auto-matched inventory rows.
    Multiple inventory rows mapping to the same TCGP product (e.g. the user
    entered 3 copies as separate rows) get summed into one Add to Quantity.
    """
    totals: dict[str, int] = defaultdict(int)
    for r in results:
        if r.confidence == "auto" and r.matched_row is not None:
            totals[r.matched_row.tcgplayer_id] += r.inventory_row.quantity
    return dict(totals)


def write_filled_tcgp(
    src_path: str,
    dst_path: str,
    quantities_by_id: dict[str, int],
) -> tuple[int, int]:
    """
    Read the source TCGP CSV, set Add to Quantity on rows whose TCGplayer Id is
    in `quantities_by_id`, drop rows whose Add to Quantity is empty/0, and
    write to dst_path preserving format.

    Returns (rows_written, total_quantity_set).
    """
    with open(src_path, newline="", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        header = next(reader)
        rows = list(reader)

    try:
        id_idx       = header.index("TCGplayer Id")
        addqty_idx   = header.index("Add to Quantity")
        mkt_price_idx = header.index("TCG Marketplace Price")
        # Fallbacks (in order) when Marketplace Price is empty — TCGplayer
        # rejects uploads that lack a Marketplace Price, so we have to fill it.
        fallback_idxs = [
            header.index("TCG Market Price"),
            header.index("TCG Low Price With Shipping"),
            header.index("TCG Low Price"),
            header.index("TCG Direct Low"),
        ]
    except ValueError as e:
        raise ValueError(f"Source TCGP file missing expected column: {e}")

    out_rows: list[list[str]] = []
    total_qty = 0
    filled_prices = 0
    for row in rows:
        tid = row[id_idx]
        qty = quantities_by_id.get(tid, 0)
        if qty <= 0:
            continue  # drop rows we're not adding any quantity to
        row[addqty_idx] = str(qty)
        if not row[mkt_price_idx].strip():
            for idx in fallback_idxs:
                if row[idx].strip():
                    row[mkt_price_idx] = row[idx]
                    filled_prices += 1
                    break
        out_rows.append(row)
        total_qty += qty

    Path(dst_path).parent.mkdir(parents=True, exist_ok=True)
    with open(dst_path, "w", newline="", encoding="utf-8") as f:
        # Header: unquoted, matches source format
        f.write(",".join(header) + "\r\n")
        # Data rows: all fields quoted
        writer = csv.writer(
            f, quoting=csv.QUOTE_ALL, lineterminator="\r\n"
        )
        writer.writerows(out_rows)

    return len(out_rows), total_qty, filled_prices


def write_set_aside(
    dst_path: str,
    set_aside_rows: list[dict],
) -> tuple[int, float]:
    """
    Write the set-aside report (graded + sealed + later: personal + PSA + bad).
    Returns (rows_written, total_market_value).
    """
    if not set_aside_rows:
        Path(dst_path).parent.mkdir(parents=True, exist_ok=True)
        with open(dst_path, "w", newline="", encoding="utf-8") as f:
            f.write("(no set-aside rows)\n")
        return 0, 0.0

    # Take the column order from the first row's source CSV order (skip the
    # internal _reason / _market_value keys, append them at the end).
    base_keys = [k for k in set_aside_rows[0].keys() if not k.startswith("_")]
    fieldnames = base_keys + ["_reason", "_market_value"]

    Path(dst_path).parent.mkdir(parents=True, exist_ok=True)
    total_value = 0.0
    with open(dst_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, lineterminator="\r\n")
        writer.writeheader()
        for row in set_aside_rows:
            writer.writerow({k: row.get(k, "") for k in fieldnames})
            total_value += float(row.get("_market_value", 0) or 0)
        # totals row
        totals = {k: "" for k in fieldnames}
        totals["Product Name"] = "TOTAL"
        totals["_market_value"] = f"{total_value:.2f}"
        writer.writerow(totals)

    return len(set_aside_rows), total_value


def write_unmatched(
    dst_path: str,
    unmatched_results: list[MatchResult],
) -> int:
    """
    Write the unmatched report. Each row is the original inventory row plus a
    `_reason` column explaining why it didn't match.
    """
    if not unmatched_results:
        Path(dst_path).parent.mkdir(parents=True, exist_ok=True)
        with open(dst_path, "w", newline="", encoding="utf-8") as f:
            f.write("(no unmatched rows)\n")
        return 0

    base_keys = list(unmatched_results[0].inventory_row.raw.keys())
    fieldnames = base_keys + ["_reason"]

    Path(dst_path).parent.mkdir(parents=True, exist_ok=True)
    with open(dst_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, lineterminator="\r\n")
        writer.writeheader()
        for r in unmatched_results:
            row = dict(r.inventory_row.raw)
            row["_reason"] = r.reason
            writer.writerow(row)
    return len(unmatched_results)


def export_outputs(
    results: list[MatchResult],
    set_aside_rows: list[dict],
    pokemon_src: str,
    mtg_src: str,
    out_dir: str = "outputs",
    date_str: str | None = None,
) -> dict:
    """
    Orchestrate all three outputs from auto-confirmed rows alone.
    Returns a dict with paths and counts for each file.
    """
    if date_str is None:
        date_str = date.today().strftime("%Y%m%d")

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    # Split auto-confirmed results by category for the two TCGP outputs
    auto_pokemon_ids: dict[str, int] = defaultdict(int)
    auto_mtg_ids:     dict[str, int] = defaultdict(int)
    for r in results:
        if r.confidence != "auto" or r.matched_row is None:
            continue
        tid = r.matched_row.tcgplayer_id
        if r.inventory_row.category == "Pokemon":
            auto_pokemon_ids[tid] += r.inventory_row.quantity
        else:
            auto_mtg_ids[tid] += r.inventory_row.quantity

    poke_path = str(out / f"TCGplayer_pokemon_filled_{date_str}.csv")
    mtg_path  = str(out / f"TCGplayer_mtg_filled_{date_str}.csv")
    aside_path = str(out / f"set_aside_{date_str}.csv")
    unmatched_path = str(out / f"unmatched_{date_str}.csv")

    poke_rows, poke_qty, poke_filled = write_filled_tcgp(pokemon_src, poke_path, dict(auto_pokemon_ids))
    mtg_rows,  mtg_qty,  mtg_filled  = write_filled_tcgp(mtg_src,     mtg_path,  dict(auto_mtg_ids))

    aside_count, aside_value = write_set_aside(aside_path, set_aside_rows)

    unmatched_results = [r for r in results if r.confidence == "unmatched"]
    unmatched_count = write_unmatched(unmatched_path, unmatched_results)

    return {
        "pokemon": {"path": poke_path, "rows": poke_rows, "quantity": poke_qty, "filled_prices": poke_filled},
        "mtg":     {"path": mtg_path,  "rows": mtg_rows,  "quantity": mtg_qty,  "filled_prices": mtg_filled},
        "set_aside": {"path": aside_path, "rows": aside_count, "value": aside_value},
        "unmatched": {"path": unmatched_path, "rows": unmatched_count},
    }
