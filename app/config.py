"""
Central configuration for the selling-ops toolkit.

Secrets come from the environment (never committed — see `.env.example`), so
this file is safe to version. Everything else is a tunable default with the
2026 research that justifies it noted inline. Thresholds live here so the
deal radar and channel router share one source of truth.

Load order: process env → optional `<repo>/.env` (KEY=VALUE lines) → defaults.
"""

from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).parent.parent
STATE_DIR = Path(__file__).parent / "state"           # gitignored (see .gitignore)
DATA_DIR = STATE_DIR / "sell"                          # snapshots, comps cache, radar logs
DATA_DIR.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------------------
# .env loading (tiny, dependency-free — python-dotenv not required)
# ---------------------------------------------------------------------------

def _load_dotenv() -> None:
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key, val = key.strip(), val.strip().strip('"').strip("'")
        os.environ.setdefault(key, val)


_load_dotenv()


def _get(key: str, default: str = "") -> str:
    return os.environ.get(key, default).strip()


# ---------------------------------------------------------------------------
# Secrets / external services (all optional; features degrade gracefully)
# ---------------------------------------------------------------------------

# pokemontcg.io — free TCGplayer 'market' price for Pokemon raw singles.
# Works without a key (~1k req/day); a free key raises the limit to ~20k/day.
POKEMONTCG_API_KEY = _get("POKEMONTCG_API_KEY")

# PriceCharting — the only single source covering raw + graded Pokemon + sealed
# + MTG/YGO. ~$5/mo or ~$40/yr; token from account → API access.
PRICECHARTING_TOKEN = _get("PRICECHARTING_TOKEN")

# Apify — eBay auction firehose (search scraper) + sold-comps actor.
# Default actor verified working 2026-07-08 (returned 75 live Pokémon auctions):
# delicious_zebu/ebay-product-listing-scraper — takes listingUrls (your exact
# category URL) + sortBy=1 (ending soonest) + buyingFormat=LH_Auction.
# Alternate (keyword-based): automation-lab/ebay-scraper (returned 0 in testing).
# For sold comps: automation-lab/ebay-sold-scraper or xtracto/ebay-sold-comps-scraper.
APIFY_TOKEN = _get("APIFY_TOKEN")
APIFY_SEARCH_ACTOR = _get("APIFY_SEARCH_ACTOR", "delicious_zebu/ebay-product-listing-scraper")
APIFY_SEARCH_QUERY = _get("APIFY_SEARCH_QUERY", "pokemon card")   # used only by keyword actors
APIFY_SOLD_ACTOR = _get("APIFY_SOLD_ACTOR", "automation-lab/ebay-sold-scraper")

# eBay Browse API (optional) — free per-card watchlist polling once approved.
EBAY_CLIENT_ID = _get("EBAY_CLIENT_ID")
EBAY_CLIENT_SECRET = _get("EBAY_CLIENT_SECRET")

# Notifications — deal radar + reprice movers. Either/both.
TELEGRAM_BOT_TOKEN = _get("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = _get("TELEGRAM_CHAT_ID")
# Hermes = Dallas's local iMessage agent gateway (see vault System Map).
HERMES_NOTIFY_URL = _get("HERMES_NOTIFY_URL")


# ---------------------------------------------------------------------------
# eBay deal-radar target (Dallas's search: English Pokemon single-card auctions)
# ---------------------------------------------------------------------------

# _sacat/_dcat 183454 = Pokémon Individual Cards. LH_Auction=1 = auctions only.
# _sop=1 = "Time: ending soonest" — pinned here on purpose (his shared URL used
# _sop=44, which is NOT the ending-soonest sort). Feed this via Apify directUrls.
EBAY_POKEMON_CATEGORY = "183454"
EBAY_SEARCH_URL = (
    "https://www.ebay.com/sch/i.html?_fsrp=1&LH_Auction=1&_sacat=183454"
    "&_sop=1&Game=Pok%C3%A9mon%20TCG&Language=English&_dcat=183454&_pgn=1"
)


# ---------------------------------------------------------------------------
# Radar deal-detection thresholds (verified defaults; all tunable)
# ---------------------------------------------------------------------------

class Radar:
    # Two modes (Dallas wants both): 'flip' (resell) and 'collect' (personal keep).
    # A deal FLAGS if all-in cost <= DISCOUNT * reference market.
    FLIP_DISCOUNT = 0.65          # flip must clear ~13% fees + margin → ~65% of market
    COLLECT_DISCOUNT = 0.90       # collecting only needs "meaningfully below market"
    MIN_PROFIT_USD = 9.0          # flip: skip tiny cards; absolute $ floor after fees
    MIN_SOLD_COMPS = 5            # need >=5 like-for-like sold comps for confidence
    COMP_DIVERGENCE_FLAG = 0.40   # eBay vs TCG diverge >40% → low-confidence
    SNIPE_WINDOW_MIN = 15         # only consider auctions ending within N minutes
    SNIPE_LEAD_SECONDS = 8        # fire the snipe T-8s before close (via Gixen)
    MIN_SELLER_FEEDBACK_PCT = 98.0
    MIN_SELLER_FEEDBACK_COUNT = 50
    # Personal-collect bias: cards matching these get a looser discount + priority.
    COLLECT_KEYWORDS = ("umbreon", "espeon", "vaporeon", "jolteon", "flareon",
                        "leafeon", "glaceon", "sylveon", "eevee")

    # Condition haircut applied to a NM reference price.
    CONDITION_FACTOR = {"NM": 1.0, "LP": 0.8, "MP": 0.6, "HP": 0.45, "DMG": 0.3}
    # Blanket haircut for a softening/peaking market (tune as the market cools).
    MARKET_DOWNTREND = 0.0


# ---------------------------------------------------------------------------
# Channel router thresholds
# ---------------------------------------------------------------------------

class Router:
    BULK_CEILING_USD = 5.0        # Pokemon singles under this → bulk lots (D)
    EBAY_SCARCE_MIN_USD = 25.0    # only send scarce cards to eBay auction above this
    # TCGplayer requires uploaded tracking on orders $50+ (cost + effort), so
    # Dallas doesn't want to sell those there — route $50+ to eBay instead.
    TCGP_TRACKING_THRESHOLD = 50.0
    # Warm up the eBay account before listing pricey cards: clear the new-seller
    # payout hold with cheap sales first (10+ sales totaling $150+).
    WARMUP_SALES_COUNT = 12
    WARMUP_TARGET_USD = 175.0
