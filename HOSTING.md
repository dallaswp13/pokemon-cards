# Hosted multi-user architecture plan (Option 3)

Turning the local single-user Sell Cockpit into a hosted app your friends can log
into. This is a **plan to react to before committing** — nothing here is built yet.

## Goal & non-goals
- **Goal:** each user signs in, uploads their own Collectr export, and gets their
  own cockpit (routing, net-%, grading, photos, ledger). Data is private per user.
- **Non-goals (v1):** payments, a public marketplace, mobile apps, real-time
  collaboration. Keep it a private tool for you + a handful of friends.

## Target architecture
```
Browser ──► Vercel (Next.js)                 UI + light API routes (auth-gated)
                │
                ├──► Supabase                Postgres (data) · Auth · Storage (photos) · RLS
                │
                └──► Worker service          the heavy matcher + scrapers (always-on)
                     (Railway / Fly / Render)  loads TCGP master index; runs match jobs
External: pokemontcg.io · PriceCharting · Apify · eBay Browse (per-user or metered keys)
```
Why a separate worker: the matcher loads ~52 MB of TCGP master data into memory and
matches ~4k rows against ~900k — that exceeds Vercel's serverless memory/time limits
(250 MB bundle, ~10–60 s functions). It wants a small always-on box (≥512 MB–1 GB RAM).
Everything else (UI, auth, CRUD, small API) fits Vercel + Supabase cleanly.

## Data model (Supabase Postgres, all RLS-scoped to `auth.uid()`)
- `profiles(user_id pk, display_name, created_at)`
- `inventories(id, user_id, name, source, market_total, uploaded_at)` — one per export upload
- `cards(id, user_id, inventory_id, category, set, number, variance, name, market_price, qty, card_class, value_tier)`
- `decisions(id, user_id, card_natural_key, link_kind, tcgplayer_id, attribute, tags[], status, listed_at, sold_at, sale_price)` — the current SQLite table, per-user
- `photos(id, user_id, card_natural_key, side, storage_path, uploaded_at)` — metadata; bytes in Storage
- `price_cache(key, value jsonb, updated_at)` — shared, not user-scoped (public read)
- **RLS:** every user table gets `policy using (user_id = auth.uid())`. One bad policy = a data leak, so RLS tests are mandatory.

## Auth
- **Supabase Auth** — email magic-link + Google OAuth. Gate the whole app; `user_id`
  from the session stamps every write. Invite-only (allowlist friends' emails).

## The matcher, hosted
- The TCGP master CSVs (English Pokémon + MTG) live server-side on the worker (or as a
  Postgres table with a trigram/`pg_trgm` index for fuzzy set/number/name search).
- Matching runs as a **job**: user uploads export → worker matches → writes `cards` +
  auto `decisions` to Postgres → UI reads them. First match ~5 s; cache results.
- Alternative (no worker): push the TCGP index into Postgres and do matching in SQL.
  More work up front, but keeps everything serverless. Decision point below.

## Photos & images
- Card **art**: keep the resolve-to-CDN-URL approach (pokemontcg.io/Scryfall); cache
  URLs in `price_cache`. Browser loads from the CDN — no proxying, no storage cost.
- User **photos** (front/back for eBay): upload straight to **Supabase Storage** from
  the browser (signed URLs), path `photos/{user_id}/{card_key}/{side}.jpg`. Metadata row
  in `photos`. Private bucket + RLS.

## Secrets, keys & cost (the real scaler)
- pokemontcg.io key: shared, fine (free 20k/day).
- **PriceCharting / Apify / eBay:** usage scales per user. Two options:
  1. **BYO keys** — each friend adds their own in settings (they bear cost). Cleanest.
  2. **Metered shared keys** — you pay; add per-user quotas + rate limits. Simpler UX,
     your wallet. Recommend BYO for anything that costs per-call (Apify, PriceCharting).
- **Hosting cost (a few friends):** Supabase free (500 MB DB, 1 GB storage, 50k MAU) +
  Vercel Hobby ($0, non-commercial) + worker ~$0–5/mo (Fly/Railway free tier). ~$0–5/mo
  until real volume. *Verify current free-tier limits before relying on them.*

## Risks / responsibilities you take on
- **Custodian of friends' inventory data** (valuable lists) — backups, RLS correctness.
- **It's a service now** — uptime, migrations, breakage; slower feature iteration.
- **RLS is load-bearing** — one wrong policy leaks everyone's data. Needs tests.
- **Vercel Hobby is non-commercial** — fine for a friends tool; not if it monetizes.

## Migration path (phased, low-risk)
1. **Extract shared core** — factor matcher/fees/channels/grading/pricing into a package
   the current Flask app and a future worker both import (no behavior change).
2. **Postgres schema + RLS** in Supabase; port the SQLite decision store; write RLS tests.
3. **Auth + per-user inventories** — upload → match job → per-user `cards`/`decisions`.
4. **Next.js UI on Vercel** — port the cockpit (or wrap the existing vanilla UI first).
5. **Photos → Storage**; **BYO keys** in a settings page.
6. **Invite friends**, watch usage/costs, iterate.

## Effort & open decisions
- **Effort:** ~1–2 weeks to a usable multi-user v1 (biggest chunks: matcher-as-worker,
  RLS, UI port). The local app keeps working throughout.
- **Decisions to make first:**
  1. Worker service **or** matching-in-Postgres? (worker = faster to build, ~$0–5/mo;
     SQL = fully serverless, more up-front work)
  2. **BYO API keys** vs. you-pay-metered?
  3. Port UI to **Next.js** now, or wrap the existing vanilla JS behind auth first
     (faster, uglier) and rewrite later?
  4. Invite-only allowlist confirmed?

_Recommendation: worker service + BYO keys + wrap-existing-UI-first. Fastest path to
friends actually using it; rewrite to Next.js only if it gets real traction._
