"""
Matching engine: maps export.csv rows to TCGplayer TCGP sheet rows.

Pure functions; no Flask, no I/O beyond what's passed in.
"""

import csv
import re
import unicodedata
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Optional

from rapidfuzz import process as rf_process, fuzz

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SEALED_KEYWORDS = re.compile(
    r'\b(booster\s+box|elite\s+trainer|booster\s+pack|booster\s+bundle|'
    r'collection\s+box|display\s+box|theme\s+deck|starter\s+deck|'
    r'prerelease\s+kit|gift\s+box|commander\s+deck|scene\s+box|'
    r'pokemon\s+center|premium\s+collection|build\s+&\s+battle|'
    r'tournament\s+pack|vault\s+box|secret\s+lair)\b',
    re.IGNORECASE,
)
# Bracketed quantity tags ("[Set of 4]", "[2 boxes]") almost always mean a
# sealed product/bundle, not a single card.
SEALED_BRACKET_PATTERN = re.compile(r'\[\s*set\s+of\s+\d+\s*\]', re.IGNORECASE)

# Tokens are real cards but the matcher rarely picks the right one — and
# they're worth ~$0. Set them aside automatically.
TOKEN_KEYWORDS = re.compile(
    r'\b(token|double-?sided\s+token|emblem)\b',
    re.IGNORECASE,
)

# TCGP "Miscellaneous Cards & Products" is a catch-all set; export entries
# under it tend to be promo / oddball items that don't index well by number.
# Auto-set-aside if we ever see one.
MISC_TCGP_SETS = frozenset({
    "Miscellaneous Cards & Products",
    "Jumbo Cards",
})

# Categories that go straight to the "filtered out" bucket (not Pokemon/MTG).
SUPPORTED_CATEGORIES = {"Pokemon", "Magic: The Gathering"}

# Japanese-only Pokemon sets — not in the English TCGP file. Filtered out
# wholesale (matches will always fail) so they show up as one explicit bucket
# rather than polluting the unmatched list. Update if the user adds more.
JAPANESE_POKEMON_SETS: frozenset[str] = frozenset({
    "Terastal Festival ex",
    "Super Electric Breaker",
    "Collect 151 Surprise",
    "Cyber Judge",
    "Wild Force",
    "Paradise Dragona",
    "MEGA Dream ex",
    "Shiny Treasure ex",
    "VSTAR Universe",
    "Raging Surf",
    "Clay Burst",
    "VMAX Climax",
    "Mega Brave",
    "Phantasmal Flames",
    "Neo Destiny (Japanese)",
    "Neo Discovery (Japanese)",
})

# Variance → exact TCGP Condition string (verified against real TCGP files)
POKEMON_VARIANCE_MAP: dict[str, str] = {
    "Normal":                 "Near Mint",
    "Holofoil":               "Near Mint Holofoil",
    "Reverse Holofoil":       "Near Mint Reverse Holofoil",
    "Poke Ball Reverse Holo": "Near Mint Reverse Holofoil",
    "Master Ball Reverse Holo": "Near Mint Reverse Holofoil",
    "Unlimited":              "Near Mint Unlimited",
    "Unlimited Holofoil":     "Near Mint Unlimited Holofoil",
    "1st Edition":            "Near Mint 1st Edition",
    "1st Edition Holofoil":   "Near Mint 1st Edition Holofoil",
}

MTG_VARIANCE_MAP: dict[str, str] = {
    "Normal": "Near Mint",
    "Foil":   "Near Mint Foil",
}

FUZZY_SET_THRESHOLD = 80      # rapidfuzz WRatio score; below this → unmatched
FUZZY_AUTO_THRESHOLD = 90     # above this + single candidate → auto-confirm

# Name disambiguation thresholds — used when multiple TCGP candidates share
# set+number+condition. The inventory product name usually disambiguates cleanly
# (e.g. "Carrot Cake" vs "Fish Token" both at #7).
NAME_AUTO_THRESHOLD   = 85    # winner's score must be at least this
NAME_AUTO_MARGIN      = 7     # winner must beat 2nd by this many points

# Exact aliases: export set name → TCGP set name (normalized both sides in code).
# Add entries here whenever a portfolio-tracker name diverges from TCGP's canonical
# name in a predictable, non-fuzzy way.
SET_ALIASES: dict[str, str] = {
    # Portfolio tracker uses shorter names; TCGP uses full names with series prefix
    "SV: 151":               "SV: Scarlet & Violet 151",
    "Pokemon 151":           "SV: Scarlet & Violet 151",
    "Prismatic Evolutions":  "SV: Prismatic Evolutions",
    "Paldean Fates":         "SV: Paldean Fates",
    "Shrouded Fable":        "SV: Shrouded Fable",
    "Stellar Crown":         "SV07: Stellar Crown",
    "Scarlet & Violet Promo": "SV: Scarlet & Violet Promo Cards",
    "Sword & Shield Promo":  "SWSH: Sword & Shield Promo Cards",
    "Sun & Moon Promo":      "SM Promos",
    "Black and White Promos": "Black and White Promos",
    # Plural/singular name divergence
    "Art Series: March of the Machines": "Art Series: March of the Machine",
    "Strixhaven: Mystical Archives":     "Strixhaven: Mystical Archive",
    # The List → TCGPlayer renamed
    "The List":                          "The List Reprints",
    # Universes Beyond: FINAL FANTASY
    "Universes Beyond: FINAL FANTASY":   "FINAL FANTASY",
    "Universes Beyond: FINAL FANTASY: Through the Ages": "FINAL FANTASY: Through the Ages",
}

# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class InventoryRow:
    raw: dict                  # original CSV row
    category: str
    set_name: str
    product_name: str
    card_number: str
    variance: str
    grade: str
    quantity: int
    market_price: float

@dataclass
class TcgpRow:
    raw: dict
    tcgplayer_id: str
    set_name: str
    product_name: str
    number: str
    condition: str
    photo_url: str

@dataclass
class MatchResult:
    inventory_row: InventoryRow
    confidence: str            # 'auto' | 'review' | 'unmatched'
    candidates: list[TcgpRow] = field(default_factory=list)
    matched_row: Optional[TcgpRow] = None
    reason: str = ""           # short diagnostic for review/unmatched


# ---------------------------------------------------------------------------
# Normalisation helpers
# ---------------------------------------------------------------------------

def _norm_set(name: str) -> str:
    """Lowercase, strip accents, collapse whitespace, remove most punctuation."""
    name = unicodedata.normalize("NFKD", name)
    name = name.encode("ascii", "ignore").decode()
    name = name.lower()
    name = re.sub(r"[^\w\s]", " ", name)   # keep word chars and spaces
    name = re.sub(r"\s+", " ", name).strip()
    return name


def _norm_number(num: str) -> str:
    """
    Normalise a card number for index / lookup.
    '065a/119' → '65a', '65/204' → '65', '249' → '249', 'XY67a' → 'XY67a'
    Leading zeros stripped only from the numeric prefix.
    """
    num = num.strip()
    # Drop denominator
    num = num.split("/")[0]
    # Strip leading zeros before digits/letters — e.g. '065a' → '65a', '007' → '7'
    num = re.sub(r"^0+(\d)", r"\1", num)
    return num


# ---------------------------------------------------------------------------
# Index construction
# ---------------------------------------------------------------------------

def build_tcgp_index(tcgp_rows: list[TcgpRow]) -> dict[tuple[str, str], list[TcgpRow]]:
    """
    Build index keyed by (normalized_set_name, normalized_number).
    O(1) candidate lookup.
    """
    idx: dict[tuple[str, str], list[TcgpRow]] = defaultdict(list)
    for row in tcgp_rows:
        key = (_norm_set(row.set_name), _norm_number(row.number))
        idx[key].append(row)
    return dict(idx)


def _all_norm_sets(tcgp_rows: list[TcgpRow]) -> list[str]:
    return list({_norm_set(r.set_name) for r in tcgp_rows})


def build_tcgp_by_set(tcgp_rows: list[TcgpRow]) -> dict[str, list[TcgpRow]]:
    """
    Index keyed by normalized set name → all rows in that set. Used as a
    fallback when the inventory row has no card number — we then match by
    set + product name.
    """
    idx: dict[str, list[TcgpRow]] = defaultdict(list)
    for row in tcgp_rows:
        idx[_norm_set(row.set_name)].append(row)
    return dict(idx)


# ---------------------------------------------------------------------------
# Set-name resolution with fuzzy fallback
# ---------------------------------------------------------------------------

def _resolve_set_candidates(
    norm_export_set: str,
    raw_export_set: str,
    tcgp_norm_sets: list[str],
) -> list[tuple[str, bool, int]]:
    """
    Returns all (norm_set, was_fuzzy, score) candidates above threshold,
    sorted by score descending.  Exact matches have score 100, was_fuzzy=False.

    Checks SET_ALIASES before fuzzy matching so known divergent names resolve
    cleanly without triggering the review path.
    """
    # Alias lookup (case-insensitive strip)
    alias_target = SET_ALIASES.get(raw_export_set.strip())
    if alias_target:
        norm_alias = _norm_set(alias_target)
        if norm_alias in tcgp_norm_sets:
            return [(norm_alias, False, 100)]

    if norm_export_set in tcgp_norm_sets:
        return [(norm_export_set, False, 100)]

    results = rf_process.extract(
        norm_export_set, tcgp_norm_sets, scorer=fuzz.WRatio, limit=None
    )
    above = [(r[0], True, int(r[1])) for r in results if r[1] >= FUZZY_SET_THRESHOLD]
    if not above:
        return []
    # If the top-scoring set beats the next by ≥5 points, it's the clear winner —
    # return only that one to avoid polluting candidates with lower-scoring sets
    # (e.g. "Art Series: March of the Machines" shouldn't pull in "March of the Machine").
    if len(above) >= 2 and above[0][2] - above[1][2] >= 5:
        return [above[0]]
    return above


# ---------------------------------------------------------------------------
# Per-row matching
# ---------------------------------------------------------------------------

def _normalize_name(name: str) -> str:
    """
    Normalise a card product name for comparison.

    Strip Pokemon-style number suffix only — ' - <token-with-digit>'.
    Examples:
      'Squirtle - 007/165'                  → 'Squirtle'
      'Pikachu - 58/102 (25th Anniversary)' → 'Pikachu (25th Anniversary)'
      'Gengar - SWSH241 (Prerelease)'       → 'Gengar (Prerelease)'

    We do NOT strip plain ' - ' (no digit) because MTG cards legitimately
    contain it ('Isengard, Saruman's Fortress - Boseiju, Who Shelters All').

    Parentheticals like '(Retro Frame)' / '(Surge Foil)' / '(Cosmos Holo)' are
    kept; they're often the actual disambiguator for variants.
    """
    # Match ' - <token-containing-a-digit>' followed by whitespace, paren, or end.
    base = re.sub(r"\s+-\s+\S*\d\S*(?=\s|\(|$)", "", name)
    base = re.sub(r"\s{2,}", " ", base)  # collapse double spaces left behind
    return base.strip().lower()


def _name_disambiguate(
    inv_name: str,
    candidates: list[TcgpRow],
) -> Optional[TcgpRow]:
    """
    Pick a candidate by product-name similarity to the inventory name.

    Strategy (in order):
      1. Exact normalised match — exactly one candidate equals the inventory
         name → confident pick.
      2. Fuzzy WRatio with margin — top candidate must beat second by
         NAME_AUTO_MARGIN points and clear NAME_AUTO_THRESHOLD.

    Returns None when neither applies; row falls through to review.
    """
    if not inv_name or len(candidates) < 2:
        return None

    inv_norm = _normalize_name(inv_name)
    exact = [c for c in candidates if _normalize_name(c.product_name) == inv_norm]
    if len(exact) == 1:
        return exact[0]

    scored = sorted(
        ((fuzz.WRatio(inv_norm, _normalize_name(c.product_name)), c) for c in candidates),
        key=lambda x: -x[0],
    )
    top_score, top = scored[0]
    second_score = scored[1][0]
    if top_score >= NAME_AUTO_THRESHOLD and (top_score - second_score) >= NAME_AUTO_MARGIN:
        return top
    return None


def _tcgp_condition(row: InventoryRow) -> Optional[str]:
    if row.category == "Pokemon":
        return POKEMON_VARIANCE_MAP.get(row.variance)
    if row.category == "Magic: The Gathering":
        return MTG_VARIANCE_MAP.get(row.variance)
    return None


def _match_by_name(
    inv: InventoryRow,
    target_condition: str,
    set_candidates: list[tuple[str, bool, int]],
    tcgp_by_set: dict[str, list[TcgpRow]],
) -> MatchResult:
    """
    Fallback when the inventory row has no card number. Searches each candidate
    set for rows whose normalised product name matches the inventory name.
    """
    inv_norm = _normalize_name(inv.product_name)
    if not inv_norm:
        return MatchResult(
            inventory_row=inv,
            confidence="unmatched",
            reason="empty card number and empty product name",
        )

    per_set_hits: list[tuple[str, bool, int, list[TcgpRow]]] = []
    for norm_set, was_fuzzy, score in set_candidates:
        rows = tcgp_by_set.get(norm_set, [])
        # Filter by exact normalized name match first (most reliable)
        exact = [r for r in rows
                 if _normalize_name(r.product_name) == inv_norm
                 and r.condition == target_condition]
        if exact:
            per_set_hits.append((norm_set, was_fuzzy, score, exact))
            continue
        # Fall back to fuzzy name search
        scored = []
        for r in rows:
            if r.condition != target_condition:
                continue
            s = fuzz.WRatio(inv_norm, _normalize_name(r.product_name))
            if s >= NAME_AUTO_THRESHOLD:
                scored.append((s, r))
        if scored:
            scored.sort(key=lambda x: -x[0])
            top_score = scored[0][0]
            # Keep only rows within 5 points of the top so review shows
            # plausible alternatives, not the entire set.
            kept = [r for s, r in scored if top_score - s <= 5]
            per_set_hits.append((norm_set, was_fuzzy, score, kept))

    if not per_set_hits:
        return MatchResult(
            inventory_row=inv,
            confidence="unmatched",
            reason=(
                f"no name match for '{inv.product_name}' in set "
                f"'{inv.set_name}' (no card number to disambiguate)"
            ),
        )

    all_candidates = [r for _, _, _, hits in per_set_hits for r in hits]
    best_set, best_fuzzy, best_score, best_hits = per_set_hits[0]

    # One set, one row → auto-confirm
    if len(per_set_hits) == 1 and len(best_hits) == 1:
        return MatchResult(
            inventory_row=inv,
            confidence="auto",
            candidates=best_hits,
            matched_row=best_hits[0],
            reason="set + name match (no card number)",
        )

    # Try name disambiguation across all sets' hits
    winner = _name_disambiguate(inv.product_name, all_candidates)
    if winner is not None:
        return MatchResult(
            inventory_row=inv,
            confidence="auto",
            candidates=all_candidates,
            matched_row=winner,
            reason="set + name disambiguation (no card number)",
        )

    return MatchResult(
        inventory_row=inv,
        confidence="review",
        candidates=all_candidates,
        reason=f"name-only match: {len(all_candidates)} candidates",
    )


def match_row(
    inv: InventoryRow,
    tcgp_index: dict[tuple[str, str], list[TcgpRow]],
    tcgp_norm_sets: list[str],
    tcgp_by_set: Optional[dict[str, list[TcgpRow]]] = None,
) -> MatchResult:
    target_condition = _tcgp_condition(inv)
    if target_condition is None:
        return MatchResult(
            inventory_row=inv,
            confidence="unmatched",
            reason=f"unknown variance '{inv.variance}'",
        )

    norm_num = _norm_number(inv.card_number)
    set_candidates = _resolve_set_candidates(
        _norm_set(inv.set_name), inv.set_name, tcgp_norm_sets
    )

    if not set_candidates:
        return MatchResult(
            inventory_row=inv,
            confidence="unmatched",
            reason=f"set '{inv.set_name}' not found in TCGP universe",
        )

    # Empty card number → fall back to set + name lookup. Common case:
    # Commander precon decks where the export tracker doesn't store numbers.
    if not norm_num and tcgp_by_set is not None:
        return _match_by_name(inv, target_condition, set_candidates, tcgp_by_set)

    # Extract the denominator from the export card number if present ("142/165" → "165").
    # Used to narrow down ambiguous multi-set hits.
    export_denom = inv.card_number.strip().split("/")[1].lstrip("0") if "/" in inv.card_number else None

    def _denom_matches(tcgp_row: TcgpRow) -> bool:
        if not export_denom:
            return True
        if "/" not in tcgp_row.number:
            return True  # TCGP row has no denominator; can't filter
        tcgp_denom = tcgp_row.number.split("/")[1].lstrip("0")
        return tcgp_denom == export_denom

    # For each set candidate, find TCGP rows matching number + condition.
    # This lets us break ties (e.g. "Lost Origin" vs "Lost Origin Trainer Gallery")
    # by seeing which set actually contains the card.
    per_set_hits: list[tuple[str, bool, int, list[TcgpRow]]] = []
    for norm_set, was_fuzzy, score in set_candidates:
        rows_here = tcgp_index.get((norm_set, norm_num), [])
        hits = [c for c in rows_here if c.condition == target_condition]
        # Apply denominator filter to reduce multi-set ambiguity
        denom_filtered = [c for c in hits if _denom_matches(c)]
        if denom_filtered:
            hits = denom_filtered
        if hits:
            per_set_hits.append((norm_set, was_fuzzy, score, hits))

    if not per_set_hits:
        return MatchResult(
            inventory_row=inv,
            confidence="unmatched",
            candidates=[],
            reason=(
                f"no candidates after condition filter "
                f"(set='{inv.set_name}', num='{inv.card_number}', "
                f"condition='{target_condition}')"
            ),
        )

    # Merge all matching TCGP rows for review purposes
    all_candidates = [row for _, _, _, hits in per_set_hits for row in hits]
    best_norm_set, best_fuzzy, best_score, best_hits = per_set_hits[0]

    # Single set match, single row → auto if exact or high-confidence fuzzy
    if len(per_set_hits) == 1 and len(best_hits) == 1:
        if not best_fuzzy or best_score >= FUZZY_AUTO_THRESHOLD:
            reason = (
                "exact set + number + condition"
                if not best_fuzzy
                else f"fuzzy set (score={best_score}) + exact number + condition"
            )
            return MatchResult(
                inventory_row=inv,
                confidence="auto",
                candidates=best_hits,
                matched_row=best_hits[0],
                reason=reason,
            )

    # Try name disambiguation before falling to review. The inventory product
    # name usually picks one candidate distinctly: 'Carrot Cake' vs 'Fish Token'
    # at #7, named cards vs unnamed tokens, etc.
    # Keep `all_candidates` on the result so the user can re-pair to one of
    # the alternatives later from the "review auto" view.
    if not best_fuzzy or best_score >= FUZZY_AUTO_THRESHOLD:
        winner = _name_disambiguate(inv.product_name, all_candidates)
        if winner is not None:
            return MatchResult(
                inventory_row=inv,
                confidence="auto",
                candidates=all_candidates,
                matched_row=winner,
                reason=(
                    "name disambiguation"
                    if not best_fuzzy
                    else f"name disambiguation + fuzzy set (score={best_score})"
                ),
            )

    # Multiple sets hit, or multiple rows, or low-confidence fuzzy → review
    reason_parts = []
    if best_fuzzy:
        reason_parts.append(f"fuzzy set match for '{inv.set_name}' (score={best_score})")
    if len(per_set_hits) > 1:
        reason_parts.append(f"card found in {len(per_set_hits)} sets")
    if len(all_candidates) > 1:
        reason_parts.append(f"{len(all_candidates)} condition candidates")
    return MatchResult(
        inventory_row=inv,
        confidence="review",
        candidates=all_candidates,
        reason="; ".join(reason_parts),
    )


# ---------------------------------------------------------------------------
# CSV loading
# ---------------------------------------------------------------------------

def load_export(path: str) -> tuple[list[InventoryRow], list[dict], list[dict], dict]:
    """
    Load export.csv. Returns:
      (raw_singles, set_aside_rows, filtered_out_rows, stats)

    filtered_out_rows: non-Pokemon/MTG rows (Lorcana, YuGiOh, etc.)
    set_aside_rows: graded or sealed
    raw_singles: everything else → goes to matcher
    stats: summary counts
    """
    raw_singles: list[InventoryRow] = []
    set_aside: list[dict] = []
    filtered_out: list[dict] = []

    cat_counts: dict[str, int] = defaultdict(int)
    sealed_count = 0
    graded_count = 0
    art_series_count = 0
    japanese_count = 0

    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            cat = row.get("Category", "").strip()
            cat_counts[cat] += 1

            if cat not in SUPPORTED_CATEGORIES:
                filtered_out.append(row)
                continue

            set_name = row.get("Set", "").strip()
            # MTG Art Series — visually disambiguating regular vs gold-stamped
            # variants is impractical without flipping each card; user opted to
            # exclude these from the matcher entirely.
            if cat == "Magic: The Gathering" and set_name.startswith("Art Series:"):
                filtered_out.append({**row, "_reason": "MTG art card"})
                art_series_count += 1
                continue
            # Japanese Pokemon sets are not in the English TCGP file.
            if cat == "Pokemon" and set_name in JAPANESE_POKEMON_SETS:
                filtered_out.append({**row, "_reason": "Japanese Pokemon set"})
                japanese_count += 1
                continue

            grade = row.get("Grade", "Ungraded").strip()
            product_name = row.get("Product Name", "").strip()

            is_graded = grade != "Ungraded"
            is_sealed = bool(
                SEALED_KEYWORDS.search(product_name)
                or SEALED_BRACKET_PATTERN.search(product_name)
            )
            is_token = bool(TOKEN_KEYWORDS.search(product_name))
            is_misc  = set_name in MISC_TCGP_SETS

            market_raw = row.get("Market Price (As of 2026-02-12)") or row.get(
                next((k for k in row if k.startswith("Market Price")), ""), ""
            )
            try:
                market_price = float(market_raw) if market_raw else 0.0
            except ValueError:
                market_price = 0.0

            try:
                quantity = int(row.get("Quantity", 0))
            except ValueError:
                quantity = 0

            if is_graded or is_sealed or is_token or is_misc:
                aside_row = dict(row)
                if is_graded:
                    aside_row["_reason"] = "graded"
                    graded_count += 1
                elif is_sealed:
                    aside_row["_reason"] = "sealed"
                    sealed_count += 1
                elif is_token:
                    aside_row["_reason"] = "token"
                    sealed_count += 1   # roll into the sealed counter for now
                else:
                    aside_row["_reason"] = "miscellaneous TCGP set"
                    sealed_count += 1
                aside_row["_market_value"] = market_price * quantity
                set_aside.append(aside_row)
                continue

            raw_singles.append(
                InventoryRow(
                    raw=row,
                    category=cat,
                    set_name=row.get("Set", "").strip(),
                    product_name=product_name,
                    card_number=row.get("Card Number", "").strip(),
                    variance=row.get("Variance", "").strip(),
                    grade=grade,
                    quantity=quantity,
                    market_price=market_price,
                )
            )

    stats = {
        "category_counts": dict(cat_counts),
        "filtered_out": len(filtered_out),
        "art_series_filtered": art_series_count,
        "japanese_filtered": japanese_count,
        "sealed": sealed_count,
        "graded": graded_count,
        "raw_singles": len(raw_singles),
    }
    return raw_singles, set_aside, filtered_out, stats


def load_tcgp(path: str) -> list[TcgpRow]:
    rows = []
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append(
                TcgpRow(
                    raw=row,
                    tcgplayer_id=row.get("TCGplayer Id", "").strip().strip('"'),
                    set_name=row.get("Set Name", "").strip(),
                    product_name=row.get("Product Name", "").strip(),
                    number=row.get("Number", "").strip(),
                    condition=row.get("Condition", "").strip(),
                    photo_url=row.get("Photo URL", "").strip(),
                )
            )
    return rows


# ---------------------------------------------------------------------------
# Main match pass
# ---------------------------------------------------------------------------

def run_match(
    export_path: str,
    pokemon_tcgp_path: str,
    mtg_tcgp_path: str,
) -> tuple[list[MatchResult], list[dict], dict]:
    """
    Full match pass. Returns:
      (results, set_aside_rows, stats)
    """
    singles, set_aside, filtered_out, load_stats = load_export(export_path)

    poke_rows = load_tcgp(pokemon_tcgp_path)
    mtg_rows = load_tcgp(mtg_tcgp_path)

    poke_index = build_tcgp_index(poke_rows)
    mtg_index = build_tcgp_index(mtg_rows)
    poke_by_set = build_tcgp_by_set(poke_rows)
    mtg_by_set = build_tcgp_by_set(mtg_rows)

    poke_norm_sets = _all_norm_sets(poke_rows)
    mtg_norm_sets = _all_norm_sets(mtg_rows)

    results: list[MatchResult] = []
    for inv in singles:
        if inv.category == "Pokemon":
            result = match_row(inv, poke_index, poke_norm_sets, poke_by_set)
        else:
            result = match_row(inv, mtg_index, mtg_norm_sets, mtg_by_set)
        results.append(result)

    auto    = [r for r in results if r.confidence == "auto"]
    review  = [r for r in results if r.confidence == "review"]
    unmatched = [r for r in results if r.confidence == "unmatched"]

    stats = {
        **load_stats,
        "auto_matched": len(auto),
        "review": len(review),
        "unmatched": len(unmatched),
        "total_singles": len(singles),
    }
    return results, set_aside, stats
