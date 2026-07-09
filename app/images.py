"""
Image resolver: looks up card images by TCGplayer Id, falling back from the
TCGP CDN to Scryfall (MTG) or Pokemon TCG API (Pokemon) when the CDN doesn't
serve the product. Caches the resolved image bytes to disk.

The TCGP CDN URL pattern in the brief works for ~3% of modern product ids;
Scryfall/Pokemon TCG API handle the rest.
"""

import hashlib
import json
import re
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Optional

import requests

try:
    from config import POKEMONTCG_API_KEY as _POKEMONTCG_KEY
except Exception:
    _POKEMONTCG_KEY = ""

CACHE_DIR  = Path(__file__).parent / "state" / "image_cache"
CACHE_META = Path(__file__).parent / "state" / "image_meta.json"
USER_AGENT = "TCGPInventoryMatcher/1.0 (local; dallas)"

_LOCK = threading.Lock()
_META: dict[str, dict] = {}


def _load_meta() -> None:
    global _META
    if CACHE_META.exists():
        try:
            _META = json.loads(CACHE_META.read_text())
        except Exception:
            _META = {}


def _save_meta() -> None:
    CACHE_META.parent.mkdir(parents=True, exist_ok=True)
    CACHE_META.write_text(json.dumps(_META))


def _cache_path(tid: str, size: int) -> Path:
    return CACHE_DIR / f"{tid}_{size}.jpg"


def _http_get(url: str, timeout: float = 6.0) -> Optional[bytes]:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Referer":    "https://www.tcgplayer.com/",
            "Accept":     "image/jpeg,image/png,*/*",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            if r.status != 200:
                return None
            return r.read()
    except Exception:
        return None


_SESSION = requests.Session()   # keep-alive + gzip → matches curl (urllib was ~2x slower)


def _http_get_json(url: str, timeout: float = 15.0) -> Optional[dict]:
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    if "pokemontcg.io" in url and _POKEMONTCG_KEY:
        headers["X-Api-Key"] = _POKEMONTCG_KEY   # 20k/day vs keyless ~1k → far fewer 429s
    try:
        r = _SESSION.get(url, headers=headers, timeout=timeout)
        return r.json() if r.status_code == 200 else None
    except Exception:
        return None


# ── Resolution strategies ──────────────────────────────────────────────────

def _try_tcgp_cdn(tid: str, size: int) -> Optional[bytes]:
    return _http_get(
        f"https://tcgplayer-cdn.tcgplayer.com/product/{tid}_in_{size}x{size}.jpg"
    )


def _try_scryfall(tid: str, name: str, set_name: str) -> Optional[bytes]:
    # Fast path: Scryfall indexes TCGplayer ids
    data = _http_get_json(f"https://api.scryfall.com/cards/tcgplayer/{tid}")
    if data and data.get("image_uris", {}).get("normal"):
        return _http_get(data["image_uris"]["normal"])

    # Fallback: search by name + set
    q = urllib.parse.quote(f'!"{name}" set:"{set_name}"')
    data = _http_get_json(f"https://api.scryfall.com/cards/search?q={q}&unique=cards")
    if data and data.get("data"):
        url = data["data"][0].get("image_uris", {}).get("normal")
        if url:
            return _http_get(url)
    return None


def _try_pokemon(name: str, set_name: str, number: str) -> Optional[bytes]:
    # Pokemon TCG API set.name doesn't always match TCGP's, so search by
    # name + number and pick the result whose set name fuzzy-matches.
    norm_num = number.split("/")[0].lstrip("0") or "0"
    # TCGP product names embed card numbers (e.g. "Squirtle - 007/165",
    # "Alakazam ex - 065/165"). Strip those — Pokemon TCG API's name field
    # is just the card name.
    bare_name = name.split(" - ")[0].strip()
    q = urllib.parse.quote(f'name:"{bare_name}" number:{norm_num}')
    data = _http_get_json(
        f"https://api.pokemontcg.io/v2/cards?q={q}&pageSize=10"
    )
    cards = data.get("data", []) if data else []
    if not cards:
        return None

    # Prefer the card whose set name shares the most words with our TCGP set
    target_words = set(set_name.lower().split())

    def score(c):
        s = c.get("set", {}).get("name", "").lower()
        return len(target_words & set(s.split()))

    best = max(cards, key=score)
    img_url = best.get("images", {}).get("large") or best.get("images", {}).get("small")
    if img_url:
        return _http_get(img_url)
    return None


# ── Public entrypoint ──────────────────────────────────────────────────────

def get_image(
    tcgplayer_id: str,
    category: str,
    name: str,
    set_name: str,
    number: str,
    size: int = 400,
) -> Optional[bytes]:
    """
    Returns the image bytes for the given TCGplayer product. Uses the disk cache
    and falls back through TCGP CDN → Scryfall (MTG) / Pokemon TCG API (Pokemon).
    Returns None if nothing resolved.
    """
    if not _META:
        _load_meta()

    cache_file = _cache_path(tcgplayer_id, size)
    if cache_file.exists():
        return cache_file.read_bytes()

    with _LOCK:
        # Re-check after acquiring lock — another thread may have just cached
        if cache_file.exists():
            return cache_file.read_bytes()

        bytes_ = _try_tcgp_cdn(tcgplayer_id, size)
        source = "tcgp"
        if not bytes_:
            if category == "Magic: The Gathering":
                bytes_ = _try_scryfall(tcgplayer_id, name, set_name)
                source = "scryfall"
            elif category == "Pokemon":
                bytes_ = _try_pokemon(name, set_name, number)
                source = "pokemontcg"

        if bytes_:
            CACHE_DIR.mkdir(parents=True, exist_ok=True)
            cache_file.write_bytes(bytes_)
            _META[f"{tcgplayer_id}_{size}"] = {"source": source, "bytes": len(bytes_)}
            _save_meta()
            return bytes_

        return None


# ── Direct CDN URL resolution (fast path — browser loads from the CDN itself) ──
# Instead of proxying image BYTES through Flask (slow, serialized), resolve each
# card's direct CDN image URL once and 302-redirect the browser to it. Cached to
# disk with negative caching so misses don't re-hit the network every render.

URL_CACHE = Path(__file__).parent / "state" / "image_url_cache.json"
_URL: dict[str, dict] = {}
_URL_TTL = 6 * 3600          # re-attempt a miss after 6h; hits effectively permanent


def _load_url_cache() -> None:
    global _URL
    if not _URL and URL_CACHE.exists():
        try:
            _URL = json.loads(URL_CACHE.read_text())
        except Exception:
            _URL = {}


def _save_url_cache() -> None:
    URL_CACHE.parent.mkdir(parents=True, exist_ok=True)
    URL_CACHE.write_text(json.dumps(_URL))


_SET_STOPWORDS = {"sv", "swsh", "sm", "xy", "ex", "the", "of", "and", "pokemon",
                  "tcg", "promo", "promos", "trainer", "gallery", "set", "series"}


def _setwords(s: str) -> set:
    return {w for w in re.findall(r"\w+", s.lower()) if w not in _SET_STOPWORDS}


def _card_img(c: dict) -> Optional[str]:
    im = c.get("images", {})
    return im.get("small") or im.get("large")


_SETS_CACHE = Path(__file__).parent / "state" / "ptcg_sets.json"
_SETS: Optional[list] = None


def _load_ptcg_sets() -> list:
    """All pokemontcg.io sets (id/name/printedTotal/total), fetched once, cached 7d.
    One request total — used to CONSTRUCT image URLs instead of searching per card."""
    global _SETS
    if _SETS is not None:
        return _SETS
    if _SETS_CACHE.exists():
        try:
            blob = json.loads(_SETS_CACHE.read_text())
            if time.time() - blob.get("ts", 0) < 7 * 86400 and blob.get("sets"):
                _SETS = blob["sets"]
                return _SETS
        except Exception:
            pass
    data = _http_get_json("https://api.pokemontcg.io/v2/sets?pageSize=250"
                          "&select=id,name,printedTotal,total,series", timeout=20)
    _SETS = data.get("data", []) if data else []
    if _SETS:
        _SETS_CACHE.parent.mkdir(parents=True, exist_ok=True)
        _SETS_CACHE.write_text(json.dumps({"ts": time.time(), "sets": _SETS}))
    return _SETS


# Vintage/ambiguous TCGP set names → exact pokemontcg.io set id. These lack a
# reliable denominator (e.g. Base Set Charizard is just "#4") and their names
# collide (Base / Base Set 2), so pin them explicitly to avoid wrong images.
_SETID_ALIASES = {
    "base set (unlimited)": "base1", "base set": "base1", "base set (shadowless)": "base1",
    "jungle": "base2", "fossil": "base3", "base set 2": "base4", "team rocket": "base5",
    "legendary collection": "base6", "gym heroes": "gym1", "gym challenge": "gym2",
    "neo genesis": "neo1", "neo discovery": "neo2", "neo revelation": "neo3", "neo destiny": "neo4",
    "expedition": "ecard1", "aquapolis": "ecard2", "skyridge": "ecard3",
}


def _ptcg_setid(set_name: str, denom: Optional[str]) -> Optional[str]:
    """Best pokemontcg.io set id for a TCGP set name + card-number denominator."""
    alias = _SETID_ALIASES.get(set_name.strip().lower())
    if alias:
        return alias
    sets = _load_ptcg_sets()
    if not sets:
        return None
    target = _setwords(set_name)
    cands = sets
    if denom:
        dm = [s for s in sets if denom in (str(s.get("printedTotal")), str(s.get("total")))]
        if len(dm) == 1:
            return dm[0].get("id")          # unique printed-total match → confident
        if dm:
            cands = dm
    scored = sorted(((len(target & _setwords(s.get("name", ""))), s) for s in cands),
                    key=lambda x: -x[0])
    # Accept only a clear, unambiguous name winner (else fall back / no image).
    if scored and scored[0][0] > 0 and (len(scored) == 1 or scored[0][0] > scored[1][0]):
        return scored[0][1].get("id")
    return None


def _pokemon_image_url(name: str, set_name: str, number: str) -> Optional[str]:
    norm_num = number.split("/")[0].lstrip("0") or "0"
    denom = None
    if "/" in number:
        d = number.split("/")[1].strip().lstrip("0")
        denom = d if d.isdigit() else None

    # Fast path: construct the CDN URL from set id + number — no per-card search
    # (the search endpoint is slow/throttled). onerror in the UI hides any 404.
    setid = _ptcg_setid(set_name, denom)
    if setid:
        return f"https://images.pokemontcg.io/{setid}/{norm_num}.png"

    # Fallback (rare: promos / trainer-gallery subsets the set map can't pin) —
    # search by name+number and disambiguate by set/denominator.
    bare = re.sub(r"\s*\([^)]*\)", "", name).split(" - ")[0].strip()
    q = urllib.parse.quote(f'name:"{bare}" number:{norm_num}')
    data = _http_get_json(f"https://api.pokemontcg.io/v2/cards?q={q}&pageSize=25")
    cards = data.get("data", []) if data else []
    if not cards:
        return None
    if len(cards) == 1:
        return _card_img(cards[0])
    target = _setwords(set_name)

    def score(c):
        cs = c.get("set", {})
        overlap = len(target & _setwords(cs.get("name", "")))
        denom_hit = 1 if denom and str(cs.get("printedTotal") or cs.get("total") or "") == denom else 0
        return (denom_hit, overlap)

    best = max(cards, key=score)
    denom_hit, overlap = score(best)
    if overlap == 0 and denom_hit == 0:
        return None
    return _card_img(best)


def _scryfall_image_url(tid: str, name: str, set_name: str) -> Optional[str]:
    data = _http_get_json(f"https://api.scryfall.com/cards/tcgplayer/{tid}")
    if data and data.get("image_uris", {}).get("normal"):
        return data["image_uris"]["normal"]
    q = urllib.parse.quote(f'!"{name}" set:"{set_name}"')
    data = _http_get_json(f"https://api.scryfall.com/cards/search?q={q}&unique=cards")
    if data and data.get("data"):
        return data["data"][0].get("image_uris", {}).get("normal")
    return None


def resolve_image_url(tcgplayer_id: str, category: str, name: str,
                      set_name: str, number: str, cached_only: bool = False) -> Optional[str]:
    """Direct CDN image URL for a card (cached, negative-cached). None if unresolved.
    cached_only=True returns the cached value (or None) without any network call —
    used by /api/sell so serving the grid never blocks on resolution."""
    if not _URL:
        _load_url_cache()
    ent = _URL.get(tcgplayer_id)
    if ent:
        # Hits are cached ~permanently; misses only 15 min so a transient
        # rate-limit/network blip re-resolves instead of hiding art for hours.
        ttl = _URL_TTL if ent.get("url") else 900
        if (time.time() - ent.get("ts", 0)) < ttl:
            return ent.get("url")
    if cached_only:
        return None

    if category == "Magic: The Gathering":
        url = _scryfall_image_url(tcgplayer_id, name, set_name)
    else:
        url = _pokemon_image_url(name, set_name, number)

    with _LOCK:
        _URL[tcgplayer_id] = {"url": url, "ts": time.time()}
        _save_url_cache()
    return url
