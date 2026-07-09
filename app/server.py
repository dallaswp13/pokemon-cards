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

from flask import Flask, Response, jsonify, redirect, request, send_from_directory

sys.path.insert(0, str(Path(__file__).parent))
from matcher import run_match, MatchResult, TcgpRow, load_tcgp  # noqa: E402
from output import export_outputs                               # noqa: E402
import images as images_mod                                     # noqa: E402
import session as session_db                                    # noqa: E402

ROOT      = Path(__file__).parent.parent
INPUTS    = ROOT / "inputs"
OUTPUTS   = ROOT / "outputs"
STATIC    = Path(__file__).parent / "static"

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
            targets.append((m.tcgplayer_id, cat, m.product_name, m.set_name, m.number))

    def _go():
        # Resolve direct CDN URLs (fast, cached) so the cockpit's <img> redirects
        # are instant. Most-valuable cards first (results arrive value-sorted-ish).
        with ThreadPoolExecutor(max_workers=12) as pool:
            for tid, cat, name, sname, num in targets:
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
    h = CURRENT_SESSION["hash"]
    if not h or h not in SESSIONS:
        return jsonify({"error": "no active session — run a match first"}), 400
    s = SESSIONS[h]
    decisions = _decisions_for_session(s)

    rows = []
    for idx, r in enumerate(s["results"]):
        inv = r.inventory_row
        d = decisions.get(idx) or {}
        # Resolve the tcgplayer_id used for the card image.
        tid = None
        if d.get("link_kind") == "confirm" and d.get("tcgplayer_id"):
            tid = d["tcgplayer_id"]
        elif r.matched_row is not None:
            tid = r.matched_row.tcgplayer_id

        route = channels.route_row(inv)
        attr = d.get("attribute")
        rows.append({
            "row_idx":        idx,
            "natural_key":    _natural_key_for(r),
            "name":           inv.product_name,
            "set":            inv.set_name,
            "number":         inv.card_number,
            "variance":       inv.variance,
            "qty":            inv.quantity,
            "price":          round(inv.market_price, 2),
            "category":       inv.category,
            "tcgplayer_id":   tid,
            "channel":        route.channel,
            "channel_reason": route.reason,
            "flags":          route.flags,
            "band":           _price_band(inv.market_price),
            "value_tier":     route.value_tier,
            "card_class":     route.card_class,
            "net_unit":       round(route.rec_net, 2),
            "net_total":      round(route.total_net, 2),
            "net_pct":        round(route.net_pct, 3),
            "sell_now":       route.sell_now,
            "grade_flag":     bool(route.grade and route.grade.grade),
            "grade_gap":      round(route.grade.ev_gap, 2) if route.grade else 0,
            "grade_reason":   route.grade.reason if route.grade else "",
            "keep":           attr == "personal",
            "attribute":      attr,
            "tags":           d.get("tags", []),
        })
    rows.sort(key=lambda x: -x["price"])   # most valuable first (default working order)
    return jsonify({"rows": rows, "count": len(rows), "summary": _sell_summary(rows)})


def _sell_summary(rows: list[dict]) -> dict:
    """Portfolio recovery rollup: net % back, by tier, incl/excl bulk tail, grade queue."""
    sellable = [r for r in rows if not r["keep"]]
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
    keepers = [r for r in rows if r["keep"]]
    consign = [r for r in sellable if r["price"] >= 2000]   # config.Grading.CONSIGN_FLOOR_GRADED
    return {
        "market": mkt, "net": net, "pct": pct,
        "pct_excl_bulk": nbp, "net_excl_bulk": nbn, "market_excl_bulk": nbm,
        "by_tier": tiers,
        "grade_candidates": len(grade_cands),
        "grade_extra": round(sum(r["grade_gap"] for r in grade_cands), 2),
        "consign_eligible": len(consign),
        "keepers": len(keepers),
        "keepers_value": round(sum(r["price"] * r["qty"] for r in keepers), 2),
        "count_sellable": len(sellable),
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
