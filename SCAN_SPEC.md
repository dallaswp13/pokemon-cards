# Liquidatr — Bulk Scan & Match (spec)

**Status:** draft for build · **Owner:** Dallas · **Target:** Liquidatr cloud app (Supabase + jsDelivr-pinned front-end)

## 1. Problem & the core insight

Liquidating a ~4,000-card collection stalls on photos. eBay/TCGplayer listings want a picture of the *actual* copy, and hand-shooting front+back for 1,379 cards is days of work. Every day not sold is value lost.

**The unlock:** the cards are already **physically sorted into condition piles (DMG / HP / MP / LP / NM).** So we never have to *infer* condition from an image (the one thing video does badly). The operator declares the pile's condition once; the scanner's only job is:

1. capture a usable still of each card fast, and
2. recognize which **inventory** card it is (a *closed-set* match against the user's own ~4,000 rows, each of which already has a reference image + natural key), so the still + the pile's condition land on the right row.

This yields **two** wins in one pass: a real listing photo **and** bulk condition-setting (which re-prices and re-routes every scanned card via the existing `derivePricePatch`).

### Non-goals
- **No grade/condition inference from images.** Condition comes from the pile. (Optional deliberate single-card pre-grade flow is out of scope — see §11.)
- Not an open-world "identify any card" scanner. We only ever match to *this user's* inventory.
- Not the identity source of truth — Collectr/Import already told us what's in the collection. This attaches photos + condition to known rows.

## 2. Success criteria
- **Throughput:** a 1,379-card pile captured in well under an hour of hands-on time (target ≤ ~35 min), vs days.
- **Match confidence:** wrong-card attachment is the cardinal sin (a photo on the wrong listing). Auto-accept only at high similarity; everything else goes to a fast review grid. Target ≥ ~95% auto-accept correct, with all non-auto-accepted shown for one-tap fix.
- **Effort:** operator flips/lays cards and taps to confirm batches — no per-card typing.

## 3. Capture modes (pick by gear on hand)

| Mode | How | Throughput (1,379) | Photo quality | Needs |
|---|---|---|---|---|
| **Flip-stream** *(recommended if a stand exists)* | Phone on an overhead stand/tripod; flip cards one at a time onto a mat; app auto-grabs the sharpest full-frame still per card | ~1–1.5 s/card → **~25–35 min** | Best (card fills frame, high-res) | phone stand |
| **Grid burst** *(recommended default)* | Lay ~9 cards (3×3) on a mat, tap to capture, clear, repeat | ~154 captures × ~10 s → **~26 min** | Good (~1/9 frame each, flat, even light) | just a mat |
| Continuous pan | One video panning across a spread | fast but | worst — overlap + motion blur + low per-card res | — |

**Recommendation:** ship **grid-burst** first (no special gear, high-res-enough crops, easiest to get right), add **flip-stream** as a power-user mode. Skip the single continuous pan — it's the hardest variant and gives the worst photos.

## 4. Pipeline

```
[Pick pile condition]  →  CAPTURE (client)  →  DETECT+CROP (client)  →  MATCH  →  REVIEW  →  COMMIT
     DMG/HP/MP/LP/NM      grab sharp frames    find each card, de-warp   to inv.   confirm    photo+condition
```

1. **Session setup.** Operator opens "Scan a pile," picks the condition (the pile) and optionally a game filter. This condition is applied to every card confirmed in the session.
2. **Capture — client-side.** `getUserMedia` live camera. Grid-burst: tap → capture frame. Flip-stream: `requestVideoFrameCallback` samples ~3–5 fps, a Laplacian-variance sharpness gate on a `<canvas>` rejects blurry frames, and per-card dedupe keeps the sharpest front-on frame. **Never upload the raw video** (a 1080p pass is 50–150 MB); all decode stays on-device.
3. **Detect + crop — client-side.** `opencv.js` contour/quadrilateral detection + perspective de-warp produces one rectified crop per card. (Grid mode: N crops per frame; flip mode: 1.) Store each crop as a JPEG blob.
4. **Match — closed set.** Two routes (see §5). Output per crop: `{natural_key, score}` against the user's inventory.
5. **Review — human-in-the-loop.** A grid shows each crop next to its top inventory match (reference art + name + score). Auto-accept ≥ threshold; surface only ambiguous/low-score for one-tap correction (search-to-reassign, or discard). Keyboard-driven (accept/skip/fix) like the Decide table.
6. **Commit.** For each confirmed card: upload the crop to Supabase Storage, set `photos.front`, and set `condition` = the session's pile condition (which runs the existing reprice → updates price/net/channel/band). Batched.

## 5. Recognition: two routes (phased)

The inventory is a **closed set with reference images already on every row** (`image_url`: Scryfall / Limitless / pokemontcg.io). That collapses "identify" into "nearest neighbor among my 4,000 known cards."

**Route A — BUY (fastest to validate):** POST crops to a **Supabase Edge Function** that proxies **CardSight AI** (`/documentation`, multi-card-per-image, ~99.5% claimed) or **Ximilar** (`analyze_all`). Reconcile the returned identity to a `natural_key`. Key lives as a Supabase secret in the Edge Function — **never in browser JS**. *Cost/volume caveat:* CardSight free tier = 750 calls/mo — enough to validate on a sub-batch, not to run 1,379 in one session on the free tier. Confirm paid per-call pricing before using it as the production path.

**Route B — BUILD (cost-certain, volume-appropriate):** one-time embed all ~4,000 reference images (CLIP or DINOv2) → 512-d vectors in a Supabase **pgvector** column. At scan time, embed each crop in-browser (Transformers.js / onnxruntime-web + WebGPU) and match via a pgvector cosine-NN **RPC scoped to the user's rows (RLS)**. ~**$0 per scan**, data stays private, scales to the whole collection. Best combined with a burst/flip capture that yields clean crops.

**Recommendation for 1,379+ cards:** validate the end-to-end flow with **Route A on one small batch** (does an attached photo reconcile to the right natural key?), but make **Route B the production matcher** — the volume makes per-call APIs uneconomical and the closed-set match is already high-confidence. Use Route A as an optional fallback for low-similarity crops.

### Matching hygiene
- Reconcile to `natural_key` (category|set|number|variance|name — already the app's identity). 
- Hard cases = near-identical **reverse-holo / art variants / reprints** and cards the capture never got a sharp frame of → these are exactly what the review grid catches; never auto-accept them.
- Optionally bias matching toward rows **not yet photographed** and toward the session's game filter to cut ambiguity.

## 6. Data model — mostly reuses what exists
- **Condition:** column already exists; setting it runs `derivePricePatch` (reprice + re-route). Bulk-set for the session. ✅ no change.
- **Photo:** reuse the existing `photos` (jsonb front/back) + Storage bucket `card-photos` at `{user_id}/{natural_key}/front.jpg` (folder-scoped RLS). The scan fills `photos.front`. ✅ no schema change for MVP.
- **New (Route B only):** a `card_refs` embeddings table (or a `ref_embedding vector(512)` column) + pgvector extension + a nearest-neighbor RPC. One-time backfill job to embed the 4,000 reference images.
- **Optional:** a `scan_sessions` row (id, condition, started_at, counts) for auditing/undo — nice-to-have, not required for MVP.

## 7. Architecture & constraints
- **Heavy lifting on the client:** frame decode, sharpness gate, detect/crop, and (Route B) embedding — free, private, avoids uploading video, scales with the device. Supabase Edge Functions (Deno, CPU-only, ~150 s cap) are fine as a **thin API proxy** and for the pgvector RPC, but **must not** run CLIP/heavy CV.
- **Secrets:** any recognition API key is a Supabase secret behind an Edge Function; nothing sensitive in browser JS (same pattern as the `prices` function).
- **CSP / deploy:** the app is a jsDelivr-pinned shim. Adding `opencv.js` / `transformers.js` = new commit + bump the 3 jsDelivr URLs in the shim (per the existing deploy note). `getUserMedia` needs HTTPS (Vercel ✓) + permission. `connect-src` must allow Supabase + (Route B) the model-weight CDN.
- **Front-end fit:** a new "Scan a pile" entry (Data menu, or a button on Prep's "Photos needed" lane), a full-screen capture view, and the review grid. Reuses toast/undo, keyboard layer, signed-URL photo display already in `app.js`.

## 8. Throughput math (why this is the liquidatr win)
1,379 cards. Grid-burst @ 9/frame = ~154 captures; ~10 s each = **~26 min capture**. Review: auto-accept ~95% → ~70 to eyeball, ~5–8 min. **≈ 30–35 min total** for a pile that would take days by hand — and it sets condition + reprices the whole pile in the same pass.

## 9. Costs
- Route B: ~**$0/scan** after a one-time embed (in-browser embeddings, pgvector free in Supabase). Storage: ~$0.02/GB/mo for the JPEGs (1,379 × ~80 KB ≈ 110 MB ≈ pennies).
- Route A: CardSight free 750/mo for validation; paid per-call TBD; Ximilar ~$64/mo min. Only if used as fallback.

## 10. Phasing
- **Phase 0 — spike (~1 day):** prove Route A on 5–10 real crops from one pile; confirm identities reconcile to natural keys. Decide A-vs-B for production.
- **Phase 1 — MVP (ship behind a flag):** grid-burst capture → crop → match (chosen route) → review grid → commit photo + session condition. One pile end-to-end. No grading.
- **Phase 2 — scale & cost:** Route B embeddings + pgvector; opencv.js auto-crop/de-warp + sharpest-still pick; flip-stream capture mode.
- **Phase 3 — optional:** deliberate single-card flat-capture → Ximilar grading API, only for a handful of high-value raw singles where a pre-grade changes the sell/grade/keep call.

## 11. Risks & open questions
- **Match precision on variants** (reverse-holo vs holo, alt-arts, reprints) — mitigated by review grid + not auto-accepting low-margin matches. Needs a real accuracy read on Dallas's actual cards.
- **CardSight/Ximilar paid pricing at 1,379-card volume** — confirm before choosing Route A for production.
- **In-browser embedding speed** (Transformers.js + WebGPU) on the operator's device — spike to confirm it's ~sub-second/crop; else fall back to a hosted inference call.
- **Crop quality from real captures** — glare on holos/sleeves; even lighting matters. Grid-burst on a matte mat mitigates.
- **Sleeved cards** — glare/softening; recommend scanning unsleeved where practical.

## 12. Recommended first build
Grid-burst capture + **Route B** (pgvector closed-set match, in-browser embeddings) — because the 1,379-card (and eventually full-collection) volume makes per-call APIs a poor fit, and closed-set matching against the user's own reference images is inherently high-confidence — with a keyboard-driven review grid and a one-tap batch commit that writes `photos.front` + the pile's `condition`. Validate the matcher with CardSight on a small batch first.
