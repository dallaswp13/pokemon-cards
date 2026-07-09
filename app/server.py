"""
Flask server for the TCGP inventory matcher.

Step 3 scope: serves the static page, accepts an export.csv upload, runs the
matcher against the TCGP files in inputs/, returns counts.
The review UI / session persistence are added in later steps.
"""

import hashlib
import sys
import time
from dataclasses import asdict
from pathlib import Path

from flask import (Flask, Response, jsonify, redirect, request,
                   send_file, send_from_directory)

sys.path.insert(0, str(Path(__file__).parent))
from matcher import run_match, MatchResult, TcgpRow, load_tcgp  # noqa: E402
from output import export_outputs                               # noqa: E402
import images as images_mod                                     # noqa: E402
import session as session_db                                    # noqa: E402

ROOT      = Path(__file__).parent.parent
INPUTS    = ROOT / "inputs"
OUTPUTS   = ROOT / "outputs"
STATIC    = Path(__file__).parent / "static"
PHOTOS    = Path(__file__).parent / "state" / "photos"   # user front/back card photos


def _photo_path(nkey: str, side: str) -> Path:
    return PHOTOS / nkey / f"{side}.jpg"

POKE_PATH = INPUTS / "TCGplayer_pokemon.csv"
MTG_PATH  = INPUTS / "TCGplayer_mtg.csv"

app = Flask(__name__, static_folder=str(STATIC), static_url_path="")

# In-memory session: { export_hash: { results, set_aside, stats, export_path } }
SESSIONS: dict[str, dict] = {}
CURRENT_SESSION: dict[str, str | None] = {"hash": None}

# TCGP rows indexed by tcgplayer_id, loaded once for image lookups
TCGP_BY_ID: dict[str, TcgpRow] = {}


def _load_tcgp_index() -> None:
    if TCGP_BY_ID:
        return
    for path in (POKE_PATH, MTG_PATH):
        if path.exists():
            for r in load_tcgp(str(path)):
                TCGP_BY_ID[r.tcgplayer_id] = r


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _hash_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def _spawn_image_prewarm(results: list[MatchResult]) -> None:
    """
    Fire off a background thread that fetches a 200×200 image for every
    auto-matched card, populating the disk cache so the spreadsheet renders
    fast. Limited concurrency so we don't hammer Scryfall / Pokemon TCG API.
    """
    import threading
    from concurrent.futures import ThreadPoolExecutor

    targets = []
    for r in results:
        if r.confidence == "auto" and r.matched_row is not None:
            m = r.matched_row
            pl = (m.raw.get("Product Line") or "").lower() if m.raw else ""
            cat = "Magic: The Gathering" if pl == "magic" else "Pokemon"
            targets.append((r.inventory_row.market_price, m.tcgplayer_id, cat,
                            m.product_name, m.set_name, m.number))
    # Resolve the most valuable cards first (that's what the cockpit shows) and
    # cap the batch — keyless pokemontcg.io rate-limits, so don't burn the quota
    # on the sub-$1 tail; those resolve on-demand when actually viewed.
    targets.sort(key=lambda t: -t[0])
    targets = targets[:500]

    def _go():
        with ThreadPoolExecutor(max_workers=8) as pool:
            for _, tid, cat, name, sname, num in targets:
                pool.submit(images_mod.resolve_image_url, tid, cat, name, sname, num)

    threading.Thread(target=_go, daemon=True).start()


def _decisions_for_session(s: dict) -> dict[int, dict]:
    """
    Return { row_idx: decision-dict } by joining the in-memory match results
    against the global decision store via each row's natural key.
    """
    nkeys = [_natural_key_for(r) for r in s["results"]]
    all_d = session_db.all_decisions()
    return {idx: all_d[k] for idx, k in enumerate(nkeys) if k in all_d}


def _natural_key_for(r: MatchResult) -> str:
    inv = r.inventory_row
    return session_db.natural_key(
        category=inv.category, set_name=inv.set_name,
        card_number=inv.card_number, variance=inv.variance,
        product_name=inv.product_name,
    )


def _serialize_result(r: MatchResult, row_idx: int) -> dict:
    inv = r.inventory_row
    return {
        "row_idx":     row_idx,
        "natural_key": _natural_key_for(r),
        "confidence":  r.confidence,
        "reason":      r.reason,
        "inventory": {
            "category":     inv.category,
            "set_name":     inv.set_name,
            "product_name": inv.product_name,
            "card_number":  inv.card_number,
            "variance":     inv.variance,
            "quantity":     inv.quantity,
            "market_price": inv.market_price,
        },
        "matched_id": r.matched_row.tcgplayer_id if r.matched_row else None,
        "candidates": [_serialize_tcgp(c) for c in r.candidates],
    }


def _serialize_tcgp(c: TcgpRow) -> dict:
    return {
        "tcgplayer_id": c.tcgplayer_id,
        "set_name":     c.set_name,
        "product_name": c.product_name,
        "number":       c.number,
        "condition":    c.condition,
        "photo_url":    c.photo_url,
    }


# ---------------------------------------------------------------------------
# Routes — static
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return send_from_directory(STATIC, "index.html")


# ---------------------------------------------------------------------------
# Routes — API
# ---------------------------------------------------------------------------

@app.route("/api/match", methods=["POST"])
def api_match():
    """
    Run the matcher.  Two ways to invoke:
      - multipart upload with file 'export'  → saves to inputs/, hashes, runs
      - empty POST                           → re-runs against inputs/export.csv
    """
    if "export" in request.files:
        f = request.files["export"]
        dst = INPUTS / "export.csv"
        f.save(dst)
        export_path = dst
    else:
        export_path = INPUTS / "export.csv"
        if not export_path.exists():
            return jsonify({"error": "no export.csv in inputs/ — upload one first"}), 400

    if not POKE_PATH.exists() or not MTG_PATH.exists():
        return jsonify({
            "error": f"missing TCGP files in inputs/: "
                     f"pokemon={POKE_PATH.exists()} mtg={MTG_PATH.exists()}"
        }), 500

    t0 = time.perf_counter()
    results, set_aside, stats = run_match(str(export_path), str(POKE_PATH), str(MTG_PATH))
    elapsed = time.perf_counter() - t0

    # Pre-warm the image cache for matched cards so the spreadsheet loads
    # quickly. Runs in a background thread; doesn't block the response.
    _spawn_image_prewarm(results)

    export_hash = _hash_file(export_path)
    SESSIONS[export_hash] = {
        "results": results,
        "set_aside": set_aside,
        "stats": stats,
        "export_path": str(export_path),
        # legacy field — decisions are now stored globally, not per-session
        "db_path": None,
    }
    CURRENT_SESSION["hash"] = export_hash

    return jsonify({
        "session": export_hash,
        "elapsed_seconds": round(elapsed, 3),
        "stats": stats,
    })


@app.route("/api/state")
def api_state():
    h = CURRENT_SESSION["hash"]
    if not h or h not in SESSIONS:
        return jsonify({"session": None})
    s = SESSIONS[h]
    return jsonify({
        "session": h,
        "stats": s["stats"],
    })


@app.route("/api/results")
def api_results():
    """
    Returns serialized results for a given confidence bucket.
    Query: ?confidence=auto|review|unmatched  (default: review)
    """
    h = CURRENT_SESSION["hash"]
    if not h or h not in SESSIONS:
        return jsonify({"error": "no active session"}), 400

    confidence = request.args.get("confidence", "review")
    if confidence not in ("auto", "review", "unmatched"):
        return jsonify({"error": f"invalid confidence '{confidence}'"}), 400

    results = SESSIONS[h]["results"]
    filtered = [
        _serialize_result(r, idx)
        for idx, r in enumerate(results)
        if r.confidence == confidence
    ]
    return jsonify({"confidence": confidence, "rows": filtered})


@app.route("/api/image/<tid>")
def api_image(tid: str):
    """
    Resolve the card's direct CDN image URL and 302-redirect the browser to it,
    so images load from the CDN in parallel instead of being proxied (byte-by-
    byte) through this dev server. URLs are cached (+negative-cached) on disk and
    pre-warmed after each match.
    """
    _load_tcgp_index()
    row = TCGP_BY_ID.get(tid)
    if row is None:
        return Response("unknown tcgplayer_id", status=404)

    pl = (row.raw.get("Product Line") or "").lower() if row.raw else ""
    category = "Magic: The Gathering" if pl == "magic" else "Pokemon"

    url = images_mod.resolve_image_url(tid, category, row.product_name,
                                       row.set_name, row.number)
    if not url:
        return Response("not found", status=404)
    resp = redirect(url, code=302)
    resp.headers["Cache-Control"] = "public, max-age=86400"
    return resp


@app.route("/api/review")
def api_review():
    """
    Linking queue. Returns review or unmatched rows for the linking UI.
    Query: ?filter=review|unmatched  (default: review)
    """
    h = CURRENT_SESSION["hash"]
    if not h or h not in SESSIONS:
        return jsonify({"error": "no active session"}), 400

    flt = request.args.get("filter", "review")
    if flt not in ("review", "unmatched"):
        return jsonify({"error": f"invalid filter '{flt}'"}), 400

    s = SESSIONS[h]
    decisions = _decisions_for_session(s)

    rows = []
    for idx, r in enumerate(s["results"]):
        if r.confidence != flt:
            continue
        d = decisions.get(idx)
        out = _serialize_result(r, idx)
        rows.append({**out, "decision": d, "filter": flt})
    return jsonify({"rows": rows, "filter": flt})


@app.route("/api/matched")
def api_matched():
    """
    Return all rows that have a matched TCGP product (auto + user-confirmed),
    each with its current attribute decision, for the spreadsheet view.
    """
    h = CURRENT_SESSION["hash"]
    if not h or h not in SESSIONS:
        return jsonify({"error": "no active session"}), 400

    s = SESSIONS[h]
    decisions = _decisions_for_session(s)

    rows = []
    for idx, r in enumerate(s["results"]):
        d = decisions.get(idx)
        # Resolve the effective matched candidate: user-confirmed > matcher's pick.
        # link_kind='skip' means "no match" → not a matched row.
        if d and d.get("link_kind") == "skip":
            continue
        matched = None
        if d and d.get("link_kind") == "confirm" and d.get("tcgplayer_id"):
            matched = next(
                (c for c in r.candidates if c.tcgplayer_id == d["tcgplayer_id"]),
                None,
            )
        elif r.confidence == "auto" and r.matched_row is not None:
            matched = r.matched_row

        if matched is None:
            continue  # only matched rows show up in the spreadsheet

        attribute = d.get("attribute") if d else None
        attribute = attribute or "for_sale"

        rows.append({
            "row_idx":      idx,
            "natural_key":  _natural_key_for(r),
            "inv_name":     r.inventory_row.product_name,
            "inv_set":      r.inventory_row.set_name,
            "inv_number":   r.inventory_row.card_number,
            "variance":     r.inventory_row.variance,
            "quantity":     r.inventory_row.quantity,
            "market_price": r.inventory_row.market_price,
            "tcgplayer_id": matched.tcgplayer_id,
            "matched_name": matched.product_name,
            "matched_set":  matched.set_name,
            "matched_num":  matched.number,
            "condition":    matched.condition,
            "attribute":    attribute,
            "source":       r.confidence,  # 'auto' or 'review' (user confirmed)
        })
    return jsonify({"rows": rows})


def _price_band(price: float) -> str:
    if price < 1:   return "u1"
    if price < 5:   return "1_5"
    if price < 50:  return "5_50"
    return "o50"


@app.route("/api/sell")
def api_sell():
    """Enriched rows for the visual Sell Cockpit: route + price band + image + tags."""
    import channels
    from config import CONDITION_FACTORS
    h = CURRENT_SESSION["hash"]
    if not h or h not in SESSIONS:
        return jsonify({"error": "no active session — run a match first"}), 400
    s = SESSIONS[h]
    decisions = _decisions_for_session(s)

    rows = []
    keeper_ct, keeper_val = 0, 0.0
    for idx, r in enumerate(s["results"]):
        inv = r.inventory_row
        d = decisions.get(idx) or {}
        cond = d.get("condition") or "NM"
        effective = inv.market_price * CONDITION_FACTORS.get(cond, 1.0)
        tags = d.get("tags", [])

        # Keepers now live in Holds — keep them out of the sell grid.
        if d.get("attribute") == "personal":
            keeper_ct += 1
            keeper_val += effective * inv.quantity
            continue

        tid = None
        if d.get("link_kind") == "confirm" and d.get("tcgplayer_id"):
            tid = d["tcgplayer_id"]
        elif r.matched_row is not None:
            tid = r.matched_row.tcgplayer_id
        img_url = (images_mod.resolve_image_url(tid, inv.category, inv.product_name,
                   inv.set_name, inv.card_number, cached_only=True) if tid else None)

        route = channels.route_row(inv, price=effective)
        nkey = _natural_key_for(r)

        # Off-center deters grading (gem rate collapses) → never a grade candidate.
        off_center = "off-center" in tags
        would_grade = bool(route.grade and route.grade.grade)
        grade_flag = would_grade and not off_center
        grade_reason = ("off-center — not a grading candidate" if (off_center and would_grade)
                        else (route.grade.reason if route.grade else ""))
        rows.append({
            "row_idx":        idx,
            "natural_key":    nkey,
            "name":           inv.product_name,
            "set":            inv.set_name,
            "number":         inv.card_number,
            "variance":       inv.variance,
            "qty":            inv.quantity,
            "price":          round(effective, 2),
            "market_price":   round(inv.market_price, 2),
            "condition":      cond,
            "category":       inv.category,
            "tcgplayer_id":   tid,
            "image_url":      img_url,
            "channel":        route.channel,
            "channel_reason": route.reason,
            "flags":          route.flags,
            "band":           _price_band(effective),
            "value_tier":     route.value_tier,
            "card_class":     route.card_class,
            "psa10":          route.psa10,
            "psa10_pct":      route.psa10_pct,
            "shop_trade":     route.shop_trade,
            "shop_cash":      route.shop_cash,
            "net_unit":       round(route.rec_net, 2),
            "net_total":      round(route.total_net, 2),
            "net_pct":        round(route.net_pct, 3),
            "sell_now":       route.sell_now,
            "grade_flag":     grade_flag,
            "grade_gap":      0 if off_center else (round(route.grade.ev_gap, 2) if route.grade else 0),
            "grade_reason":   grade_reason,
            "off_center":     off_center,
            "keep":           False,
            "attribute":      d.get("attribute"),
            "tags":           tags,
            "status":         d.get("status"),
            "sale_price":     d.get("sale_price"),
            "listed_at":      d.get("listed_at"),
            "sold_at":        d.get("sold_at"),
            "has_front":      _photo_path(nkey, "front").exists(),
            "has_back":       _photo_path(nkey, "back").exists(),
        })
    rows.sort(key=lambda x: -x["price"])   # most valuable first (default working order)
    return jsonify({"rows": rows, "count": len(rows),
                    "summary": _sell_summary(rows, keeper_ct, round(keeper_val, 2))})


def _sell_summary(rows: list[dict], keepers_count: int = 0, keepers_value: float = 0.0) -> dict:
    """Portfolio recovery rollup: net % back, by tier, incl/excl bulk tail, grade queue.
    Keepers are excluded from `rows` (they're in Holds); counts come in as args."""
    sellable = rows
    def agg(rs):
        mkt = sum(r["price"] * r["qty"] for r in rs)
        net = sum(r["net_total"] for r in rs)
        return round(mkt, 2), round(net, 2), (round(net / mkt, 3) if mkt else 0)

    mkt, net, pct = agg(sellable)
    tiers = {}
    for tier in ("HIGH", "MID", "LOW", "BULK"):
        tm, tn, tp = agg([r for r in sellable if r["value_tier"] == tier])
        tiers[tier] = {"market": tm, "net": tn, "pct": tp}
    non_bulk = [r for r in sellable if r["channel"] != "Bulk lot"]
    nbm, nbn, nbp = agg(non_bulk)

    grade_cands = [r for r in sellable if r["grade_flag"]]
    consign = [r for r in sellable if r["price"] >= 2000]   # config.Grading.CONSIGN_FLOOR_GRADED

    # Ledger — actuals as you sell down.
    sold = [r for r in rows if r.get("status") == "sold"]
    listed = [r for r in rows if r.get("status") == "listed"]
    realized = round(sum((r.get("sale_price") or 0) for r in sold), 2)
    market_sold = round(sum(r["price"] * r["qty"] for r in sold), 2)
    return {
        "market": mkt, "net": net, "pct": pct,
        "pct_excl_bulk": nbp, "net_excl_bulk": nbn, "market_excl_bulk": nbm,
        "by_tier": tiers,
        "grade_candidates": len(grade_cands),
        "grade_extra": round(sum(r["grade_gap"] for r in grade_cands), 2),
        "consign_eligible": len(consign),
        "keepers": keepers_count,
        "keepers_value": keepers_value,
        "count_sellable": len(sellable),
        "listed": len(listed),
        "sold": len(sold),
        "realized": realized,
        "market_sold": market_sold,
        "realized_pct": round(realized / market_sold, 3) if market_sold else 0,
        "unlisted_sellable": sum(1 for r in sellable if not r.get("status")),
    }


@app.route("/api/tag", methods=["POST"])
def api_tag():
    """
    Patch sell-cockpit state for one row.
    Body: { row_idx, tags?: [str], keep?: bool }
    """
    h = CURRENT_SESSION["hash"]
    if not h or h not in SESSIONS:
        return jsonify({"error": "no active session"}), 400
    body = request.get_json(silent=True) or {}
    row_idx = body.get("row_idx")
    if row_idx is None or not (0 <= int(row_idx) < len(SESSIONS[h]["results"])):
        return jsonify({"error": "row_idx required / out of range"}), 400

    nkey = _natural_key_for(SESSIONS[h]["results"][int(row_idx)])
    kwargs = {}
    if "tags" in body:
        kwargs["tags"] = body["tags"]
    if "keep" in body:
        kwargs["attribute"] = "personal" if body["keep"] else None
    if not kwargs:
        return jsonify({"error": "nothing to update"}), 400
    session_db.update_decision(nkey, **kwargs)
    return jsonify({"ok": True})


def _row_nkey(row_idx):
    h = CURRENT_SESSION["hash"]
    if not h or h not in SESSIONS:
        return None, (jsonify({"error": "no active session"}), 400)
    if row_idx is None or not (0 <= int(row_idx) < len(SESSIONS[h]["results"])):
        return None, (jsonify({"error": "row_idx required / out of range"}), 400)
    return _natural_key_for(SESSIONS[h]["results"][int(row_idx)]), None


@app.route("/api/status", methods=["POST"])
def api_status():
    """Ledger: mark a card listed/sold and record a sale price.
    Body: { row_idx, status?: 'listed'|'sold'|null, sale_price?: number }"""
    body = request.get_json(silent=True) or {}
    nkey, err = _row_nkey(body.get("row_idx"))
    if err:
        return err
    kwargs = {}
    if "status" in body:
        kwargs["status"] = body["status"] or None
    if "sale_price" in body:
        try:
            kwargs["sale_price"] = float(body["sale_price"]) if body["sale_price"] not in (None, "") else None
        except (ValueError, TypeError):
            kwargs["sale_price"] = None
    try:
        session_db.update_listing(nkey, **kwargs)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"ok": True})


@app.route("/api/photo", methods=["POST"])
def api_photo():
    """Upload a front/back photo for a card. multipart: row_idx, side, photo(file)."""
    side = request.form.get("side")
    if side not in ("front", "back"):
        return jsonify({"error": "side must be 'front' or 'back'"}), 400
    try:
        row_idx = int(request.form.get("row_idx"))
    except (TypeError, ValueError):
        return jsonify({"error": "row_idx required"}), 400
    nkey, err = _row_nkey(row_idx)
    if err:
        return err
    f = request.files.get("photo")
    if not f:
        return jsonify({"error": "no photo file"}), 400
    p = _photo_path(nkey, side)
    p.parent.mkdir(parents=True, exist_ok=True)
    f.save(str(p))
    return jsonify({"ok": True, "side": side})


@app.route("/api/photo/<nkey>/<side>", methods=["GET"])
def api_get_photo(nkey: str, side: str):
    if side not in ("front", "back"):
        return Response("bad side", status=404)
    p = _photo_path(nkey, side)
    if not p.exists():
        return Response("no photo", status=404)
    return send_file(str(p), mimetype="image/jpeg")


@app.route("/api/photo/<nkey>/<side>", methods=["DELETE"])
def api_delete_photo(nkey: str, side: str):
    p = _photo_path(nkey, side)
    if p.exists():
        p.unlink()
    return jsonify({"ok": True})


@app.route("/api/condition", methods=["POST"])
def api_condition():
    """Set a card's condition (NM/LP/MP/HP/DMG). Body: { row_idx, condition }"""
    body = request.get_json(silent=True) or {}
    nkey, err = _row_nkey(body.get("row_idx"))
    if err:
        return err
    try:
        session_db.update_condition(nkey, body.get("condition") or None)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"ok": True})


@app.route("/api/holds")
def api_holds():
    """Long-term holds: graded + sealed (set aside) + keepers (★ marked personal)."""
    import images as im
    from config import CONDITION_FACTORS
    h = CURRENT_SESSION["hash"]
    if not h or h not in SESSIONS:
        return jsonify({"error": "no active session"}), 400
    s = SESSIONS[h]
    items = []
    for row in s["set_aside"]:
        reason = row.get("_reason", "")
        if reason not in ("graded", "sealed"):
            continue
        name = (row.get("Product Name") or "").strip()
        setn = (row.get("Set") or "").strip()
        num = (row.get("Card Number") or "").strip()
        try:
            qty = int(row.get("Quantity", 1) or 1)
        except ValueError:
            qty = 1
        img = None
        if reason == "graded" and row.get("Category") == "Pokemon":
            img = im.resolve_image_url("hold-" + name + num, "Pokemon", name, setn, num, cached_only=True)
        items.append({
            "name": name, "set": setn, "number": num, "grade": row.get("Grade", ""),
            "reason": reason, "qty": qty,
            "value": round(float(row.get("_market_value", 0) or 0), 2), "image_url": img,
        })

    # Keepers — raw singles the user ★-marked as personal.
    decisions = _decisions_for_session(s)
    for idx, r in enumerate(s["results"]):
        d = decisions.get(idx) or {}
        if d.get("attribute") != "personal":
            continue
        inv = r.inventory_row
        eff = inv.market_price * CONDITION_FACTORS.get(d.get("condition") or "NM", 1.0)
        tid = d.get("tcgplayer_id") or (r.matched_row.tcgplayer_id if r.matched_row else None)
        img = im.resolve_image_url(tid, inv.category, inv.product_name, inv.set_name,
                                   inv.card_number, cached_only=True) if tid else None
        items.append({
            "name": inv.product_name, "set": inv.set_name, "number": inv.card_number,
            "grade": d.get("condition") or "", "reason": "keeper", "qty": inv.quantity,
            "value": round(eff * inv.quantity, 2), "image_url": img,
        })

    items.sort(key=lambda x: -x["value"])
    return jsonify({
        "items": items, "count": len(items),
        "total": round(sum(i["value"] for i in items), 2),
        "graded": sum(1 for i in items if i["reason"] == "graded"),
        "sealed": sum(1 for i in items if i["reason"] == "sealed"),
        "keepers": sum(1 for i in items if i["reason"] == "keeper"),
    })


@app.route("/api/manifest", methods=["POST"])
def api_manifest():
    """
    Write a card-shop drop-off manifest (CSV) of cards tagged for the shop — your
    valuations + the shop's trade/cash values, so you drop off with a printout and
    they price against it. Body: { tag?: 'shop' }
    """
    import fees
    import csv as _csv
    from config import CONDITION_FACTORS
    from datetime import date
    h = CURRENT_SESSION["hash"]
    if not h or h not in SESSIONS:
        return jsonify({"error": "no active session"}), 400
    body = request.get_json(silent=True) or {}
    tag = (body.get("tag") or "shop").lower()
    s = SESSIONS[h]
    decisions = _decisions_for_session(s)

    picks = []
    for idx, r in enumerate(s["results"]):
        d = decisions.get(idx) or {}
        if tag not in (d.get("tags") or []) or d.get("attribute") == "personal":
            continue
        inv = r.inventory_row
        cond = d.get("condition") or "NM"
        eff = inv.market_price * CONDITION_FACTORS.get(cond, 1.0)
        picks.append((inv, cond, eff))
    picks.sort(key=lambda x: -x[2])

    path = OUTPUTS / f"shop_manifest_{date.today().strftime('%Y%m%d')}.csv"
    path.parent.mkdir(parents=True, exist_ok=True)
    tot_v = tot_t = tot_c = 0.0
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = _csv.writer(f, lineterminator="\r\n")
        w.writerow(["Card", "Set", "Number", "Condition", "Your Value",
                    "Trade (store credit)", "Cash"])
        for inv, cond, eff in picks:
            tr, ca = round(fees.shop_trade(eff), 2), round(fees.shop_cash(eff), 2)
            tot_v += eff; tot_t += tr; tot_c += ca
            w.writerow([inv.product_name, inv.set_name, inv.card_number, cond,
                        f"{eff:.2f}", f"{tr:.2f}", f"{ca:.2f}"])
        w.writerow(["TOTAL", "", "", "", f"{tot_v:.2f}", f"{tot_t:.2f}", f"{tot_c:.2f}"])
    return jsonify({"path": str(path), "count": len(picks),
                    "total_value": round(tot_v, 2), "total_trade": round(tot_t, 2),
                    "total_cash": round(tot_c, 2)})


@app.route("/api/decide", methods=["POST"])
def api_decide():
    """
    Patch a decision. Two orthogonal axes — patch one or both.

    Body: { row_idx: int,
            link?: 'confirm'|'skip'|null,
            tcgplayer_id?: str,
            attribute?: 'personal'|'psa'|'bad'|'ignore'|'for_sale'|null }

    'for_sale' is treated as null (clears the attribute / default state).
    Omitted fields are left unchanged.
    """
    h = CURRENT_SESSION["hash"]
    if not h or h not in SESSIONS:
        return jsonify({"error": "no active session"}), 400

    body = request.get_json(silent=True) or {}
    row_idx = body.get("row_idx")
    if row_idx is None:
        return jsonify({"error": "row_idx required"}), 400

    s = SESSIONS[h]
    if not (0 <= row_idx < len(s["results"])):
        return jsonify({"error": "row_idx out of range"}), 400

    kwargs = {}
    if "link" in body:
        kwargs["link_kind"] = body["link"]  # may be None to clear
        kwargs["tcgplayer_id"] = body.get("tcgplayer_id")
    if "attribute" in body:
        attr = body["attribute"]
        kwargs["attribute"] = None if attr in (None, "for_sale", "") else attr

    if not kwargs:
        return jsonify({"error": "nothing to update — pass 'link' and/or 'attribute'"}), 400

    nkey = _natural_key_for(s["results"][row_idx])
    try:
        session_db.update_decision(nkey, **kwargs)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"ok": True})


@app.route("/api/decide", methods=["DELETE"])
def api_undecide():
    """Clear a decision. Body: { row_idx: int }"""
    h = CURRENT_SESSION["hash"]
    if not h or h not in SESSIONS:
        return jsonify({"error": "no active session"}), 400
    body = request.get_json(silent=True) or {}
    row_idx = body.get("row_idx")
    if row_idx is None:
        return jsonify({"error": "row_idx required"}), 400
    s = SESSIONS[h]
    if not (0 <= int(row_idx) < len(s["results"])):
        return jsonify({"error": "row_idx out of range"}), 400
    nkey = _natural_key_for(s["results"][int(row_idx)])
    session_db.clear_decision(nkey)
    return jsonify({"ok": True})


@app.route("/api/progress")
def api_progress():
    h = CURRENT_SESSION["hash"]
    if not h or h not in SESSIONS:
        return jsonify({"error": "no active session"}), 400
    s = SESSIONS[h]
    decisions = _decisions_for_session(s)
    review_idxs = {i for i, r in enumerate(s["results"]) if r.confidence == "review"}
    decided_review = sum(
        1 for i, d in decisions.items()
        if i in review_idxs and d.get("link_kind")
    )
    link_counts: dict[str, int] = {}
    attr_counts: dict[str, int] = {}
    for d in decisions.values():
        if d.get("link_kind"):
            link_counts[d["link_kind"]] = link_counts.get(d["link_kind"], 0) + 1
        if d.get("attribute"):
            attr_counts[d["attribute"]] = attr_counts.get(d["attribute"], 0) + 1
    return jsonify({
        "review_total":     len(review_idxs),
        "review_decided":   decided_review,
        "link_counts":      link_counts,
        "attribute_counts": attr_counts,
    })


@app.route("/api/export", methods=["POST"])
def api_export():
    """
    Write the filled TCGP CSVs and reports.
    Includes auto-matched rows + review rows the user has 'confirm'-ed.
    Personal / psa / bad / skip rows are NOT exported (they go to set-aside
    in step 6).
    """
    h = CURRENT_SESSION["hash"]
    if not h or h not in SESSIONS:
        return jsonify({"error": "no active session"}), 400

    s = SESSIONS[h]
    decisions = _decisions_for_session(s)

    # A row goes to TCGP output iff:
    #   - it has a matched candidate (user-confirmed link OR matcher's auto pick), AND
    #   - link_kind is not 'skip' (no-match), AND
    #   - attribute is not set (i.e. it's "for sale" — not personal/psa/bad/ignore)
    import channels
    augmented: list[MatchResult] = []
    for idx, r in enumerate(s["results"]):
        d = decisions.get(idx)

        if d and d.get("attribute"):
            # Personal/PSA/bad/ignore → exclude from TCGP output
            continue
        if d and d.get("link_kind") == "skip":
            continue

        # Only cards ROUTED to TCGplayer (or manually tagged 'tcgplayer') belong in
        # the TCGP upload sheet — eBay/bulk cards are sold elsewhere.
        tags = (d or {}).get("tags", [])
        if channels.route_row(r.inventory_row).channel != "TCGplayer" and "tcgplayer" not in tags:
            continue

        if d and d.get("link_kind") == "confirm" and d.get("tcgplayer_id"):
            chosen = next(
                (c for c in r.candidates if c.tcgplayer_id == d["tcgplayer_id"]),
                None,
            )
            if chosen is None:
                continue
            augmented.append(MatchResult(
                inventory_row=r.inventory_row,
                confidence="auto",
                candidates=[chosen],
                matched_row=chosen,
                reason="user-confirmed",
            ))
            continue

        if r.confidence == "auto" and r.matched_row is not None:
            augmented.append(r)

    out = export_outputs(
        results=augmented,
        set_aside_rows=s["set_aside"],
        pokemon_src=str(POKE_PATH),
        mtg_src=str(MTG_PATH),
        out_dir=str(OUTPUTS),
    )
    return jsonify(out)


# ---------------------------------------------------------------------------

session_db.init_db()  # ensure global decisions table exists at boot

if __name__ == "__main__":
    # 5050 chosen to avoid macOS AirPlay Receiver, which hijacks 5000.
    # Debug + reloader off — when the .app launcher waits on the parent PID,
    # Flask's reloader fork can leave the child server running while the parent
    # exits, racing with the launcher's "open browser" step. A plain server
    # with a single process is much more reliable for the user-facing app.
    import os
    debug = os.environ.get("TCGP_DEBUG") == "1"
    app.run(host="127.0.0.1", port=5050, debug=debug, use_reloader=False)
