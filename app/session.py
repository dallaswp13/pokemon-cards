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
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
)
"""


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

def update_decision(
    nkey: str,
    *,
    link_kind: Optional[str] = "__unset__",
    tcgplayer_id: Optional[str] = "__unset__",
    attribute: Optional[str] = "__unset__",
    notes: Optional[str] = "__unset__",
) -> None:
    """
    Patch one or both axes of a decision. Pass None to clear an axis;
    omit a kwarg to leave it unchanged.
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
            "SELECT link_kind, tcgplayer_id, attribute, notes FROM decisions WHERE natural_key=?",
            (nkey,),
        ).fetchone()
        cur_link, cur_tid, cur_attr, cur_notes = cur if cur else (None, None, None, None)

        new_link  = cur_link  if link_kind    == "__unset__" else link_kind
        new_tid   = cur_tid   if tcgplayer_id == "__unset__" else tcgplayer_id
        new_attr  = cur_attr  if attribute    == "__unset__" else attribute
        new_notes = cur_notes if notes        == "__unset__" else notes

        if new_link is None and new_attr is None and not new_notes:
            conn.execute("DELETE FROM decisions WHERE natural_key=?", (nkey,))
        else:
            conn.execute("""
                INSERT INTO decisions (natural_key, link_kind, tcgplayer_id, attribute, notes, updated_at)
                VALUES (?, ?, ?, ?, ?, datetime('now'))
                ON CONFLICT(natural_key) DO UPDATE SET
                    link_kind    = excluded.link_kind,
                    tcgplayer_id = excluded.tcgplayer_id,
                    attribute    = excluded.attribute,
                    notes        = excluded.notes,
                    updated_at   = excluded.updated_at
            """, (nkey, new_link, new_tid, new_attr, new_notes))
        conn.commit()


def clear_decision(nkey: str) -> None:
    with _open() as conn:
        conn.execute("DELETE FROM decisions WHERE natural_key=?", (nkey,))
        conn.commit()


def get_decision(nkey: str) -> Optional[dict]:
    with _open() as conn:
        conn.execute(DDL)
        row = conn.execute(
            "SELECT link_kind, tcgplayer_id, attribute, notes, updated_at "
            "FROM decisions WHERE natural_key=?",
            (nkey,),
        ).fetchone()
    if not row:
        return None
    return {
        "link_kind":    row[0],
        "tcgplayer_id": row[1],
        "attribute":    row[2],
        "notes":        row[3],
        "updated_at":   row[4],
    }


def all_decisions() -> dict[str, dict]:
    with _open() as conn:
        conn.execute(DDL)
        cur = conn.execute(
            "SELECT natural_key, link_kind, tcgplayer_id, attribute, notes, updated_at FROM decisions"
        )
        return {
            row[0]: {
                "link_kind":    row[1],
                "tcgplayer_id": row[2],
                "attribute":    row[3],
                "notes":        row[4],
                "updated_at":   row[5],
            }
            for row in cur.fetchall()
        }
