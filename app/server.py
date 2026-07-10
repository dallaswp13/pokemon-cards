"""
Flask server for the TCGP inventory matcher.

Step 3 scope: serves the static page, accepts an export.csv upload, runs the
matcher against the TCGP files in inputs/, returns counts.
The review UI / session persistence are added in later steps.
"""

import hashlib
import json
import sys
import time
from dataclasses import asdict
from pathlib import Path

from flask import (Flask, Response, jsonify, redirect, request,
                   send_file, send_from_directory)

sys.path.insert(0, str(Path(__file__).parent))
from matcher import (run_match, MatchResult, TcgpRow, load_tcgp, load_export,  # noqa: E402
                     InventoryRow, SEALED_KEYWORDS, SEALED_BRACKET_PATTERN)
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
        with ThreadPoolExecutor(max_workers=12) as pool:
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
    return _nkey_inv(r.inventory_row)


def _nkey_inv(inv: InventoryRow) -> str:
    return session_db.natural_key(
        category=inv.category, set_name=inv.set_name,
        card_number=inv.card_number, variance=inv.variance,
        product_name=inv.product_name,
    )


def _inv_from_raw(row: dict) -> InventoryRow:
    """Build an InventoryRow from a raw export dict (for filtered-out categories)."""
    mk = next((k for k in row if k.startswith("Market Price")), None)
    try:
        price = float(row.get(mk, 0) or 0) if mk else 0.0
    except ValueError:
        price = 0.0
    try:
        qty = int(row.get("Quantity", 0) or 0)
    except ValueError:
        qty = 0
    return InventoryRow(
        raw=row, category=(row.get("Category") or "").strip(),
        set_name=(row.get("Set") or "").strip(),
        product_name=(row.get("Product Name") or "").strip(),
        card_number=(row.get("Card Number") or "").strip(),
        variance=(row.get("Variance") or "").strip(),
        grade=(row.get("Grade") or "Ungraded").strip(),
        quantity=qty, market_price=price,
    )


def _build_cockpit(results: list, export_path: str) -> tuple[list[dict], list[dict]]:
    """
    Combined sell-cockpit rows across every bucket the tabs show.
    Returns (cockpit, extra_holds):
      cockpit: [{inv, tid, bucket('pkmn'|'mtg'|'ygo'), xflags}] — matcher rows first
               (indices align with `results`), then filtered-out extras (YGO,
               Japanese Pokémon, MTG art cards).
      extra_holds: graded/sealed rows found among the extras (e.g. graded JP slabs).
    """
    cockpit: list[dict] = []
    for r in results:
        inv = r.inventory_row
        cockpit.append({
            "inv": inv,
            "tid": r.matched_row.tcgplayer_id if r.matched_row else None,
            "bucket": "pkmn" if inv.category == "Pokemon" else "mtg",
            "xflags": [],
        })

    extra_holds: list[dict] = []
    _, _, filtered_out, _ = load_export(export_path)
    for row in filtered_out:
        inv = _inv_from_raw(row)
        reason = row.get("_reason", "")
        if inv.grade and inv.grade != "Ungraded":
            extra_holds.append({**row, "_reason": "graded",
                                "_market_value": inv.market_price * (inv.quantity or 1)})
            continue
        if SEALED_KEYWORDS.search(inv.product_name) or SEALED_BRACKET_PATTERN.search(inv.product_name):
            extra_holds.append({**row, "_reason": "sealed",
                                "_market_value": inv.market_price * (inv.quantity or 1)})
            continue
        if inv.category == "YuGiOh":
            cockpit.append({"inv": inv, "tid": None, "bucket": "ygo", "xflags": []})
        elif reason == "Japanese Pokemon set":
            cockpit.append({"inv": inv, "tid": None, "bucket": "pkmn", "xflags": ["japanese"]})
        elif reason == "MTG art card":
            cockpit.append({"inv": inv, "tid": None, "bucket": "mtg", "xflags": ["art-card"]})
    return cockpit, extra_holds


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

    cockpit, extra_holds = _build_cockpit(results, str(export_path))

    export_hash = _hash_file(export_path)
    SESSIONS[export_hash] = {
        "results": results,
        "set_aside": set_aside + extra_holds,
        "cockpit": cockpit,
        "stats": stats,
        "export_path": str(export_path),
        # legacy field — decisions are now stored globally, not per-session
        "db_path": None,
    }
    CURRENT_SESSION["hash"] = export_hash

    # Import = sync: a fresh upload is the source of truth. Decisions for cards
    # no longer in the export are removed; tags on surviving cards persist.
    if "export" in request.files:
        current = {_nkey_inv(c["inv"]) for c in cockpit}
        stats["pruned_decisions"] = session_db.prune_missing(current)

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


def _load_live_prices() -> dict:
    from config import DATA_DIR
    p = DATA_DIR / "live_prices.json"
    if p.exists():
        try:
            return json.loads(p.read_text())
        except Exception:
            return {}
    return {}


@app.route("/api/sell")
def api_sell():
    """All tab rows for the Sell Cockpit: pkmn/mtg/ygo raw (actionable) +
    graded/sealed (display) with live-price overlay and per-bucket totals."""
    import channels
    from config import CONDITION_FACTORS
    h = CURRENT_SESSION["hash"]
    if not h or h not in SESSIONS:
        return jsonify({"error": "no active session — run a match first"}), 400
    s = SESSIONS[h]
    live = _load_live_prices()
    all_dec = session_db.all_decisions()

    rows = []
    for idx, c in enumerate(s.get("cockpit") or []):
        inv = c["inv"]
        nkey = _nkey_inv(inv)
        d = all_dec.get(nkey) or {}
        tags = d.get("tags", [])
        cond = d.get("condition") or "NM"

        lp = live.get(nkey) or {}
        market = lp.get("market") or inv.market_price
        effective = market * CONDITION_FACTORS.get(cond, 1.0)

        tid = d.get("tcgplayer_id") if d.get("link_kind") == "confirm" else None
        tid = tid or c["tid"]
        img_url = (images_mod.resolve_image_url(tid, inv.category, inv.product_name,
                   inv.set_name, inv.card_number, cached_only=True) if tid else None)

        route = channels.route_row(inv, price=effective)

        # PSA-10: real (PriceCharting, via Update Prices) beats the class estimate.
        psa10_real = bool(lp.get("psa10"))
        psa10 = lp.get("psa10") or route.psa10

        # Off-center deters grading (gem rate collapses) → never a grade candidate.
        off_center = "off-center" in tags
        would_grade = bool(route.grade and route.grade.grade)
        grade_flag = would_grade and not off_center
        grade_reason = ("off-center — not a grading candidate" if (off_center and would_grade)
                        else (route.grade.reason if route.grade else ""))
        rows.append({
            "row_idx":        idx,
            "natural_key":    nkey,
            "bucket":         c["bucket"],
            "name":           inv.product_name,
            "set":            inv.set_name,
            "number":         inv.card_number,
            "variance":       inv.variance,
            "qty":            inv.quantity,
            "price":          round(effective, 2),
            "market_price":   round(market, 2),
            "price_is_live":  bool(lp.get("market")),
            "condition":      cond,
            "category":       inv.category,
            "tcgplayer_id":   tid,
            "image_url":      img_url,
            "channel":        route.channel,
            "channel_reason": route.reason,
            "flags":          route.flags + c["xflags"],
            "band":           _price_band(effective),
            "value_tier":     route.value_tier,
            "card_class":     route.card_class,
            "psa10":          round(psa10, 2) if psa10 else 0,
            "psa10_real":     psa10_real,
            "psa10_x":        round(psa10 / effective, 1) if (psa10 and effective) else 0,
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
            "not_nm":         "not-nm" in tags,
            "keep":           d.get("attribute") == "personal",
            "tags":           tags,
            "has_front":      _photo_path(nkey, "front").exists(),
            "has_back":       _photo_path(nkey, "back").exists(),
        })

    # Graded + sealed (long-term holds) — display rows for their tabs.
    holds = []
    for row in s["set_aside"]:
        reason = row.get("_reason", "")
        if reason not in ("graded", "sealed"):
            continue
        name = (row.get("Product Name") or "").strip()
        holds.append({
            "row_idx": -1, "bucket": reason,
            "name": name, "set": (row.get("Set") or "").strip(),
            "number": (row.get("Card Number") or "").strip(),
            "grade": row.get("Grade", ""), "qty": row.get("Quantity", 1),
            "price": round(float(row.get("_market_value", 0) or 0), 2),
            "category": row.get("Category", ""), "tags": [], "keep": False,
        })

    rows.sort(key=lambda x: -x["price"])
    holds.sort(key=lambda x: -x["price"])
    return jsonify({"rows": rows + holds, "count": len(rows) + len(holds),
                    "summary": _sell_summary(rows, holds)})


def _sell_summary(rows: list[dict], holds: list[dict]) -> dict:
    """Per-tab totals + recovery rollup over the raw sellable pool (keepers excluded)."""
    sellable = [r for r in rows if not r["keep"]]

    def agg(rs):
        mkt = sum(r["price"] * r["qty"] for r in rs)
        net = sum(r.get("net_total", 0) for r in rs)
        return round(mkt, 2), round(net, 2), (round(net / mkt, 3) if mkt else 0)

    mkt, net, pct = agg(sellable)
    buckets = {}
    for b in ("pkmn", "mtg", "ygo"):
        bm, bn, bp = agg([r for r in sellable if r["bucket"] == b])
        buckets[b] = {"market": bm, "net": bn, "pct": bp,
                      "count": sum(1 for r in rows if r["bucket"] == b)}
    for b in ("graded", "sealed"):
        hs = [x for x in holds if x["bucket"] == b]
        buckets[b] = {"market": round(sum(x["price"] for x in hs), 2),
                      "net": 0, "pct": 0, "count": len(hs)}

    grade_cands = [r for r in sellable if r["grade_flag"]]
    keepers = [r for r in rows if r["keep"]]
    return {
        "market": mkt, "net": net, "pct": pct,
        "by_bucket": buckets,
        "grade_candidates": len(grade_cands),
        "grade_extra": round(sum(r["grade_gap"] for r in grade_cands), 2),
        "keepers": len(keepers),
        "keepers_value": round(sum(r["price"] * r["qty"] for r in keepers), 2),
        "not_nm_queue": sum(1 for r in rows if r["not_nm"]),
        "count_sellable": len(sellable),
    }


# ── Update Prices job (the physical button) ─────────────────────────────────

UPDATE_JOB = {"running": False, "done": 0, "total": 0, "started": None, "error": None}


def _run_price_update(cards: list[dict]) -> None:
    import pricing
    from concurrent.futures import ThreadPoolExecutor
    from config import DATA_DIR
    path = DATA_DIR / "live_prices.json"
    live = _load_live_prices()
    lock = __import__("threading").Lock()

    def one(c):
        try:
            m = pricing.market_price(c["name"], c["set"], c["number"],
                                     c["category"], c["variance"], "Ungraded")
            p10 = None
            if c["category"] == "Pokemon" and (m or c["price"]) >= 10:
                pc = pricing.pricecharting_lookup(
                    f"pokemon {c['name'].split(' - ')[0]} {c['number'].split('/')[0]}")
                p10 = (pc or {}).get("grade10_psa")
            with lock:
                ent = live.get(c["nkey"], {})
                if m:
                    ent["market"] = round(float(m), 2)
                if p10:
                    ent["psa10"] = round(float(p10), 2)
                ent["ts"] = time.time()
                live[c["nkey"]] = ent
                UPDATE_JOB["done"] += 1
                if UPDATE_JOB["done"] % 25 == 0:
                    path.write_text(json.dumps(live))
        except Exception:
            with lock:
                UPDATE_JOB["done"] += 1

    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(one, cards))
    path.write_text(json.dumps(live))
    UPDATE_JOB["running"] = False


@app.route("/api/update-prices", methods=["POST"])
def api_update_prices():
    """Refresh market prices (pokemontcg.io/PriceCharting) + real PSA-10 prices
    for the raw pool. Runs in the background; poll GET for progress."""
    import threading
    h = CURRENT_SESSION["hash"]
    if not h or h not in SESSIONS:
        return jsonify({"error": "no active session"}), 400
    if UPDATE_JOB["running"]:
        return jsonify({"ok": True, "already_running": True, **UPDATE_JOB})

    seen, cards = set(), []
    for c in SESSIONS[h].get("cockpit") or []:
        inv = c["inv"]
        nkey = _nkey_inv(inv)
        if nkey in seen:
            continue
        seen.add(nkey)
        # Bound the job: all Pokémon raw; MTG only where a live price matters ($3+).
        if inv.category == "Pokemon" or (inv.category == "Magic: The Gathering"
                                         and inv.market_price >= 3):
            cards.append({"nkey": nkey, "name": inv.product_name, "set": inv.set_name,
                          "number": inv.card_number, "category": inv.category,
                          "variance": inv.variance, "price": inv.market_price})
    cards.sort(key=lambda c: -c["price"])   # most valuable first

    UPDATE_JOB.update(running=True, done=0, total=len(cards),
                      started=time.time(), error=None)
    threading.Thread(target=_run_price_update, args=(cards,), daemon=True).start()
    return jsonify({"ok": True, **UPDATE_JOB})


@app.route("/api/update-prices", methods=["GET"])
def api_update_prices_status():
    return jsonify(UPDATE_JOB)


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
    """Cockpit row_idx → natural key (cockpit = matcher rows + YGO/JP/art extras)."""
    h = CURRENT_SESSION["hash"]
    if not h or h not in SESSIONS:
        return None, (jsonify({"error": "no active session"}), 400)
    cockpit = SESSIONS[h].get("cockpit") or []
    if row_idx is None or not (0 <= int(row_idx) < len(cockpit)):
        return None, (jsonify({"error": "row_idx required / out of range"}), 400)
    return _nkey_inv(cockpit[int(row_idx)]["inv"]), None


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
    all_dec = session_db.all_decisions()

    picks = []
    for c in s.get("cockpit") or []:
        inv = c["inv"]
        d = all_dec.get(_nkey_inv(inv)) or {}
        if tag not in (d.get("tags") or []) or d.get("attribute") == "personal":
            continue
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
