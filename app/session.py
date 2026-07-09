"""
SQLite-backed decision store.

Decisions are keyed by a *natural key* derived from the card's identity
(category + set + number + variance + product name). This means uploading a
newer export.csv carries forward all your prior link/attribute decisions —
no need to re-mark cards.

The schema has two orthogonal axes per row:

  - link_kind:    'confirm' | 'skip' | NULL
                  ('skip' = "no match"; NULL = use the matcher's auto pick)
  - attribute:    'personal' | 'psa' | 'bad' | 'ignore' | NULL
                  (NULL = for sale by default; non-NULL = exclude from output)

A row can have any combination of the two — e.g. a user-confirmed link with
attribute='personal' means "this is the right card, but I'm keeping it."

Each function opens its own connection because Flask's dev server is multi-
threaded and SQLite connections aren't thread-safe.
"""

import hashlib
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Optional

ROOT      = Path(__file__).parent.parent
STATE_DIR = Path(__file__).parent / "state"

LINK_KINDS      = {"confirm", "skip"}
ATTRIBUTE_KINDS = {"personal", "psa", "bad", "ignore"}

# Single global database — decisions persist across sessions / uploads.
DB_PATH = STATE_DIR / "decisions.sqlite"

DDL = """
CREATE TABLE IF NOT EXISTS decisions (
    natural_key   TEXT PRIMARY KEY,
    link_kind     TEXT,
    tcgplayer_id  TEXT,
    attribute     TEXT,
    notes         TEXT,
    tags          TEXT,
    condition     TEXT,
    status        TEXT,
    listed_at     TEXT,
    sold_at       TEXT,
    sale_price    REAL,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
)
"""

# Ledger status values (NULL = unlisted/default).
STATUS_KINDS = {"listed", "sold"}
CONDITION_KINDS = {"NM", "LP", "MP", "HP", "DMG"}
# Extra columns added to older DBs by init_db.
_ADDED_COLUMNS = {"tags": "TEXT", "condition": "TEXT", "status": "TEXT",
                  "listed_at": "TEXT", "sold_at": "TEXT", "sale_price": "REAL"}


def _ensure_dir() -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)


@contextmanager
def _open():
    _ensure_dir()
    conn = sqlite3.connect(DB_PATH)
    try:
        yield conn
    finally:
        conn.close()


def init_db() -> None:
    """Create the table and run any one-shot migrations from old schemas."""
    with _open() as conn:
        conn.execute(DDL)
        # Add any newer columns to pre-existing databases.
        cols = {r[1] for r in conn.execute("PRAGMA table_info(decisions)").fetchall()}
        for col, typ in _ADDED_COLUMNS.items():
            if col not in cols:
                conn.execute(f"ALTER TABLE decisions ADD COLUMN {col} {typ}")
        _migrate_legacy_per_session(conn)
        conn.commit()


def _migrate_legacy_per_session(conn: sqlite3.Connection) -> None:
    """
    Earlier versions stored a per-session DB with row_idx as the key. Those
    decisions are no longer reachable because row_idx is unstable across
    uploads, so they're dropped silently — but we leave the .sqlite files in
    place if any exist (the user can delete state/session_*.sqlite).
    """
    return


# ── Natural-key derivation ────────────────────────────────────────────────

def natural_key(*, category: str, set_name: str, card_number: str,
                variance: str, product_name: str) -> str:
    """
    Build a stable identity key for an inventory row. Same card across exports
    will produce the same key as long as these five fields don't change.
    """
    parts = [
        (category or "").strip().lower(),
        (set_name or "").strip().lower(),
        (card_number or "").strip().lower(),
        (variance or "").strip().lower(),
        (product_name or "").strip().lower(),
    ]
    raw = "|".join(parts)
    # Hash to keep keys compact and cheap to index
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


# ── CRUD ───────────────────────────────────────────────────────────────────

def _norm_tags(tags) -> str:
    """Normalize a tags value (list or comma string) to a clean comma-joined string."""
    if isinstance(tags, str):
        parts = tags.split(",")
    else:
        parts = list(tags or [])
    seen, out = set(), []
    for t in parts:
        t = str(t).strip().lower()
        if t and t not in seen:
            seen.add(t)
            out.append(t)
    return ",".join(out)


def update_decision(
    nkey: str,
    *,
    link_kind: Optional[str] = "__unset__",
    tcgplayer_id: Optional[str] = "__unset__",
    attribute: Optional[str] = "__unset__",
    notes: Optional[str] = "__unset__",
    tags="__unset__",
) -> None:
    """
    Patch any axis of a decision. Pass None to clear an axis; omit a kwarg to
    leave it unchanged. `tags` accepts a list or comma-separated string.
    """
    if link_kind not in ("__unset__", None) and link_kind not in LINK_KINDS:
        raise ValueError(f"unknown link_kind: {link_kind}")
    if attribute not in ("__unset__", None) and attribute not in ATTRIBUTE_KINDS:
        raise ValueError(f"unknown attribute: {attribute}")
    if link_kind == "confirm" and not tcgplayer_id:
        raise ValueError("link_kind='confirm' requires tcgplayer_id")

    with _open() as conn:
        conn.execute(DDL)
        cur = conn.execute(
            "SELECT link_kind, tcgplayer_id, attribute, notes, tags, condition, status, sale_price "
            "FROM decisions WHERE natural_key=?",
            (nkey,),
        ).fetchone()
        cur_link, cur_tid, cur_attr, cur_notes, cur_tags, cur_cond, cur_status, cur_price = cur if cur else (None,)*8

        new_link  = cur_link  if link_kind    == "__unset__" else link_kind
        new_tid   = cur_tid   if tcgplayer_id == "__unset__" else tcgplayer_id
        new_attr  = cur_attr  if attribute    == "__unset__" else attribute
        new_notes = cur_notes if notes        == "__unset__" else notes
        new_tags  = cur_tags  if tags         == "__unset__" else (_norm_tags(tags) or None)

        # Keep the row if it still carries condition/ledger state, even with no link/attr/tag.
        if (new_link is None and new_attr is None and not new_notes and not new_tags
                and not cur_cond and not cur_status and cur_price is None):
            conn.execute("DELETE FROM decisions WHERE natural_key=?", (nkey,))
        else:
            conn.execute("""
                INSERT INTO decisions (natural_key, link_kind, tcgplayer_id, attribute, notes, tags, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
                ON CONFLICT(natural_key) DO UPDATE SET
                    link_kind    = excluded.link_kind,
                    tcgplayer_id = excluded.tcgplayer_id,
                    attribute    = excluded.attribute,
                    notes        = excluded.notes,
                    tags         = excluded.tags,
                    updated_at   = excluded.updated_at
            """, (nkey, new_link, new_tid, new_attr, new_notes, new_tags))
        conn.commit()


def clear_decision(nkey: str) -> None:
    with _open() as conn:
        conn.execute("DELETE FROM decisions WHERE natural_key=?", (nkey,))
        conn.commit()


def update_condition(nkey: str, condition) -> None:
    """Set a card's condition (NM/LP/MP/HP/DMG), or None to reset to default (NM)."""
    if condition not in (None, *CONDITION_KINDS):
        raise ValueError(f"unknown condition: {condition}")
    with _open() as conn:
        conn.execute(DDL)
        conn.execute("""
            INSERT INTO decisions (natural_key, condition, updated_at)
            VALUES (?, ?, datetime('now'))
            ON CONFLICT(natural_key) DO UPDATE SET
                condition = excluded.condition, updated_at = excluded.updated_at
        """, (nkey, condition))
        # Clean up a row that now holds nothing meaningful.
        conn.execute("""DELETE FROM decisions WHERE natural_key=? AND link_kind IS NULL
            AND attribute IS NULL AND (notes IS NULL OR notes='') AND (tags IS NULL OR tags='')
            AND condition IS NULL AND status IS NULL AND sale_price IS NULL""", (nkey,))
        conn.commit()


def update_listing(nkey: str, status="__unset__", sale_price="__unset__") -> None:
    """
    Ledger state: mark a card 'listed' or 'sold' (or None to reset), and record a
    sale price. Stamps listed_at / sold_at automatically.
    """
    if status not in ("__unset__", None) and status not in STATUS_KINDS:
        raise ValueError(f"unknown status: {status}")
    with _open() as conn:
        conn.execute(DDL)
        now = conn.execute("SELECT datetime('now')").fetchone()[0]
        cur = conn.execute(
            "SELECT status, listed_at, sold_at, sale_price FROM decisions WHERE natural_key=?",
            (nkey,),
        ).fetchone()
        c_status, c_listed, c_sold, c_price = cur if cur else (None, None, None, None)

        new_status = c_status if status == "__unset__" else status
        new_price = c_price if sale_price == "__unset__" else sale_price
        new_listed = c_listed or (now if new_status in ("listed", "sold") else None)
        new_sold = c_sold or (now if new_status == "sold" else None)

        conn.execute("""
            INSERT INTO decisions (natural_key, status, listed_at, sold_at, sale_price, updated_at)
            VALUES (?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(natural_key) DO UPDATE SET
                status     = excluded.status,
                listed_at  = excluded.listed_at,
                sold_at    = excluded.sold_at,
                sale_price = excluded.sale_price,
                updated_at = excluded.updated_at
        """, (nkey, new_status, new_listed, new_sold, new_price))
        conn.commit()


def get_decision(nkey: str) -> Optional[dict]:
    with _open() as conn:
        conn.execute(DDL)
        row = conn.execute(
            "SELECT link_kind, tcgplayer_id, attribute, notes, tags, condition, status, "
            "listed_at, sold_at, sale_price, updated_at FROM decisions WHERE natural_key=?",
            (nkey,),
        ).fetchone()
    if not row:
        return None
    return {
        "link_kind":    row[0],
        "tcgplayer_id": row[1],
        "attribute":    row[2],
        "notes":        row[3],
        "tags":         (row[4].split(",") if row[4] else []),
        "condition":    row[5],
        "status":       row[6],
        "listed_at":    row[7],
        "sold_at":      row[8],
        "sale_price":   row[9],
        "updated_at":   row[10],
    }


def all_decisions() -> dict[str, dict]:
    with _open() as conn:
        conn.execute(DDL)
        cur = conn.execute(
            "SELECT natural_key, link_kind, tcgplayer_id, attribute, notes, tags, "
            "condition, status, listed_at, sold_at, sale_price, updated_at FROM decisions"
        )
        return {
            row[0]: {
                "link_kind":    row[1],
                "tcgplayer_id": row[2],
                "attribute":    row[3],
                "notes":        row[4],
                "tags":         (row[5].split(",") if row[5] else []),
                "condition":    row[6],
                "status":       row[7],
                "listed_at":    row[8],
                "sold_at":      row[9],
                "sale_price":   row[10],
                "updated_at":   row[11],
            }
            for row in cur.fetchall()
        }
