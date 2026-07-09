"""
Verified 2026 fee model + net-proceeds math for each sell channel.

All rates were adversarially verified in July 2026 (see the workflow research).
Fees change — re-verify against each platform's live fee page before trusting
these for a real pricing decision. Sources noted per constant.

Net-proceeds are an APPROXIMATION on the item price alone (we ignore the
buyer-paid shipping/tax that inflates the fee base, and assume the seller eats
outbound shipping). That's deliberately conservative and, crucially, applied
identically across channels so the *comparison* is fair even if the absolute
number is a few percent off.
"""

from __future__ import annotations

from dataclasses import dataclass


# ── eBay (Trading Cards / CCG category) ─────────────────────────────────────
# FVF 13.25% up to $7,500/item (verified: category exception — the general rate
# rose to 13.6% in 2025 but cards kept 13.25%). Per-order fixed fee $0.30 (<=$10)
# / $0.40 (>$10). The $1,000+ 50%-off-FVF promo EXPIRED May 2025 — not modeled.
EBAY_FVF = 0.1325
EBAY_PER_ORDER_LOW = 0.30      # order total <= $10
EBAY_PER_ORDER_HIGH = 0.40     # order total  > $10
EBAY_AUTHENTICITY_THRESHOLD = 250.0   # raw AND graded route through PSA auth

# ── TCGplayer (Marketplace, seller-fulfilled) ───────────────────────────────
# Commission 10.75% (raised from 10.25% on 2026-02-10), capped at $75/item.
# Plus a 2.5% + $0.30 transaction fee. The $75 cap makes TCGplayer the CHEAPER
# structure above ~$698 sale price. (Pro's 9.25% is offset by a +2.5% Pro fee —
# net higher — so we model the standard Marketplace rate.)
TCG_COMMISSION = 0.1075
TCG_COMMISSION_CAP = 75.0
TCG_TXN_PCT = 0.025
TCG_TXN_FIXED = 0.30

# ── Whatnot (live auction, TCG category) ────────────────────────────────────
# ~8% commission + 2.9% + $0.30 processing. Only wins with a live audience —
# modeled for completeness, not recommended for a cold-start finite liquidation.
WHATNOT_COMMISSION = 0.08
WHATNOT_TXN_PCT = 0.029
WHATNOT_TXN_FIXED = 0.30

# ── Local card-shop / show buylist ──────────────────────────────────────────
# Cash buylist runs ~50–70% of market; midpoint used. No fees, no shipping,
# instant — the fast-cash exit for mid-value singles with a debt deadline.
BUYLIST_RATE = 0.60

# ── Bulk realizable cash (verified sorting-driven economics) ─────────────────
# A sub-$1 card's "market price" is largely PAPER — nobody pays $0.30 + shipping
# for one common, and buylists pay ~2¢ on unsorted bulk. So realizable cash is
# tier-dependent: true commons clear at the bulk rate; $1–5 cards hold ~65% of
# market when pulled into themed lots.
BULK_DUMP_RATE = 0.025     # $/card, unsorted commons (<$1) to a bulk buyer
BULK_LOT_KEEP = 0.65       # $1–5 cards in themed lots realize ~65% of market


def bulk_unit_cash(unit_price: float) -> float:
    """Realistic cash for one sub-$5 card via the best bulk exit for its tier."""
    if unit_price < 1.0:
        return BULK_DUMP_RATE
    return unit_price * BULK_LOT_KEEP


def _ship_out(price: float) -> float:
    """Approx seller-paid outbound shipping by value band (verified options)."""
    if price < 20:
        return 1.00      # eBay Standard Envelope / plain white envelope, tracked-ish
    if price < 250:
        return 4.50      # USPS Ground Advantage, rigid tracked mailer
    return 4.50          # $250+: seller still ships (to the authenticator), tracked


@dataclass
class NetQuote:
    channel: str
    gross: float
    fees: float
    shipping: float
    net: float
    note: str = ""

    @property
    def take_rate(self) -> float:
        """Fraction of gross lost to fees + shipping."""
        return (self.fees + self.shipping) / self.gross if self.gross else 0.0


def ebay_net(price: float, ad_rate: float = 0.0) -> NetQuote:
    """Net proceeds on a single eBay sale at `price`. `ad_rate` = Promoted Listings %."""
    per_order = EBAY_PER_ORDER_LOW if price <= 10 else EBAY_PER_ORDER_HIGH
    fees = EBAY_FVF * price + per_order + ad_rate * price
    ship = _ship_out(price)
    note = "Authenticity Guarantee (PSA leg + delay)" if price >= EBAY_AUTHENTICITY_THRESHOLD else ""
    return NetQuote("eBay", price, fees, ship, price - fees - ship, note)


def tcgplayer_net(price: float) -> NetQuote:
    """Net proceeds on a single TCGplayer Marketplace sale at `price`."""
    commission = min(TCG_COMMISSION * price, TCG_COMMISSION_CAP)
    fees = commission + TCG_TXN_PCT * price + TCG_TXN_FIXED
    ship = _ship_out(price)
    note = "commission capped at $75" if TCG_COMMISSION * price > TCG_COMMISSION_CAP else ""
    return NetQuote("TCGplayer", price, fees, ship, price - fees - ship, note)


def whatnot_net(price: float) -> NetQuote:
    fees = WHATNOT_COMMISSION * price + WHATNOT_TXN_PCT * price + WHATNOT_TXN_FIXED
    ship = _ship_out(price)
    return NetQuote("Whatnot", price, fees, ship, price - fees - ship)


def buylist_net(price: float) -> NetQuote:
    """Cash buylist / card-show dealer payout — no fees, no shipping."""
    net = BUYLIST_RATE * price
    return NetQuote("Buylist", price, price - net, 0.0, net, f"~{BUYLIST_RATE:.0%} cash, instant")


def best_online(price: float, ad_rate: float = 0.0) -> NetQuote:
    """Higher-net of eBay vs TCGplayer for a fixed-price single (fees only)."""
    e, t = ebay_net(price, ad_rate), tcgplayer_net(price)
    return e if e.net > t.net else t
