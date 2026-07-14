# Liquidatr

**Turn a trading-card binder into dollars — with as little confusion and uncertainty as possible.**

Liquidatr is a card-collection liquidation cockpit for Pokémon, Magic: The Gathering, Yu-Gi-Oh, and One Piece. Import a [Collectr](https://getcollectr.com) portfolio export and the app routes every card to its best sales channel, computes what actually lands in your pocket after fees, flags cards worth grading first, and produces the artifacts each channel needs — eBay listing text, TCGplayer Seller Portal upload sheets, and printable shop drop-off sheets.

**Live demo:** [sell-cockpit.vercel.app/?demo=1](https://sell-cockpit.vercel.app/?demo=1) *(sample collection, nothing saves)*

![The Cards station](https://sell-cockpit.vercel.app/favicon.svg)

## The workflow: THE LINE

The UI is organized as an assembly line of three stations, with a computed **Next-Up** ladder always naming the single most valuable next action:

1. **Cards** — one grid over your whole collection, sliced by pile (Undecided / Sell / Keep / Grade / Shop / Check / Graded / Sealed / All). Every card carries five one-tap filing actions. Multi-select checkboxes + select-all batch-file an entire search in one click. Desktop gets a broker-style table with keyboard filing (`j`/`k` move, `1–5` file, `Enter` open, `u` undo).
2. **Prep** — work queues, not browsing: condition checks (price reprices instantly on NM→LP→MP→HP→DMG), the grade pile with per-card "+$ if graded" gaps, photos needed for eBay.
3. **Cash Out** — three lanes that end in an artifact: eBay (copy-paste listing generator with format/price/shipping guidance), TCGplayer (Seller Portal add-quantity CSV, matched against your own pricing-export catalog at SKU level), and the local card shop (drop-off sheet with trade/cash totals).

An honesty ledger keeps projections labeled as projections: *"$3,664 from $4,275 market · 86¢ on the dollar — projected, not sold."*

### Design rules

- Green appears on exactly one thing: **net to you**. Market prices are white; warnings are amber.
- One filled button per screen — the Next-Up CTA.
- Estimated figures are marked (`~`, "class estimate") until real market data replaces them.

## The engine

`cloud/engine.js` is a self-contained browser port of the pricing/routing logic:

- **Channel routing** — LCS under $5; eBay auction for scarce/chase cards ≥ $25; eBay fixed above $50 (avoids TCGplayer's tracking-number requirement); otherwise whichever nets more after fees. Fee models for eBay (13.25% + $0.30/$0.40, Authenticity Guarantee at $250+) and TCGplayer (10.75% capped + 2.5% + $0.30).
- **Grading EV** — PSA tier fees × class-based gem-rate priors (vintage / textured-modern / smooth-modern), minus a debt-APR time penalty for each tier's turnaround. A card only flags "grade first" when the expected graded net beats the raw net.
- **Condition math** — LP/MP/HP/DMG reprice at 90/75/60/50% of market and re-route automatically.
- **Exact card art, zero API keys** — Pokémon via the pokemontcg.io CDN (set-list matcher + alias table), Magic via Scryfall's `/cards/{set}/{number}` exact-printing endpoint (cached set-name matcher handles Universes Beyond, Commander, The List, Secret Lair), One Piece via the Limitless CDN straight from the card number, Yu-Gi-Oh via YGOPRODeck.
- **Stable identity** — every row gets a SHA-1 natural key over category|set|number|variance|name (+grade for graded cards), so tags, piles, conditions, and photos survive every re-import. Imports are true syncs: removed cards prune, new cards appear, decisions persist.

## Architecture

```
cloud/          static web app — vanilla JS modules, no build step
  index.html    SVG icon sprite + shell
  engine.js     CSV parse → bucket → route → price → image URLs
  app.js        stations, piles, filters, batch filing, Supabase I/O
  demo.js       sample dataset for ?demo=1
app/            local Flask twin + CLI (sell.py) for offline work
```

- **Hosting:** Vercel (static). **Data:** Supabase — Postgres with row-level security per user, Storage for card photos (front/back, folder-scoped policies), an Edge Function proxying PriceCharting for real market + PSA-10 prices (key server-side only).
- Auth is Supabase email/password; every table is RLS-scoped so friends can use the same deployment on their own collections.
- No framework, no bundler: the deployed files are minified with esbuild but the source runs as-is.

## Using it

1. Sign up at the app (or open the [demo](https://sell-cockpit.vercel.app/?demo=1)).
2. In Collectr: Profile → Export Collection → upload the CSV via **Data → Import**.
3. Work the line: file cards, set conditions, snap photos, export sheets.

To self-host: create a Supabase project (schema in `HOSTING.md`), drop your URL/anon key into `cloud/app.js`, and deploy `cloud/` to any static host.

## Local toolkit

The `app/` directory is the original local CLI/Flask version — same engine in Python, plus a TCGplayer Seller Portal CSV matcher, a repricing loop, and an eBay ending-soon radar. See `SELLING.md` for channel strategy research (2026 fee tables, grading thresholds, consignment floors).

---

Built with [Claude Code](https://claude.com/claude-code).
