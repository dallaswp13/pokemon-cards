"""
Image resolver: looks up card images by TCGplayer Id, falling back from the
TCGP CDN to Scryfall (MTG) or Pokemon TCG API (Pokemon) when the CDN doesn't
serve the product. Caches the resolved image bytes to disk.

The TCGP CDN URL pattern in the brief works for ~3% of modern product ids;
Scryfall/Pokemon TCG API handle the rest.
"""

import hashlib
import json
import threading
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Optional

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


def _http_get_json(url: str, timeout: float = 6.0) -> Optional[dict]:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            if r.status != 200:
                return None
            return json.loads(r.read())
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
