"""
Local ↔ Supabase sync for the cloud cockpit.

push: replace YOUR rows in the cloud `cards` table with the current local
      dataset (same sync semantics as a CSV import — cloud mirrors local).
pull: bring tag/condition/keep edits made on the website back into the local
      decision store (by natural key). Last write wins; no merge heroics.

Auth: signs in with SUPABASE_EMAIL / SUPABASE_PASSWORD from .env using the
public anon key — RLS scopes every operation to your own rows.
"""

from __future__ import annotations

import json
import time

import requests

from config import _get  # reuse the .env loader

SUPABASE_URL = _get("SUPABASE_URL", "https://xmcohwtftpmnanootpia.supabase.co")
SUPABASE_ANON = _get("SUPABASE_ANON",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhtY29od3RmdHBtbmFub290cGlhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM2ODU5NTcsImV4cCI6MjA5OTI2MTk1N30.YVOa8JBdaJH9aXXsyUjOhdwKiohj4SZ6rVia36KfP0k")
SUPABASE_EMAIL = _get("SUPABASE_EMAIL")
SUPABASE_PASSWORD = _get("SUPABASE_PASSWORD")

# Columns the website may edit; pull copies these back into local decisions.
_EDITABLE = ("tags", "condition", "keep")


def _sign_in() -> tuple[str, str]:
    if not (SUPABASE_EMAIL and SUPABASE_PASSWORD):
        raise RuntimeError("Set SUPABASE_EMAIL and SUPABASE_PASSWORD in .env "
                           "(the account you use on the website).")
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        headers={"apikey": SUPABASE_ANON, "Content-Type": "application/json"},
        json={"email": SUPABASE_EMAIL, "password": SUPABASE_PASSWORD}, timeout=20)
    if r.status_code != 200:
        raise RuntimeError(f"Supabase sign-in failed: {r.text[:200]}")
    d = r.json()
    return d["access_token"], d["user"]["id"]


def _headers(token: str) -> dict:
    return {"apikey": SUPABASE_ANON, "Authorization": f"Bearer {token}",
            "Content-Type": "application/json"}


def _rows_from_local() -> list[dict]:
    """Build cloud rows from the local server's /api/sell payload (source of truth
    for routing/pricing). Requires the local server to be running."""
    r = requests.get("http://localhost:5050/api/sell", timeout=120)
    if r.status_code == 400:
        requests.post("http://localhost:5050/api/match", timeout=180)
        r = requests.get("http://localhost:5050/api/sell", timeout=120)
    r.raise_for_status()
    return _transform(r.json()["rows"])


def _transform(api_rows: list[dict]) -> list[dict]:
    out = []
    seen = set()
    for row in api_rows:
        nkey = row.get("natural_key") or f"hold-{row['bucket']}-{row['name']}-{row.get('number','')}-{row.get('set','')}"[:120]
        if nkey in seen:
            continue
        seen.add(nkey)
        out.append({
            "natural_key": nkey, "bucket": row["bucket"], "name": row["name"],
            "set_name": row.get("set", ""), "number": row.get("number", ""),
            "variance": row.get("variance", ""), "grade": row.get("grade", "") or "",
            "qty": row.get("qty", 1) or 1,
            "price": row.get("price", 0), "market_price": row.get("market_price", row.get("price", 0)),
            "condition": row.get("condition", "NM") or "NM",
            "channel": row.get("channel", "") or "", "channel_reason": row.get("channel_reason", "") or "",
            "flags": row.get("flags", []) or [], "band": row.get("band", "") or "",
            "psa10": row.get("psa10", 0) or 0, "psa10_real": bool(row.get("psa10_real")),
            "psa10_x": row.get("psa10_x", 0) or 0,
            "shop_trade": row.get("shop_trade", 0) or 0, "shop_cash": row.get("shop_cash", 0) or 0,
            "net_unit": row.get("net_unit", 0) or 0, "net_pct": row.get("net_pct", 0) or 0,
            "grade_flag": bool(row.get("grade_flag")), "grade_gap": row.get("grade_gap", 0) or 0,
            "grade_reason": row.get("grade_reason", "") or "",
            "keep": bool(row.get("keep")), "tags": row.get("tags", []) or [],
            "image_url": row.get("image_url"),
        })
    return out


def push(api_rows: list[dict] = None) -> dict:
    """Mirror the dataset to the cloud. Pass api_rows (the /api/sell rows) to skip
    the localhost round-trip — used when the server pushes from inside itself."""
    token, uid = _sign_in()
    rows = _transform(api_rows) if api_rows is not None else _rows_from_local()
    for r in rows:
        r["user_id"] = uid

    # Replace-all sync: your cloud rows mirror local exactly.
    d = requests.delete(f"{SUPABASE_URL}/rest/v1/cards?user_id=eq.{uid}",
                        headers=_headers(token), timeout=60)
    if d.status_code not in (200, 204):
        raise RuntimeError(f"delete failed: {d.text[:200]}")

    inserted = 0
    for i in range(0, len(rows), 500):
        batch = rows[i:i + 500]
        p = requests.post(f"{SUPABASE_URL}/rest/v1/cards",
                          headers={**_headers(token), "Prefer": "return=minimal"},
                          data=json.dumps(batch), timeout=120)
        if p.status_code not in (200, 201):
            raise RuntimeError(f"insert failed at {i}: {p.text[:300]}")
        inserted += len(batch)
    return {"pushed": inserted, "user": SUPABASE_EMAIL}


def pull() -> dict:
    import session as session_db
    session_db.init_db()
    token, uid = _sign_in()
    edits = []
    for frm in range(0, 20000, 1000):
        g = requests.get(
            f"{SUPABASE_URL}/rest/v1/cards?user_id=eq.{uid}"
            f"&select=natural_key,tags,condition,keep&offset={frm}&limit=1000",
            headers=_headers(token), timeout=60)
        g.raise_for_status()
        chunk = g.json()
        edits.extend(chunk)
        if len(chunk) < 1000:
            break

    applied = 0
    for e in edits:
        nkey = e["natural_key"]
        if nkey.startswith("hold-"):
            continue
        tags = e.get("tags") or []
        cond = e.get("condition") or None
        session_db.update_decision(nkey, tags=tags,
                                   attribute=("personal" if e.get("keep") else None))
        session_db.update_condition(nkey, cond if cond and cond != "NM" else None)
        applied += 1
    return {"pulled": len(edits), "applied": applied}
