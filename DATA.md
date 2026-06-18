# Data & assets (not in git)

This repo versions **source only**. Bulk/generated data is gitignored to keep the repo small.
To run the app on a fresh clone, recreate these:

| Path | What it is | How to get it back |
|---|---|---|
| `app/state/` | ~1.3 GB of downloaded TCGplayer card images + matcher cache/model | Regenerated on first run (the matcher re-downloads images as needed). |
| `inputs/` | Working input scans/photos you drop in | Add your own; ephemeral. |
| `outputs/` | Generated pricing exports / matched results | Produced by a run. |
| `TCGplayer__*.csv`, `export.csv` | TCGplayer seller-account exports | Re-export from your TCGplayer Seller Portal → Pricing/Inventory. |
| `AppIcon.icns`, `icon.iconset/` | Built app icon | Rebuilt from `icon.svg` (`iconutil`/icon pipeline). |

Source of truth for the icon is `icon.svg`. Everything above is reproducible — nothing
unique is lost by leaving it out of git.
