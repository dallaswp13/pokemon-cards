# TCGP Inventory Matcher — Project Brief

## What we're building

A local tool that matches a personal card inventory (`export.csv` from a portfolio
tracker) against TCGplayer Pricing Custom Export sheets, lets the user review
uncertain matches with card images, and outputs the TCGP sheets with `Add to Quantity`
filled in — ready to bulk-upload back to TCGplayer.

It's a single-user local tool. No cloud, no auth. Runs as a small Flask server on
localhost with a vanilla-JS web UI. The user reaches it at `http://localhost:5000`
in their browser.

## Project folder

```
pokemon-cards/
  app/
    matcher.py            # matching engine — pure functions, easy to test
    server.py             # Flask app, glues matcher to UI
    static/
      index.html
      app.js
      style.css
    state/
      session_<hash>.sqlite   # per-session state for resume-ability
  inputs/
    export_<date>.csv         # latest portfolio export (user drops in)
    TCGplayer_pokemon.csv     # latest TCGP master sheet, English Pokemon
    TCGplayer_mtg.csv         # latest TCGP master sheet, MTG
  outputs/
    TCGplayer_pokemon_filled_<date>.csv
    TCGplayer_mtg_filled_<date>.csv
    set_aside_<date>.csv      # graded + sealed + personal + PSA + damaged
    unmatched_<date>.csv      # any rows the user explicitly skipped
  PROJECT_BRIEF.md            # this file
  requirements.txt
  run.command                 # double-click launcher (macOS)
```

## Inputs

**`export.csv`** columns:
`Portfolio Name, Category, Set, Product Name, Card Number, Rarity, Variance, Grade,
Card Condition, Average Cost Paid, Quantity, Market Price (As of YYYY-MM-DD),
Price Override, Watchlist, Date Added, Notes`

**TCGplayer Pricing Export** columns:
`TCGplayer Id, Product Line, Set Name, Product Name, Title, Number, Rarity,
Condition, TCG Market Price, TCG Direct Low, TCG Low Price With Shipping,
TCG Low Price, Total Quantity, Add to Quantity, TCG Marketplace Price, Photo URL`

Both files use comma delimiter; TCGP fields are double-quoted, export fields are not.
Preserve original quoting on output — match the source format exactly.

## Filtering rules

From the export, only process rows where `Category` is `Pokemon` or
`Magic: The Gathering`. Silently drop everything else (stale Lorcana / One Piece /
YuGiOh entries) but report the count so the user can sanity-check.

Then split into three buckets:

- **Sealed product** (anything where `Product Name` indicates booster boxes, ETBs,
  packs, etc. — TBD heuristic, look for keywords like "Booster Box", "Elite Trainer",
  "Booster Pack", "Bundle", "Tin", "Collection Box"). → Set-aside report only,
  no TCGP action.
- **Graded** (any row where `Grade` is not `Ungraded`). → Set-aside report only,
  no TCGP action. (Currently always `Ungraded`, but defensive.)
- **Raw singles** (everything else). → Goes into the matcher.

Both set-aside reports should compute total market value
(`Quantity × Market Price`) so the user can see what's parked.

## Matching algorithm

For each raw-single row:

1. **Pick the TCGP universe** by `Category`:
   - `Pokemon` → `TCGplayer_pokemon.csv`
   - `Magic: The Gathering` → `TCGplayer_mtg.csv`
2. **Normalize set name** — lowercase, strip punctuation/whitespace, exact match
   first; fuzzy match (rapidfuzz) only if exact fails.
3. **Normalize card number** — strip the denominator (`65/204` → `65`), strip
   leading zeros (`065a` → `65a`), preserve trailing letters.
4. **Find candidates** matching set + normalized number.
5. **Filter candidates by Variance → Condition.** Assume `Card Condition` is always
   `Near Mint`. Mapping:

   | Category | Variance              | TCGP Condition contains    |
   | -------- | --------------------- | -------------------------- |
   | Pokemon  | Normal                | `Near Mint` (no Holo/Foil) |
   | Pokemon  | Holofoil              | `Near Mint Holofoil`       |
   | Pokemon  | Reverse Holofoil      | `Near Mint Reverse Holofoil` |
   | Pokemon  | 1st Edition           | `1st Edition Near Mint`    |
   | Pokemon  | 1st Edition Holofoil  | `1st Edition Holofoil`     |
   | Pokemon  | Unlimited             | `Unlimited Near Mint`      |
   | Pokemon  | Unlimited Holofoil    | `Unlimited Holofoil`       |
   | MTG      | Normal                | `Near Mint` (no Foil)      |
   | MTG      | Foil                  | `Near Mint Foil`           |

   Verify these on real data before trusting them — TCGP's exact condition strings
   may differ from what's listed above. Build the table empirically: scan the
   TCGP files, collect the distinct `Condition` values, and lock in the mapping.

6. **Confidence score and routing:**

   - **Auto-confirm** (high confidence): exactly one candidate after filtering, set
     and number both exact-matched.
   - **Review** (medium): multiple candidates after filtering, OR set name was
     fuzzy-matched, OR multiple TCGP rows share the same set/number/condition
     (e.g., reprints with different `Title`).
   - **Unmatched** (low): zero candidates after filtering.

   Auto-confirmed rows fill `Add to Quantity` immediately. Review and unmatched
   rows go into the review queue.

## Review UI

Single-page app, served from Flask. Three tabs/sections:

1. **Review queue** — all medium-confidence rows. For each:
   - Inventory row info on the left (set, number, name, variance, quantity,
     market price).
   - Top 1–3 TCGP candidates on the right, each with a 400×400 thumbnail.
   - Big 1000×1000 image of the currently-selected candidate at the top.
   - Action buttons (and keyboard shortcuts):
     - **1 / 2 / 3** — pick candidate
     - **Enter** — confirm selected candidate
     - **P** — mark for personal collection
     - **G** — send to PSA (grading)
     - **B** — bad condition (don't list)
     - **S** — skip / no match
     - **← / →** — prev / next card
   - Personal / PSA / bad / skip all remove from TCGP output and go to set-aside.

2. **Unmatched / search** — for unmatched rows. Same layout as review, but the
   right-hand panel is a search box that queries the TCGP universe live (set,
   number, name) and shows results with thumbnails. User can pick one or mark
   the row as unmatched permanently.

3. **Set-aside view** — graded + sealed + personal + PSA + bad, with totals.
   Read-only.

**Image URLs.** Pattern: `https://tcgplayer-cdn.tcgplayer.com/product/{TCGplayer_Id}_in_400x400.jpg`
for thumbnails, `_in_1000x1000.jpg` for the big view. If a TCGP image 404s,
fall back to:
- MTG → Scryfall API by name + set code
- Pokemon → Pokemon TCG API (https://pokemontcg.io) by name + set + number

Lazy-load images for the current card and prefetch the next 2 for snappiness.

**Performance budget.** Both TCGP files in memory once at server boot. Build
indices keyed by `(normalized_set, normalized_number)` for O(1) candidate lookup.
Whole match pass on 4k inventory rows should complete in under 5 seconds.

## Output

On Export:

1. Read each original TCGP file fresh.
2. For matched-and-confirmed rows: set `Add to Quantity` to the inventory `Quantity`.
3. Drop rows where `Add to Quantity` is `0` or empty.
4. Preserve original CSV formatting exactly (double-quoted fields, same column
   order, same line endings).
5. Write to `outputs/TCGplayer_<game>_filled_<YYYYMMDD>.csv`.
6. Also write `outputs/set_aside_<date>.csv` (graded + sealed + personal + PSA +
   bad with totals) and `outputs/unmatched_<date>.csv` (anything explicitly
   skipped).

## Session persistence

SQLite at `app/state/session_<export_hash>.sqlite`. Decisions are scoped to one
export.csv (per-copy, not per-card). Closing the browser mid-review and reopening
should resume where the user left off. Once a session is exported, it's archived.

## Tech stack

- Python 3.11+
- Flask
- pandas
- rapidfuzz (fuzzy set-name matching)
- sqlite3 (stdlib)
- Vanilla JS frontend, single HTML file, no build step
- `requirements.txt` pinned

## Build order

1. **Matcher first, no UI.** Write `matcher.py` and a CLI driver. Run it on the
   existing `export.csv` and the two TCGP files. Print a summary: how many
   auto-matched, how many for review, how many unmatched. Spot-check 20 random
   matches by hand. Tune the Variance → Condition mapping and number
   normalization until the auto-match rate looks right and false-positive rate
   is near zero.
2. **Output writer.** Make it produce a working filled TCGP CSV from
   auto-confirmed rows alone. Open in Excel, verify formatting matches the
   original byte-for-byte where possible.
3. **Flask shell + static frontend skeleton.** Serve the page, wire up the
   "drop your export.csv" upload, kick off matching, show counts.
4. **Review UI.** Card images, candidate panel, action buttons, keyboard
   shortcuts. SQLite session state.
5. **Search box for unmatched.**
6. **Set-aside view + totals.**
7. **End-to-end run** on real data. Tune.

## Open items to verify on real data

- Distinct `Condition` strings in the TCGP files — confirm the mapping table
  above against actual values.
- Whether any Pokemon/MTG row in the user's export has a stray bare-letter or
  bare-number Variance (those are believed to be YuGiOh leftovers and should
  vanish once non-Pokemon/MTG categories are filtered out — confirm).
- Sealed-product detection heuristic — review the Product Name patterns the
  user actually has and adjust the keyword list.
- TCGplayer CDN URL pattern — confirm a sample of IDs resolve to real images
  before relying on it.

## Out of scope (for now)

- Japanese Pokemon (no TCGP sheet available; defer until user wants it).
- Lorcana / One Piece / YuGiOh (not in current inventory; filter and ignore).
- Cross-session decision memory (decisions are per-export-copy only).
- Multi-condition selling (everything assumed Near Mint; bad-condition is
  marked manually, not auto-graded).
- Actual TCGP upload — user does that themselves with the output CSV.
