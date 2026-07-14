"""
Grade-vs-sell-raw EV gate (verified 2026 defaults; see config.Grading).

Grade only when the gem-probability-weighted graded net — after grading fees,
2-way shipping, AND a carrying-cost penalty for the months the cash is locked —
beats selling raw now. Default is SELL RAW. Modern PSA-9 risk (9 ≈ raw) is why
the centering pre-screen (which we can't see from data) is a required human gate
before actually submitting; we surface the EV and flag it, we don't auto-submit.
"""

from __future__ import annotations

from dataclasses import dataclass

from config import Grading


@dataclass
class GradeDecision:
    grade: bool           # EV says grade (still needs a centering pre-check)
    ev_gap: float         # expected graded net − raw net now (per card)
    raw_net: float
    graded_ev_net: float
    tier: str
    card_class: str
    reason: str


def grade_decision(price: float, card_class: str, debt_apr: float = None) -> GradeDecision:
    debt_apr = Grading.DEBT_APR if debt_apr is None else debt_apr
    f = Grading.SELL_FEE
    raw_net = price * (1 - f)

    if price < Grading.GRADE_MIN_RAW or card_class not in Grading.CLASS_PARAMS:
        return GradeDecision(False, 0.0, round(raw_net, 2), 0.0, "-", card_class,
                             "below grading floor — sell raw")

    p = Grading.CLASS_PARAMS[card_class]
    p_below = max(0.0, 1 - p["p10"] - p["p9"])
    M = p["p10"] * p["m10"] + p["p9"] * p["m9"] + p_below * p["m8"]   # expected multiple
    expected_psa10 = price * p["m10"]

    # Pick the tier that MAXIMIZES graded net — trades fee against the time penalty,
    # so pricier cards naturally choose faster tiers (cash back in weeks not months).
    eligible = [t for t in Grading.PSA_TIERS if t["cap"] >= expected_psa10] or [Grading.PSA_TIERS[-1]]
    best_net, best_tier = None, "-"
    for t in eligible:
        c_allin = t["fee"] + Grading.SHIP_SUPPLIES
        time_penalty = price * (debt_apr / 12.0) * t["months"]
        gnet = price * M * (1 - f) - c_allin - time_penalty
        if best_net is None or gnet > best_net:
            best_net, best_tier = gnet, t["name"]

    gap = best_net - raw_net
    do_grade = M > 1 and gap > 0
    if do_grade:
        reason = (f"{card_class}: graded EV ${best_net:.0f} vs raw ${raw_net:.0f} "
                  f"(+${gap:.0f}) via {best_tier} — verify centering first")
    else:
        reason = f"{card_class}: raw ${raw_net:.0f} ≥ graded EV ${best_net:.0f} — sell raw"
    return GradeDecision(do_grade, round(gap, 2), round(raw_net, 2),
                         round(best_net, 2), best_tier, card_class, reason)
