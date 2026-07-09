# Selling-ops toolkit

Four workflows for liquidating the collection, built on top of the TCGP matcher.
One CLI (`app/sell.py`), one shared pricing/fees/config core. Fee model and
data-source choices were verified against 2026 platform docs (re-verify before
trusting any fee % for a real decision).

```
python3 app/sell.py channels   # [B] where each single should sell
python3 app/sell.py lots       # [D] bulk-lot plan + eBay account warm-up picks
python3 app/sell.py reprice    # [A] refresh prices, re-rank, flag movers
python3 app/sell.py radar      # [C] eBay deal radar (flip + collect modes)
```

Default input is `inputs/export.csv` (your Collectr export); override with
`--export PATH`. Outputs land in `outputs/` (gitignored).

## What works with zero setup
- **channels / lots** — pure logic over your export. No keys, no network.
- **reprice** — uses the FREE pokemontcg.io API. `--limit N` prices only the
  top-N most valuable cards (good for a test run). Coverage is high on modern
  cards; vintage/promo/graded need PriceCharting (below).
- **radar** — `--source fixture` runs the scorer against
  `app/radar/fixtures/example.json` so you can see/tune the deal logic offline.

## What needs keys (copy `.env.example` → `.env`)
| Feature | Key | Cost | Why |
|---|---|---|---|
| Vintage/graded/MTG/YGO prices | `PRICECHARTING_TOKEN` | ~$5/mo | fills the ~33% of top cards pokemontcg.io can't price |
| Live auction feed for the radar | `APIFY_TOKEN` | ~$15–30/mo tuned | only path that keeps eBay's ending-soonest sort |
| Deal / mover alerts | `TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID` or `HERMES_NOTIFY_URL` | free | push to phone; else prints to stdout |
| Per-card watchlist (optional) | `EBAY_CLIENT_ID/SECRET` | free (needs eBay approval) | Browse API for your ~50 named cards |

The radar's live feed: `python3 app/sell.py radar --source apify --mode both`.
Sniping itself stays manual/Gixen — the tool flags and gives you a **max bid**;
it never bids for you.

## Cron (launchd) — the weekly reprice ritual
Save as `~/Library/LaunchAgents/com.dallas.card-reprice.plist`, then
`launchctl load` it (mirrors your vault-probe / morning-briefing jobs):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.dallas.card-reprice</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string>
    <string>/Users/dallas/dev/pokemon-cards/app/sell.py</string>
    <string>reprice</string>
  </array>
  <key>StartCalendarInterval</key><dict><key>Weekday</key><integer>1</integer>
    <key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>/tmp/card-reprice.log</string>
  <key>StandardErrorPath</key><string>/tmp/card-reprice.err</string>
</dict></plist>
```

For the radar, run it every ~10–15 min during active sniping windows (a shorter
`StartInterval`, or a second plist) so it catches auctions inside the 15-min
close window. Tune poll cadence to keep Apify spend in the ~$15–30/mo range.

## Tuning
All thresholds live in `app/config.py` (`Radar`, `Router`) and `app/fees.py`.
The radar snapshots every run to `app/state/sell/radar/` (flagged + rejected +
reasons) so you can back-test and retune `FLIP_DISCOUNT` / `MIN_PROFIT_USD`
against what actually sold.
