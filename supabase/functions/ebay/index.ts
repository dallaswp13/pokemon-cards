// eBay ending-soon radar. Client-credentials OAuth (App ID + Cert ID from app_secrets,
// never in the browser) -> Browse item_summary/search, filtered to auctions ending in the
// next N minutes (itemEndDate upper-bound filter), each bid comped against PriceCharting.
//
//   POST {action:'radar', minutes, marketplace?, dealPct?, floor?, cap?}  (signed-in user)
//   POST {q, limit, auctionOnly, maxPrice}                                (legacy search)
//   GET  ?selftest=1        -> proves OAuth works
//   GET  ?radartest=<min>   -> runs radar unauthenticated (small cap) for dev verification
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const CAT = "183454"; // eBay CCG Individual Cards
const ASPECT = "categoryId:183454,Game:{Pokémon TCG},Language:{English}";

async function appToken(admin: any): Promise<string> {
  const { data } = await admin.from("app_secrets").select("key,value").in("key", ["ebay_client_id", "ebay_client_secret"]);
  const m: Record<string, string> = {};
  (data || []).forEach((r: any) => (m[r.key] = r.value));
  if (!m.ebay_client_id || !m.ebay_client_secret) throw new Error("ebay keyset not configured");
  const basic = btoa(`${m.ebay_client_id}:${m.ebay_client_secret}`);
  const r = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
    body: "grant_type=client_credentials&scope=" + encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("oauth failed: " + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}

function trim(it: any) {
  const ship = it.shippingOptions?.[0]?.shippingCost?.value;
  return {
    itemId: it.itemId,
    title: it.title as string,
    price: it.price ? Number(it.price.value) : null,
    curBid: it.currentBidPrice ? Number(it.currentBidPrice.value) : (it.price ? Number(it.price.value) : null),
    ship: ship != null ? Number(ship) : null,
    buying: it.buyingOptions || [],
    endDate: it.itemEndDate || null,
    bids: it.bidCount ?? null,
    condition: it.condition || null,
    url: it.itemWebUrl,
    img: it.image?.imageUrl || null,
  };
}

async function browsePage(token: string, mkt: string, filter: string, offset: number, limit = 200) {
  const p = new URLSearchParams({ category_ids: CAT, filter, aspect_filter: ASPECT, limit: String(limit), offset: String(offset) });
  const r = await fetch("https://api.ebay.com/buy/browse/v1/item_summary/search?" + p.toString(), {
    headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": mkt },
  });
  const j = await r.json();
  if (j.errors) throw new Error("browse: " + JSON.stringify(j.errors).slice(0, 300));
  return { total: j.total ?? 0, items: (j.itemSummaries || []).map(trim) };
}

async function browseSearch(token: string, q: string, limit: number, auctionOnly: boolean, maxPrice: number) {
  const p = new URLSearchParams({ q, limit: String(Math.min(limit || 50, 200)) });
  const filters: string[] = [];
  if (auctionOnly) filters.push("buyingOptions:{AUCTION}");
  if (maxPrice > 0) filters.push(`price:[..${maxPrice}],priceCurrency:USD`);
  if (filters.length) p.set("filter", filters.join(","));
  const r = await fetch("https://api.ebay.com/buy/browse/v1/item_summary/search?" + p.toString(), {
    headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" },
  });
  const j = await r.json();
  if (j.errors) throw new Error("browse: " + JSON.stringify(j.errors).slice(0, 300));
  return (j.itemSummaries || []).map(trim);
}

// ---- comp: title -> normalized query + grade tier + match guard ----
const STOP = new Set("pokemon pokémon tcg ccg card cards holo holofoil foil reverse graded ungraded english japanese the of and for with wizards coast nintendo company original rare common uncommon double ultra secret full art alt promo edition gym game freak lot near mint played light heavy moderate damaged sealed pack booster".split(" "));
function toks(s: string): string[] {
  return (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
}
function gradeTier(title: string, condition: string | null): "loose" | "psa9" | "psa10" | null {
  const graded = (condition || "").toLowerCase() === "graded" || /\b(psa|bgs|cgc|sgc|ace|beckett)\b/i.test(title);
  if (!graded) return "loose";
  const m = title.match(/\b(?:psa|bgs|cgc|sgc|ace|beckett)?\s*\.?\s*(10|9\.5|9)\b/i);
  if (!m) return null;
  return parseFloat(m[1]) >= 9.5 ? "psa10" : "psa9";
}
function stripTitle(t: string): string {
  // Keep variant words (holo / reverse / shadowless / 1st edition / jumbo) in the query
  // so PriceCharting returns the right variant; only strip grades and punctuation.
  return t
    .replace(/\b(psa|bgs|cgc|sgc|ace|beckett)\s*\.?\s*\d+(?:\.\d)?\b/gi, " ")
    .replace(/\bgem\s*mint\b/gi, " ")
    .replace(/[^\w\s\/#-]/g, " ")
    .replace(/\s+/g, " ").trim();
}
function cardNum(t: string): string | null {
  const m = t.match(/(\d{1,4})\s*\/\s*\d{1,4}/);
  return m ? String(parseInt(m[1], 10)) : null;
}
// Same condition-pricing as the rest of the portal (engine.js COND_FACTORS): a card's
// market is its NM price scaled by condition. Parsed from the listing title (eBay's
// `condition` field only says Ungraded/Graded); default NM when unstated, like the portal.
const COND_FACTORS: Record<string, number> = { NM: 1.0, LP: 0.9, MP: 0.75, HP: 0.6, DMG: 0.5 };
function condFromTitle(t: string): string {
  // Drop "100 HP" / "50 HP" first — that's the card's hit points, not the HP (heavily-played) grade.
  const s = t.toLowerCase().replace(/\b\d+\s*hp\b/g, " ");
  if (/\bdmg\b|\bdamaged\b|\bpoor\b/.test(s)) return "DMG";
  if (/\bhp\b|heavily\s*played|heavy\s*play/.test(s)) return "HP";
  if (/\bmp\b|moderately\s*played|mod(erate)?\s*play/.test(s)) return "MP";
  if (/\blp\b|lightly\s*played|light\s*play|\bplayed\b/.test(s)) return "LP";
  return "NM";
}
// Price-significant variants. If the listing asserts one the comp product doesn't (or
// vice-versa), the fuzzy match grabbed the wrong variant — reject it.
function variantFlags(s: string) {
  const t = s.toLowerCase();
  return {
    first: /1st\s*ed|first\s*ed/.test(t),
    shadowless: /shadowless/.test(t),
    jumbo: /jumbo|oversized|oversize/.test(t),
    reverse: /reverse\s*-?\s*holo|\brev\s*holo/.test(t),
  };
}
// PriceCharting bracket variants that command big premiums; if the product carries one
// the listing title never mentions, the fuzzy match grabbed the wrong (pricier) variant.
const PREM = ["pokemon center", "prize pack", "pre-release", "prerelease", "staff", "stamped", "gold star", "shining", "jumbo", "oversized", "trophy", "champions", "world championship"];

type Comp = { product: string | null; console: string | null; loose: number | null; psa9: number | null; psa10: number | null };

async function compBatch(admin: any, pcToken: string, keys: string[], queries: Record<string, string>, cap: number): Promise<Record<string, Comp>> {
  const out: Record<string, Comp> = {};
  const { data: cached } = await admin.from("comp_cache").select("*").in("q_key", keys);
  const fresh = Date.now() - 3 * 864e5;
  const have = new Set<string>();
  (cached || []).forEach((c: any) => {
    if (new Date(c.fetched_at).getTime() >= fresh) {
      out[c.q_key] = { product: c.product, console: c.console, loose: c.loose, psa9: c.psa9, psa10: c.psa10 };
      have.add(c.q_key);
    }
  });
  const misses = keys.filter((k) => !have.has(k)).slice(0, cap);
  const CONC = 8;
  let i = 0;
  const upserts: any[] = [];
  async function worker() {
    while (i < misses.length) {
      const k = misses[i++];
      try {
        const r = await fetch(`https://www.pricecharting.com/api/product?t=${pcToken}&q=${encodeURIComponent(queries[k])}`, { headers: { "User-Agent": "Liquidatr/1.0" } });
        const j = await r.json();
        const cents = (v: unknown) => (typeof v === "number" ? Math.round(v) / 100 : null);
        const c: Comp = j?.status === "success"
          ? { product: j["product-name"] ?? null, console: j["console-name"] ?? null, loose: cents(j["loose-price"]), psa9: cents(j["graded-price"]), psa10: cents(j["manual-only-price"]) }
          : { product: null, console: null, loose: null, psa9: null, psa10: null };
        out[k] = c;
        upserts.push({ q_key: k, product: c.product, console: c.console, loose: c.loose, psa9: c.psa9, psa10: c.psa10, fetched_at: new Date().toISOString() });
      } catch { /* skip */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, misses.length) }, worker));
  if (upserts.length) await admin.from("comp_cache").upsert(upserts, { onConflict: "q_key" });
  return out;
}

async function radar(admin: any, token: string, pcToken: string, minutes: number, opts: { mkt?: string; dealPct?: number; floor?: number; cap?: number; maxItems?: number; comp?: boolean }) {
  const mkt = opts.mkt || "EBAY_US";
  const dealPct = opts.dealPct ?? 0.25;
  const floor = opts.floor ?? 5;
  const cap = opts.cap ?? 200;
  const maxItems = opts.maxItems ?? 1000;
  const upper = new Date(Date.now() + minutes * 60000).toISOString().replace(/\.\d{3}Z$/, ".000Z");
  const filter = `buyingOptions:{AUCTION},itemEndDate:[..${upper}]`;

  const items: any[] = [];
  let total = 0;
  for (let off = 0; off < maxItems; off += 200) {
    const pg = await browsePage(token, mkt, filter, off);
    total = pg.total;
    items.push(...pg.items);
    if (items.length >= total || pg.items.length === 0) break;
  }
  items.sort((a, b) => (a.endDate || "").localeCompare(b.endDate || ""));

  const doComp = opts.comp !== false;   // false = listings only (fast); true = pull + price
  const queries: Record<string, string> = {};
  for (const it of items) {
    const stripped = stripTitle(it.title);
    it._tier = gradeTier(it.title, it.condition);
    it._key = (it._tier === "loose" ? "raw:" : "grd:") + stripped.toLowerCase();
    it._num = cardNum(it.title);
    it._ttoks = toks(stripped);
    it._cond = condFromTitle(it.title);
    it._vf = variantFlags(it.title);
    if (it._tier) queries[it._key] = "pokemon " + stripped;
  }
  const comps = doComp ? await compBatch(admin, pcToken, Object.keys(queries), queries, cap) : {};

  let deals = 0;
  const rows = items.map((it) => {
    const c = doComp && it._tier ? comps[it._key] : null;
    let market: number | null = null, matched = false;
    if (c) {
      const raw = it._tier === "psa10" ? c.psa10 : it._tier === "psa9" ? c.psa9 : c.loose;
      // Condition multiplier applies only to ungraded prices — a slab's grade sets its price.
      market = (it._tier === "loose" && raw != null) ? Math.round(raw * (COND_FACTORS[it._cond] || 1) * 100) / 100 : raw;
      const prodRaw = (c.product || "").toLowerCase();
      const tl = it.title.toLowerCase();
      const hay = (prodRaw + " " + (c.console || "")).toLowerCase();
      const jpBad = /japan|chinese|korean/.test(hay) && !/japan|chinese|korean/.test(tl);
      const premBad = PREM.some((k) => prodRaw.includes(k) && !tl.includes(k) && !tl.includes(k.replace("-", " ")));
      const pf = variantFlags(hay), tf = it._vf;
      const variantBad = tf.first !== pf.first || tf.shadowless !== pf.shadowless || tf.jumbo !== pf.jumbo || tf.reverse !== pf.reverse;
      const ptoks = new Set(toks((c.product || "") + " " + (c.console || "")));
      const share = it._ttoks.filter((w: string) => ptoks.has(w)).length;
      const numOk = it._num ? hay.includes(it._num) : false;
      matched = !jpBad && !premBad && !variantBad && ((numOk && share >= 1) || (!it._num && share >= 2));
    }
    const eff = (it.curBid ?? 0) + (it.ship ?? 0);
    let deltaPct: number | null = null, deal = false;
    if (matched && market && market >= floor && eff > 0) {
      deltaPct = (market - eff) / market;
      deal = deltaPct >= dealPct;
      if (deal) deals++;
    }
    return {
      title: it.title, url: it.url, img: it.img, endDate: it.endDate, bids: it.bids,
      condition: it.condition, cond: it._cond, curBid: it.curBid, ship: it.ship, eff: Math.round(eff * 100) / 100,
      tier: it._tier, market, product: c?.product || null, console: c?.console || null,
      matched, deltaPct: deltaPct != null ? Math.round(deltaPct * 1000) / 1000 : null, deal,
    };
  });
  return { minutes, total, pulled: items.length, didComp: doComp, comped: Object.keys(comps).length, deals, rows };
}

const admin = () => createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
async function pcTokenOf(a: any): Promise<string> {
  const { data } = await a.from("app_secrets").select("value").eq("key", "pricecharting").maybeSingle();
  if (!data?.value) throw new Error("pricecharting key not configured");
  return data.value;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = new URL(req.url);
    if (req.method === "GET" && url.searchParams.get("selftest")) {
      const token = await appToken(admin());
      const sample = await browseSearch(token, "charizard", 1, false, 0);
      return json({ ok: true, tokenLen: token.length, sampleCount: sample.length, sampleTitle: sample[0]?.title || null });
    }
    if (req.method === "GET" && url.searchParams.get("radartest")) {
      const a = admin();
      const min = Math.min(Math.max(parseInt(url.searchParams.get("radartest")!, 10) || 15, 1), 60);
      const comp = url.searchParams.get("comp") === "1";
      const token = await appToken(a); const pc = await pcTokenOf(a);
      const res = await radar(a, token, pc, min, { cap: 60, maxItems: 200, comp });
      return json(res);
    }
    if (req.method !== "POST") return json({ error: "POST only" }, 405);
    const anon = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization") || "" } } });
    const { data: { user } } = await anon.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
    const body = await req.json();
    if (body?.action === "radar") {
      const a = admin();
      const min = Math.min(Math.max(+body.minutes || 30, 1), 90);
      const token = await appToken(a); const pc = await pcTokenOf(a);
      const res = await radar(a, token, pc, min, {
        mkt: body.marketplace, dealPct: body.dealPct != null ? +body.dealPct : undefined,
        floor: body.floor != null ? +body.floor : undefined, cap: body.cap != null ? +body.cap : undefined,
        comp: body.comp,
      });
      return json(res);
    }
    const { q, limit, auctionOnly, maxPrice } = body;
    if (!q || typeof q !== "string") return json({ error: "bad query" }, 400);
    const token = await appToken(admin());
    const items = await browseSearch(token, q, limit, !!auctionOnly, +maxPrice || 0);
    return json({ items });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e).slice(0, 300) }, 500);
  }
});
