/* Browser-side inventory engine — a JS port of the local tool's bucketing,
   channel routing, fee math, grading EV, and image-URL construction. Lets the
   web app ingest a Collectr export.csv with no local tool involved.
   Natural keys are SHA-1[:16] over the same fields as the Python side, so a
   web upload and a local push produce identical keys (tags survive either path). */

// ── Constants (ported from config.py / fees.py / matcher.py / channels.py) ──
export const COND_FACTORS = { NM: 1.0, LP: 0.9, MP: 0.75, HP: 0.6, DMG: 0.5 };

const SEALED_RE = /\b(booster\s+box|elite\s+trainer|booster\s+pack|booster\s+bundle|collection\s+box|display\s+box|theme\s+deck|starter\s+deck|prerelease\s+kit|gift\s+box|commander\s+deck|scene\s+box|pokemon\s+center|premium\s+collection|build\s+&\s+battle|tournament\s+pack|vault\s+box|secret\s+lair)\b/i;
const SEALED_BRACKET_RE = /\[\s*set\s+of\s+\d+\s*\]/i;
const TOKEN_RE = /\b(token|double-?sided\s+token|emblem)\b/i;
const MISC_SETS = new Set(["Miscellaneous Cards & Products", "Jumbo Cards"]);
const JP_SETS = new Set(["Terastal Festival ex", "Super Electric Breaker", "Collect 151 Surprise",
  "Cyber Judge", "Wild Force", "Paradise Dragona", "MEGA Dream ex", "Shiny Treasure ex",
  "VSTAR Universe", "Raging Surf", "Clay Burst", "VMAX Climax", "Mega Brave",
  "Phantasmal Flames", "Neo Destiny (Japanese)", "Neo Discovery (Japanese)"]);

const SCARCE_RARITY_RE = /(secret|special illustration|illustration rare|hyper|rainbow|gold|alternate|alt[- ]?art|shiny|radiant|prime|star|crystal)/i;
const SCARCE_NAME_RE = /(alternate art|alt art|\(secret\)|gold star|full art|1st edition|rainbow|special illustration|trainer gallery|galarian gallery|character (super )?rare|delta species|gold\b)/i;
const VINTAGE_SET_RE = /^(base set|jungle|fossil|team rocket|gym |neo |legendary collection|expedition|aquapolis|skyridge|ex |ex:|crystal guardians|diamond and pearl promos|nintendo promos|celebrations|hidden fates)/i;
const TEXTURED_RARITY_RE = /(illustration|special|secret|hyper|rainbow|gold|amazing|radiant)/i;
const TEXTURED_NAME_RE = /(alternate art|alt art|full art|gold star|\(secret\))/i;

const FEES = { EBAY_FVF: 0.1325, EBAY_LOW: 0.30, EBAY_HIGH: 0.40, AUTH_THRESHOLD: 250,
  TCG_COMM: 0.1075, TCG_CAP: 75, TCG_PCT: 0.025, TCG_FIXED: 0.30 };
const SHOP = { THRESHOLD: 10, TRADE_OVER: 0.80, CASH_OVER: 0.70, TRADE_UNDER: 0.70, CASH_UNDER: 0.60 };
const ROUTER = { BULK_CEILING: 5, EBAY_SCARCE_MIN: 25, TCGP_TRACKING: 50 };
const GRADING = {
  DEBT_APR: 0.22, SELL_FEE: 0.15, MIN_RAW: 20, SHIP: 6,
  TIERS: [
    { name: "Value Bulk", fee: 24.99, cap: 500, months: 4.5 },
    { name: "Value", fee: 32.99, cap: 500, months: 3.5 },
    { name: "Value Plus", fee: 49.99, cap: 500, months: 2.0 },
    { name: "Value Max", fee: 64.99, cap: 1000, months: 1.5 },
    { name: "Regular", fee: 79.99, cap: 1500, months: 1.0 },
    { name: "Express", fee: 149.0, cap: 2500, months: 0.75 },
  ],
  CLASS: {
    vintage:         { m10: 8.0, m9: 1.5, m8: 1.0, p10: 0.20, p9: 0.40 },
    modern_textured: { m10: 3.0, m9: 1.1, m8: 0.8, p10: 0.22, p9: 0.45 },
    modern_smooth:   { m10: 2.5, m9: 1.1, m8: 0.8, p10: 0.40, p9: 0.40 },
  },
};

// pokemontcg.io set-id pinning for denominator-less vintage + gallery subsets.
const SETID_ALIASES = {
  "base set (unlimited)": "base1", "base set": "base1", "base set (shadowless)": "base1",
  "jungle": "base2", "fossil": "base3", "base set 2": "base4", "team rocket": "base5",
  "legendary collection": "base6", "gym heroes": "gym1", "gym challenge": "gym2",
  "neo genesis": "neo1", "neo discovery": "neo2", "neo revelation": "neo3", "neo destiny": "neo4",
  "expedition": "ecard1", "aquapolis": "ecard2", "skyridge": "ecard3",
  "brilliant stars trainer gallery": "swsh9tg", "astral radiance trainer gallery": "swsh10tg",
  "lost origin trainer gallery": "swsh11tg", "silver tempest trainer gallery": "swsh12tg",
  "crown zenith: galarian gallery": "swsh12pt5gg", "crown zenith galarian gallery": "swsh12pt5gg",
};
const SET_STOPWORDS = new Set(["sv", "swsh", "sm", "xy", "ex", "the", "of", "and", "pokemon",
  "tcg", "promo", "promos", "trainer", "gallery", "set", "series"]);

// ── CSV parsing (RFC-4180-ish: handles quoted fields with commas) ───────────
export function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().replace(/^﻿/, ""));
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] || "").trim()])));
}

// ── Natural key (parity with session.natural_key) ───────────────────────────
export async function naturalKey(category, setName, number, variance, name) {
  const raw = [category, setName, number, variance, name].map((x) => (x || "").trim().toLowerCase()).join("|");
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(raw));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

// ── Card classification + routing ───────────────────────────────────────────
function cardClass(setName, rarity, name) {
  if (VINTAGE_SET_RE.test(setName)) return "vintage";
  if (TEXTURED_RARITY_RE.test(rarity || "") || TEXTURED_NAME_RE.test(name || "")) return "modern_textured";
  return "modern_smooth";
}

function isScarce(setName, rarity, name, variance, number) {
  if ((variance || "").toLowerCase().includes("1st edition")) return true;
  if (SCARCE_RARITY_RE.test(rarity || "") || SCARCE_NAME_RE.test(name || "")) return true;
  if (VINTAGE_SET_RE.test(setName)) return true;
  const m = /^\s*(\d+)\s*\/\s*(\d+)/.exec(number || "");
  return !!(m && parseInt(m[1]) > parseInt(m[2]));
}

function shipOut(p) { return p < 20 ? 1.0 : 4.5; }
export function ebayNet(p) { return p - (FEES.EBAY_FVF * p + (p <= 10 ? FEES.EBAY_LOW : FEES.EBAY_HIGH)) - shipOut(p); }
export function tcgNet(p) { return p - (Math.min(FEES.TCG_COMM * p, FEES.TCG_CAP) + FEES.TCG_PCT * p + FEES.TCG_FIXED) - shipOut(p); }
export function shopTrade(p) { return p * (p > SHOP.THRESHOLD ? SHOP.TRADE_OVER : SHOP.TRADE_UNDER); }
export function shopCash(p) { return p * (p > SHOP.THRESHOLD ? SHOP.CASH_OVER : SHOP.CASH_UNDER); }

function gradeDecision(price, cls) {
  const f = GRADING.SELL_FEE, rawNet = price * (1 - f);
  const p = GRADING.CLASS[cls];
  if (price < GRADING.MIN_RAW || !p) return { grade: false, gap: 0, reason: "" };
  const pBelow = Math.max(0, 1 - p.p10 - p.p9);
  const M = p.p10 * p.m10 + p.p9 * p.m9 + pBelow * p.m8;
  const expected10 = price * p.m10;
  const eligible = GRADING.TIERS.filter((t) => t.cap >= expected10);
  const tiers = eligible.length ? eligible : [GRADING.TIERS[GRADING.TIERS.length - 1]];
  let best = -Infinity, bestTier = "";
  for (const t of tiers) {
    const gnet = price * M * (1 - f) - (t.fee + GRADING.SHIP) - price * (GRADING.DEBT_APR / 12) * t.months;
    if (gnet > best) { best = gnet; bestTier = t.name; }
  }
  const gap = best - rawNet;
  const grade = M > 1 && gap > 0;
  return { grade, gap: Math.round(gap * 100) / 100,
           reason: grade ? `${cls}: graded EV $${Math.round(best)} vs raw $${Math.round(rawNet)} (+$${Math.round(gap)}) via ${bestTier} — verify centering first` : "" };
}

function valueTier(p) { return p >= 100 ? "HIGH" : p >= 10 ? "MID" : p >= 3 ? "LOW" : "BULK"; }
function priceBand(p) { return p < 1 ? "u1" : p < 5 ? "1_5" : p < 50 ? "5_50" : "o50"; }

export function routeRow(category, setName, rarity, name, variance, number, price) {
  const flags = [];
  if (price >= FEES.AUTH_THRESHOLD) flags.push("ebay-authenticity-$250+");
  const tracking = price > ROUTER.TCGP_TRACKING;
  if (tracking) flags.push("tcgp-tracking-$50+");
  const scarce = isScarce(setName, rarity, name, variance, number);
  const e = ebayNet(price), t = tcgNet(price);

  let channel, reason;
  if (price < ROUTER.BULK_CEILING) { channel = "LCS"; reason = "under $5 — local card shop (80/70% trade)"; }
  else if (scarce && price >= ROUTER.EBAY_SCARCE_MIN) { channel = "eBay (auction)"; reason = "scarce/chase — auction realizes above market"; flags.push("scarce"); }
  else if (tracking) { channel = "eBay (fixed)"; reason = "$50+ — avoid TCGplayer tracking requirement"; }
  else if (e > t) { channel = "eBay (fixed)"; reason = "net-best fixed price"; }
  else { channel = "TCGplayer"; reason = "net-best fixed price (or tie)"; }

  const st = shopTrade(price), sc = shopCash(price);
  const netUnit = channel === "LCS" ? st : channel.startsWith("eBay") ? e : t;
  const cls = cardClass(setName, rarity, name);
  const isPk = category === "Pokemon";
  const m10 = isPk ? (GRADING.CLASS[cls] || {}).m10 || 0 : 0;
  const gd = isPk ? gradeDecision(price, cls) : { grade: false, gap: 0, reason: "" };
  return {
    channel, channel_reason: reason, flags,
    net_unit: Math.round(netUnit * 100) / 100,
    net_pct: price ? Math.round((netUnit / price) * 1000) / 1000 : 0,
    shop_trade: Math.round(st * 100) / 100, shop_cash: Math.round(sc * 100) / 100,
    psa10: Math.round(price * m10 * 100) / 100, psa10_x: m10,
    grade_flag: gd.grade, grade_gap: gd.gap, grade_reason: gd.reason,
    value_tier: valueTier(price), band: priceBand(price), card_class: cls,
  };
}

// ── Image URL construction (pokemontcg.io CDN, no per-card search) ──────────
let _sets = null;
async function loadSets() {
  if (_sets) return _sets;
  try {
    const cached = JSON.parse(localStorage.getItem("ptcgSets") || "null");
    if (cached && Date.now() - cached.ts < 7 * 864e5) return (_sets = cached.sets);
  } catch (e) { /* refetch */ }
  try {
    const r = await fetch("https://api.pokemontcg.io/v2/sets?pageSize=250&select=id,name,printedTotal,total");
    const sets = (await r.json()).data || [];
    if (sets.length) { _sets = sets; localStorage.setItem("ptcgSets", JSON.stringify({ ts: Date.now(), sets })); }
    return _sets || [];
  } catch (e) { return []; }
}
const setWords = (s) => new Set((s.toLowerCase().match(/\w+/g) || []).filter((w) => !SET_STOPWORDS.has(w)));
const _setWordCache = new Map();   // per-API-set word sets, computed once
const _setIdCache = new Map();     // (setName|denom) → set id or null

export async function pokemonImageUrl(setName, number) {
  const alias = SETID_ALIASES[(setName || "").trim().toLowerCase()];
  const num = (number || "").split("/")[0].replace(/^0+(?=\d)/, "") || "";
  if (!num) return null;
  if (alias) return `https://images.pokemontcg.io/${alias}/${num}.png`;
  const sets = await loadSets();
  if (!sets.length) return null;
  let denom = null;
  if ((number || "").includes("/")) {
    const d = number.split("/")[1].trim().replace(/^0+/, "");
    if (/^\d+$/.test(d)) denom = d;
  }
  const cacheKey = (setName || "") + "|" + denom;
  if (_setIdCache.has(cacheKey)) {
    const id = _setIdCache.get(cacheKey);
    return id ? `https://images.pokemontcg.io/${id}/${num}.png` : null;
  }
  let cands = sets;
  if (denom) {
    const dm = sets.filter((s) => String(s.printedTotal) === denom || String(s.total) === denom);
    if (dm.length === 1) { _setIdCache.set(cacheKey, dm[0].id); return `https://images.pokemontcg.io/${dm[0].id}/${num}.png`; }
    if (dm.length) cands = dm;
  }
  const target = setWords(setName || "");
  const scored = cands.map((s) => {
    if (!_setWordCache.has(s.id)) _setWordCache.set(s.id, setWords(s.name));
    return [[..._setWordCache.get(s.id)].filter((w) => target.has(w)).length, s];
  }).sort((a, b) => b[0] - a[0]);
  const winner = (scored.length && scored[0][0] > 0 && (scored.length === 1 || scored[0][0] > scored[1][0]))
    ? scored[0][1].id : null;
  _setIdCache.set(cacheKey, winner);
  return winner ? `https://images.pokemontcg.io/${winner}/${num}.png` : null;
}

// Scryfall's named-card endpoint IS an image URL (redirects to the card scan) —
// no per-card pre-resolution needed. Fuzzy match may show a different printing's
// art for reprints, but it's always the right card.
export function mtgImageUrl(name) {
  const clean = (name || "").replace(/\s*\([^)]*\)/g, "").split(" - ")[0].trim();
  if (!clean) return null;
  return "https://api.scryfall.com/cards/named?format=image&version=normal&fuzzy=" + encodeURIComponent(clean);
}

// ── TCGplayer Seller Portal export helpers (matcher-lite, ported) ───────────
export const TCGP_SET_ALIASES = {
  "SV: 151": "SV: Scarlet & Violet 151",
  "Pokemon 151": "SV: Scarlet & Violet 151",
  "Prismatic Evolutions": "SV: Prismatic Evolutions",
  "Paldean Fates": "SV: Paldean Fates",
  "Shrouded Fable": "SV: Shrouded Fable",
  "Stellar Crown": "SV07: Stellar Crown",
  "Scarlet & Violet Promo": "SV: Scarlet & Violet Promo Cards",
  "Sword & Shield Promo": "SWSH: Sword & Shield Promo Cards",
  "Sun & Moon Promo": "SM Promos",
  "Art Series: March of the Machines": "Art Series: March of the Machine",
  "Strixhaven: Mystical Archives": "Strixhaven: Mystical Archive",
  "The List": "The List Reprints",
  "Universes Beyond: FINAL FANTASY": "FINAL FANTASY",
  "Universes Beyond: FINAL FANTASY: Through the Ages": "FINAL FANTASY: Through the Ages",
};

export function normSetTCGP(name) {
  return (name || "").normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
}
export function normNumTCGP(num) {
  return ((num || "").trim().split("/")[0]).replace(/^0+(?=\d)/, "");
}

const COND_PREFIX = { NM: "Near Mint", LP: "Lightly Played", MP: "Moderately Played",
                      HP: "Heavily Played", DMG: "Damaged" };
const PKMN_VAR_SUFFIX = { "Normal": "", "Holofoil": "Holofoil", "Reverse Holofoil": "Reverse Holofoil",
  "Poke Ball Reverse Holo": "Reverse Holofoil", "Master Ball Reverse Holo": "Reverse Holofoil",
  "Unlimited": "Unlimited", "Unlimited Holofoil": "Unlimited Holofoil",
  "1st Edition": "1st Edition", "1st Edition Holofoil": "1st Edition Holofoil" };

export function tcgpCondition(category, variance, cond) {
  const prefix = COND_PREFIX[cond || "NM"] || "Near Mint";
  if (category === "Magic: The Gathering") {
    if (variance === "Foil") return prefix + " Foil";
    if (variance === "Normal" || !variance) return prefix;
    return null;
  }
  const sfx = PKMN_VAR_SUFFIX[variance || "Normal"];
  if (sfx === undefined) return null;
  return sfx ? prefix + " " + sfx : prefix;
}

// ── Full import: CSV text → cloud card rows ─────────────────────────────────
export async function buildRows(csvText, existingByKey, onProgress) {
  const raw = parseCSV(csvText);
  const mkCol = Object.keys(raw[0] || {}).find((k) => k.startsWith("Market Price"));
  const out = [], seen = new Set();
  let skipped = 0;
  await loadSets();   // one fetch, cached — images resolve synchronously after

  for (let i = 0; i < raw.length; i++) {
    if (onProgress && i % 400 === 0) onProgress(`Processing ${i}/${raw.length}…`);
    const r = raw[i];
    const category = r["Category"] || "";
    const setName = r["Set"] || "", name = r["Product Name"] || "";
    const number = r["Card Number"] || "", variance = r["Variance"] || "";
    const rarity = r["Rarity"] || "", grade = r["Grade"] || "Ungraded";
    const qty = parseInt(r["Quantity"]) || 1;
    const market = parseFloat(mkCol ? r[mkCol] : 0) || 0;
    if (!name) { skipped++; continue; }

    const nkey = await naturalKey(category, setName, number, variance, name);
    if (seen.has(nkey)) continue;
    seen.add(nkey);
    const prev = existingByKey[nkey] || {};
    const condition = prev.condition || "NM";
    const tags = prev.tags || [];
    const keep = !!prev.keep;
    const effective = Math.round(market * (COND_FACTORS[condition] || 1) * 100) / 100;

    // Bucketing (mirrors the local server)
    let bucket = null, xflags = [];
    const isGraded = grade && grade !== "Ungraded";
    const isSealed = SEALED_RE.test(name) || SEALED_BRACKET_RE.test(name);
    if (isGraded) bucket = "graded";
    else if (isSealed) bucket = "sealed";
    else if (TOKEN_RE.test(name) || MISC_SETS.has(setName)) { skipped++; continue; }
    else if (category === "Pokemon") { bucket = "pkmn"; if (JP_SETS.has(setName)) xflags.push("japanese"); }
    else if (category === "Magic: The Gathering") { bucket = "mtg"; if (setName.startsWith("Art Series:")) xflags.push("art-card"); }
    else if (category === "YuGiOh") bucket = "ygo";
    else { skipped++; continue; }

    if (bucket === "graded" || bucket === "sealed") {
      // Graded cards use the same art as the ungraded card.
      const gimg = (bucket === "graded" && category === "Pokemon")
        ? await pokemonImageUrl(setName, number)
        : (bucket === "graded" && category === "Magic: The Gathering") ? mtgImageUrl(name) : null;
      out.push({ natural_key: nkey, bucket, name, set_name: setName, number, variance,
                 grade, qty, price: Math.round(market * qty * 100) / 100, market_price: market,
                 condition: "NM", channel: "", channel_reason: "", flags: [], band: "",
                 psa10: 0, psa10_real: false, psa10_x: 0, shop_trade: 0, shop_cash: 0,
                 net_unit: 0, net_pct: 0, grade_flag: false, grade_gap: 0, grade_reason: "",
                 keep: false, tags: [], image_url: gimg });
      continue;
    }

    const route = routeRow(category, setName, rarity, name, variance, number, effective);
    let img = null;
    if (category === "Pokemon") img = await pokemonImageUrl(setName, number);
    else if (category === "Magic: The Gathering") img = mtgImageUrl(name);
    out.push({ natural_key: nkey, bucket, name, set_name: setName, number, variance,
               grade: "", qty, price: effective, market_price: market, condition,
               ...route, flags: [...route.flags, ...xflags], psa10_real: false,
               keep, tags, image_url: img });
  }
  if (onProgress) onProgress(`Processed ${out.length} cards (${skipped} skipped)`);
  return out;
}
