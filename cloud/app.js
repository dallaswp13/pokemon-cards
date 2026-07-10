/* Sell Cockpit (cloud) — self-contained collection cockpit on Supabase.
   Import Collectr CSV → tabs/piles → tag, condition, photograph, price,
   export LCS + TCGplayer sheets. Data is per-user (RLS). */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildRows, parseCSV, normSetTCGP, normNumTCGP, TCGP_SET_ALIASES, tcgpCondition } from "./engine.js";

const SUPABASE_URL = "https://xmcohwtftpmnanootpia.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhtY29od3RmdHBtbmFub290cGlhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM2ODU5NTcsImV4cCI6MjA5OTI2MTk1N30.YVOa8JBdaJH9aXXsyUjOhdwKiohj4SZ6rVia36KfP0k";
const FN_PRICES = SUPABASE_URL + "/functions/v1/prices";
const sb = createClient(SUPABASE_URL, SUPABASE_ANON);

const $ = (s) => document.querySelector(s);
const RENDER_CAP = 300;
const COND_FACTORS = { NM: 1.0, LP: 0.9, MP: 0.75, HP: 0.6, DMG: 0.5 };
const CHANNEL_CLASS = { "eBay (auction)": "ch-ebay-auction", "eBay (fixed)": "ch-ebay-fixed",
                        "TCGplayer": "ch-tcg", "LCS": "ch-bulk" };
const SORTS = {
  value: (a, b) => b.price - a.price,
  psa10x: (a, b) => (b.psa10_x || 0) - (a.psa10_x || 0),
  netpct: (a, b) => (b.net_pct || 0) - (a.net_pct || 0),
};
// Category tabs show UNDECIDED cards only; piles collect what you've filed.
const CAT_TABS = [["pkmn", "Pkmn"], ["mtg", "MTG"], ["ygo", "YGO"],
                  ["graded", "Graded"], ["sealed", "Sealed"]];
const PILE_TABS = [["p_keep", "★ Keep"], ["p_grade", "◆ Grade"],
                   ["p_shop", "🏪 Shop"], ["p_check", "🔍 Check"]];

let rows = [];
let tab = localStorage.getItem("sellTab") || "pkmn";
const filters = { channel: "", band: "", grade: "", oc: "", tag: "", search: "" };
let sortKey = "value";
let viewMode = localStorage.getItem("sellViewMode") || "grid";

const money = (n) => "$" + Math.round(n).toLocaleString();
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const hasTag = (r, t) => (r.tags || []).includes(t);
const notNM = (r) => hasTag(r, "not-nm");
const offC = (r) => hasTag(r, "off-center");
const hasPhotos = (r) => (r.photos || []).length > 0;
// A card is "decided" once it's filed into any pile — raw tabs show the rest.
const decided = (r) => r.keep || hasTag(r, "to-grade") || hasTag(r, "shop") || notNM(r);
const isRawBucket = (b) => ["pkmn", "mtg", "ygo"].includes(b);

// ── Auth ────────────────────────────────────────────────────────────────────
async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (session) { showCockpit(); } else { showAuth(); }
  sb.auth.onAuthStateChange((_e, s) => { if (s) showCockpit(); else showAuth(); });
}
function showAuth() {
  $("#auth-section").classList.remove("hidden");
  $("#sell-section").classList.add("hidden");
}
function showCockpit() {
  $("#auth-section").classList.add("hidden");
  $("#sell-section").classList.remove("hidden");
  load();
}
async function signIn() {
  const { error } = await sb.auth.signInWithPassword({ email: $("#auth-email").value.trim(), password: $("#auth-pass").value });
  $("#auth-status").textContent = error ? error.message : "";
}
async function signUp() {
  const { error } = await sb.auth.signUp({ email: $("#auth-email").value.trim(), password: $("#auth-pass").value });
  $("#auth-status").textContent = error ? error.message : "Account created — check your email to confirm, then sign in.";
}

// ── Data ────────────────────────────────────────────────────────────────────
async function load() {
  $("#sell-meta").textContent = "Loading…";
  rows = [];
  for (let from = 0; from < 20000; from += 1000) {
    // Secondary sort on id keeps pagination stable — price alone has thousands
    // of ties, which made pages overlap and cards appear duplicated.
    const { data, error } = await sb.from("cards").select("*")
      .order("price", { ascending: false }).order("id", { ascending: true })
      .range(from, from + 999);
    if (error) { $("#sell-meta").textContent = error.message; return; }
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  renderSummary(); renderTabs(); render();
}

async function save(row, patch) {
  Object.assign(row, patch);
  await sb.from("cards").update(patch).eq("id", row.id);
}

// ── Summary + tabs ──────────────────────────────────────────────────────────
function pileOf(r) {
  if (r.keep) return "p_keep";
  if (hasTag(r, "to-grade")) return "p_grade";
  if (hasTag(r, "shop")) return "p_shop";
  if (notNM(r)) return "p_check";
  return null;
}

function summaryOf() {
  const sellable = rows.filter((r) => isRawBucket(r.bucket) && !r.keep);
  const mkt = sellable.reduce((a, r) => a + r.price * (r.qty || 1), 0);
  const net = sellable.reduce((a, r) => a + (r.net_unit || 0) * (r.qty || 1), 0);
  const buckets = {};
  for (const [k] of CAT_TABS) {
    const rs = rows.filter((r) => r.bucket === k && (!isRawBucket(k) || !decided(r)));
    buckets[k] = { market: rs.reduce((a, r) => a + r.price * (isRawBucket(k) ? (r.qty || 1) : 1), 0), count: rs.length };
  }
  for (const [k] of PILE_TABS) {
    const rs = rows.filter((r) => isRawBucket(r.bucket) && pileOf(r) === k);
    buckets[k] = { market: rs.reduce((a, r) => a + r.price * (r.qty || 1), 0), count: rs.length };
  }
  const keepers = rows.filter((r) => r.keep);
  return { mkt, net, pct: mkt ? net / mkt : 0, buckets,
           grade: rows.filter((r) => r.grade_flag && !offC(r)).length,
           keepers: keepers.length, keepersVal: keepers.reduce((a, r) => a + r.price * (r.qty || 1), 0) };
}

function renderSummary() {
  const s = summaryOf();
  $("#sell-summary").innerHTML = `
    <div class="sum-head"><div><span class="sum-pct">${Math.round(s.pct * 100)}%</span> recovered
      <span class="dim">· net ${money(s.net)} of ${money(s.mkt)} raw market</span></div></div>
    <div class="sum-notes">
      <span class="sum-note grade">◆ ${s.grade} grade-first candidates</span>
      <span class="sum-note">★ ${s.keepers} keepers (${money(s.keepersVal)})</span>
    </div>`;
}

function renderTabs() {
  const s = summaryOf();
  const btn = ([key, label]) => {
    const b = s.buckets[key] || { market: 0, count: 0 };
    return `<button class="tab ${tab === key ? "active" : ""}" data-tab="${key}">
      ${label} <span class="tab-val">${money(b.market)}</span><span class="tab-ct">${b.count}</span></button>`;
  };
  $("#sell-tabs").innerHTML =
    CAT_TABS.map(btn).join("") +
    `<span class="tab-divider"></span>` +
    PILE_TABS.map(btn).join("");
  document.querySelectorAll("#sell-tabs .tab").forEach((b) =>
    b.addEventListener("click", () => { tab = b.dataset.tab; localStorage.setItem("sellTab", tab); renderTabs(); render(); }));
}

function passes(r) {
  const pile = pileOf(r);
  if (tab.startsWith("p_")) {
    if (!isRawBucket(r.bucket) || pile !== tab) return false;
  } else {
    if (r.bucket !== tab) return false;
    if (isRawBucket(tab) && pile) return false;   // filed cards leave the raw tab
  }
  if (filters.channel && r.channel !== filters.channel) return false;
  if (filters.band && r.band !== filters.band) return false;
  if (filters.grade && !r.grade_flag) return false;
  if (filters.oc && !offC(r)) return false;
  if (filters.tag && !(r.tags || []).some((x) => x.includes(filters.tag.toLowerCase()))) return false;
  if (filters.search) {
    const q = filters.search.toLowerCase();
    if (!((r.name || "") + " " + (r.set_name || "")).toLowerCase().includes(q)) return false;
  }
  return true;
}

function render() {
  const holdsTab = tab === "graded" || tab === "sealed";
  $("#sell-filters").style.display = holdsTab ? "none" : "";
  const shown = rows.filter(passes).sort(SORTS[sortKey] || SORTS.value);
  const val = shown.reduce((a, r) => a + r.price * (holdsTab ? 1 : r.qty || 1), 0);
  $("#sell-meta").textContent = `${shown.length} cards · ${money(val)}` +
    (shown.length > RENDER_CAP ? ` · showing first ${RENDER_CAP}` : "");
  $("#sell-empty").classList.toggle("hidden", shown.length > 0);
  const grid = $("#sell-grid");
  grid.className = "sell-grid" + (viewMode === "list" ? " list-view" : "");
  grid.innerHTML = "";
  const frag = document.createDocumentFragment();
  shown.slice(0, RENDER_CAP).forEach((r) => frag.appendChild(tile(r, holdsTab)));
  grid.appendChild(frag);
}

function flagChip(f) {
  if (String(f).startsWith("tcgp-tracking")) return `<span class="flag warn">📦 $50+</span>`;
  if (String(f).startsWith("ebay-authenticity")) return `<span class="flag lock">🔒 $250+</span>`;
  if (f === "scarce") return `<span class="flag scarce">✦ scarce</span>`;
  if (f === "japanese") return `<span class="flag">🇯🇵 JP</span>`;
  return `<span class="flag">${esc(f)}</span>`;
}

function psaLine(r) {
  if (r.bucket !== "pkmn" || !r.psa10) {
    return `<div class="tile-net">net $${Math.round(r.net_unit || 0)} · <b>${Math.round((r.net_pct || 0) * 100)}%</b> back</div>`;
  }
  const hot = (r.psa10_x || 0) >= 8;
  return `<div class="tile-psa ${hot ? "hot" : ""}">PSA10 ${r.psa10_real ? "" : "~"}${money(r.psa10)} · <b>${r.psa10_x}×</b>${hot ? " 🔥" : ""}</div>`;
}

function priceBlock(r) {
  const qty = r.qty || 1;
  return `<div class="price-row">
    <span class="price-big">$${(+r.price).toFixed(2)}</span>
    ${qty > 1 ? `<span class="qty-chip" title="Quantity">×${qty}</span>` : ""}
    ${r.condition && r.condition !== "NM" ? `<span class="cond-chip">${r.condition}</span>` : ""}
  </div>`;
}

function tile(r, holdsTab) {
  const el = document.createElement("div");
  el.className = "sell-tile" + (r.keep ? " is-keep" : "");
  const img = r.image_url ? `<img loading="lazy" src="${r.image_url}" onerror="this.classList.add('broken')">`
                          : `<div class="noimg">${holdsTab && r.bucket === "sealed" ? "📦" : "no image"}</div>`;
  if (holdsTab) {
    el.innerHTML = `
      <div class="tile-img">${img}<div class="tile-badges"><span class="tb">${r.bucket === "graded" ? "🏆" : "📦"}</span></div></div>
      <div class="tile-body">
        <div class="t-details">
          <div class="tile-name">${esc(r.name)}</div>
          <div class="tile-sub">${esc(r.set_name)}${r.grade && r.grade !== "Ungraded" ? " · " + esc(r.grade) : ""}</div>
          ${priceBlock(r)}
        </div>
        <div class="t-actions"><span class="badge ch-bulk">HOLD</span></div>
      </div>`;
    return el;
  }
  const badges =
    (notNM(r) ? '<span class="tb notnm">🔍</span>' : "") +
    (offC(r) ? '<span class="tb oc">◎</span>' : "") +
    (hasPhotos(r) ? '<span class="tb cam">📷</span>' : "");
  el.innerHTML = `
    <div class="tile-img">${img}<div class="tile-badges">${badges}</div></div>
    <div class="tile-body">
      <div class="t-details">
        <div class="tile-name">${r.keep ? "★ " : ""}${esc(r.name)}</div>
        <div class="tile-sub">${esc(r.set_name)} · #${esc(r.number) || "—"}</div>
        ${priceBlock(r)}
        ${psaLine(r)}
      </div>
      <div class="t-actions">
        <span class="badge ${CHANNEL_CLASS[r.channel] || ""}" title="${esc(r.channel_reason)}">${esc(r.channel)}</span>
        <div class="tile-flags">${r.grade_flag && !offC(r) ? `<span class="flag grade">◆ +${money(r.grade_gap || 0)}</span>` : ""}${(r.flags || []).map(flagChip).join("")}</div>
        <div class="quickbar">
          <button class="qb ${r.keep ? "on" : ""}" data-act="keep" title="Keep (personal collection)">★</button>
          <button class="qb ${notNM(r) ? "on" : ""}" data-act="notnm" title="Not NM → condition check pile">!NM</button>
          <button class="qb ${offC(r) ? "on" : ""}" data-act="oc" title="Off-center (excludes grading)">◎</button>
          <button class="qb ${hasTag(r, "to-grade") ? "on" : ""}" data-act="gradepile" title="Grading pile">◆</button>
          <button class="qb ${hasTag(r, "shop") ? "on" : ""}" data-act="shop" title="Shop drop-off pile">🏪</button>
        </div>
      </div>
    </div>`;
  el.addEventListener("click", (ev) => onClick(ev, r));
  return el;
}

async function toggleTag(r, t) {
  const has = hasTag(r, t);
  const tags = has ? (r.tags || []).filter((x) => x !== t) : [...(r.tags || []), t];
  await save(r, { tags });
}

async function onClick(ev, r) {
  const act = ev.target.dataset && ev.target.dataset.act;
  if (!act) { openCard(r); return; }
  ev.stopPropagation();
  if (act === "keep") await save(r, { keep: !r.keep });
  else if (act === "notnm") await toggleTag(r, "not-nm");
  else if (act === "oc") await toggleTag(r, "off-center");
  else if (act === "gradepile") await toggleTag(r, "to-grade");
  else if (act === "shop") await toggleTag(r, "shop");
  renderSummary(); renderTabs(); render();
}

// ── LCS drop-off price sheet ────────────────────────────────────────────────
function downloadCsv(lines, filename) {
  const blob = new Blob([lines.join("\r\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
const csvq = (s) => '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"';

function lcsCsv() {
  const picks = rows.filter((r) => hasTag(r, "shop") && !r.keep).sort((a, b) => b.price - a.price);
  if (!picks.length) { alert("No cards in the 🏪 Shop pile yet."); return; }
  let tv = 0, tt = 0, tc = 0;
  const lines = ["Card,Set,Number,Condition,Your Value,Trade (store credit),Cash"];
  for (const r of picks) {
    const v = +r.price || 0, t = +r.shop_trade || 0, c = +r.shop_cash || 0;
    tv += v; tt += t; tc += c;
    lines.push([csvq(r.name), csvq(r.set_name), csvq(r.number), csvq(r.condition || "NM"),
                v.toFixed(2), t.toFixed(2), c.toFixed(2)].join(","));
  }
  lines.push(["TOTAL", "", "", "", tv.toFixed(2), tt.toFixed(2), tc.toFixed(2)].join(","));
  downloadCsv(lines, "lcs_dropoff_" + new Date().toISOString().slice(0, 10) + ".csv");
}

// ── TCGplayer catalog (shared, from Seller Portal pricing exports) ──────────
async function catalogUpload(files) {
  const status = (m) => { $("#sell-meta").textContent = m; };
  let total = 0;
  for (const file of files) {
    status(`Parsing ${file.name}…`);
    const recs = parseCSV(await file.text());
    const rows = [];
    for (const r of recs) {
      const sku = parseInt(r["TCGplayer Id"]);
      if (!sku) continue;
      rows.push({
        sku_id: sku,
        product_line: r["Product Line"] || "",
        set_norm: normSetTCGP(r["Set Name"]),
        num_norm: normNumTCGP(r["Number"]),
        condition: r["Condition"] || "",
        raw: r,
      });
    }
    for (let i = 0; i < rows.length; i += 500) {
      status(`${file.name}: uploading ${Math.min(i + 500, rows.length).toLocaleString()}/${rows.length.toLocaleString()}…`);
      const { error } = await sb.from("tcgp_catalog").upsert(rows.slice(i, i + 500), { onConflict: "sku_id" });
      if (error) { status("Catalog upload failed: " + error.message); return; }
    }
    total += rows.length;
  }
  status(`TCGP catalog updated ✓ (${total.toLocaleString()} rows)`);
}

// ── TCGplayer upload-sheet export (matched by set + number + condition) ─────
const TCGP_HEADER = ["TCGplayer Id", "Product Line", "Set Name", "Product Name", "Title",
  "Number", "Rarity", "Condition", "TCG Market Price", "TCG Direct Low",
  "TCG Low Price With Shipping", "TCG Low Price", "Total Quantity", "Add to Quantity",
  "TCG Marketplace Price", "Photo URL"];

async function tcgpExport() {
  const { count } = await sb.from("tcgp_catalog").select("*", { count: "exact", head: true });
  if (!count) { alert("The TCGP catalog is empty — hit ⚙️ TCGP catalog and upload your Seller Portal pricing export CSV(s) first (one-time; refresh when new sets drop)."); return; }

  const picks = rows.filter((r) => isRawBucket(r.bucket) && !decided(r)
    && (r.channel === "TCGplayer" || hasTag(r, "tcgplayer")) && (r.qty || 1) > 0);
  if (!picks.length) { alert("No cards routed to TCGplayer."); return; }

  const status = (m) => { $("#sell-meta").textContent = m; };
  const matched = [], unmatched = [];
  let done = 0;
  const queue = [...picks];
  const worker = async () => {
    while (queue.length) {
      const r = queue.shift();
      done++;
      if (done % 20 === 0) status(`Matching ${done}/${picks.length}…`);
      const cond = tcgpCondition(r.category || (r.bucket === "mtg" ? "Magic: The Gathering" : "Pokemon"), r.variance, r.condition);
      const setName = TCGP_SET_ALIASES[(r.set_name || "").trim()] || r.set_name;
      const numN = normNumTCGP(r.number);
      if (!cond || !numN) { unmatched.push(r); continue; }
      const { data } = await sb.from("tcgp_catalog").select("raw")
        .eq("set_norm", normSetTCGP(setName)).eq("num_norm", numN).eq("condition", cond).limit(2);
      if (data && data.length === 1) matched.push([r, data[0].raw]);
      else unmatched.push(r);   // ambiguous (2+) or missing → manual
    }
  };
  await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);

  if (!matched.length) { alert(`0 of ${picks.length} matched — is the catalog current (right game files uploaded)?`); return; }
  const lines = [TCGP_HEADER.join(",")];
  for (const [r, raw] of matched) {
    const row = { ...raw };
    row["Add to Quantity"] = String(r.qty || 1);
    // TCGplayer rejects rows without a Marketplace Price — fall back through prices.
    if (!(row["TCG Marketplace Price"] || "").trim()) {
      row["TCG Marketplace Price"] = row["TCG Market Price"] || row["TCG Low Price With Shipping"]
        || row["TCG Low Price"] || row["TCG Direct Low"] || (+r.price).toFixed(2);
    }
    lines.push(TCGP_HEADER.map((h) => csvq(row[h] ?? "")).join(","));
  }
  downloadCsv(lines, "TCGplayer_add_" + new Date().toISOString().slice(0, 10) + ".csv");
  status(`TCGP sheet: ${matched.length} matched, ${unmatched.length} unmatched`);
  if (unmatched.length) {
    alert(`Exported ${matched.length} rows.\n\n${unmatched.length} didn't match the catalog (list these manually):\n` +
      unmatched.slice(0, 15).map((r) => `· ${r.name} — ${r.set_name} #${r.number}`).join("\n") +
      (unmatched.length > 15 ? `\n…and ${unmatched.length - 15} more` : ""));
  }
}

// ── Delete inventory ────────────────────────────────────────────────────────
async function deleteInventory() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return;
  if (!confirm(`Delete ALL ${rows.length} cards from your cloud inventory? (Photos and price history are kept; re-import restores tags by card.)`)) return;
  if (!confirm("Are you sure? This clears the card list.")) return;
  const { error } = await sb.from("cards").delete().eq("user_id", user.id);
  if (error) { alert("Delete failed: " + error.message); return; }
  load();
}

// ── Update prices (real market + PSA-10 via edge function) ──────────────────
async function updatePrices() {
  const btn = $("#prices-btn");
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return;
  const targets = rows.filter((r) => r.bucket === "pkmn" && !r.keep && r.price >= 10)
    .sort((a, b) => b.price - a.price);
  if (!targets.length) { alert("No Pokémon cards ≥ $10 to update."); return; }
  if (!confirm(`Fetch real market + PSA-10 prices for ${targets.length} Pokémon cards ($10+)?`)) return;
  btn.disabled = true;
  let done = 0, hit = 0, failed = 0, notConfigured = false;
  const hist = [];
  const queue = [...targets];
  const worker = async () => {
    while (queue.length && !notConfigured) {
      const r = queue.shift();
      try {
        const bare = r.name.replace(/\s*\([^)]*\)/g, "").split(" - ")[0].trim();
        const num = (r.number || "").split("/")[0];
        const resp = await fetch(FN_PRICES, {
          method: "POST",
          headers: { "Content-Type": "application/json", "apikey": SUPABASE_ANON,
                     "Authorization": "Bearer " + session.access_token },
          body: JSON.stringify({ q: `pokemon ${bare} ${num}`.trim() }),
        });
        if (resp.status === 503) { notConfigured = true; break; }
        if (resp.ok) {
          const d = await resp.json();
          const patch = {};
          if (d.loose) {
            patch.market_price = d.loose;
            patch.price = Math.round(d.loose * (COND_FACTORS[r.condition || "NM"] || 1) * 100) / 100;
          }
          if (d.psa10) { patch.psa10 = d.psa10; patch.psa10_real = true; }
          const base = patch.price || r.price;
          if (patch.psa10 && base) patch.psa10_x = Math.round((patch.psa10 / base) * 10) / 10;
          if (Object.keys(patch).length) {
            await save(r, patch);
            hist.push({ natural_key: r.natural_key, price: r.price, psa10: r.psa10 || 0 });
            hit++;
          } else failed++;
        } else failed++;
      } catch (e) { failed++; }
      done++;
      if (done % 5 === 0) btn.textContent = `💲 ${done}/${targets.length}…`;
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  for (let i = 0; i < hist.length; i += 500) {
    await sb.from("price_history").insert(hist.slice(i, i + 500));
  }
  btn.disabled = false;
  btn.textContent = "💲 Update prices";
  if (notConfigured) alert("Real prices aren't enabled yet — the PriceCharting key isn't configured server-side.");
  else alert(`Updated ${hit} cards with real market + PSA-10 prices${failed ? ` · ${failed} had no clean match` : ""}.`);
  renderSummary(); renderTabs(); render();
}

// ── eBay listing generator ──────────────────────────────────────────────────
function ebayListingText(r) {
  const game = r.bucket === "pkmn" ? "Pokemon TCG" : r.bucket === "mtg" ? "MTG Magic" : "Yu-Gi-Oh";
  let title = `${game} ${r.name} ${r.set_name} ${r.number || ""} ${r.condition || "NM"}`.replace(/\s+/g, " ").trim();
  if (title.length > 80) title = title.slice(0, 80).trim();
  const list = Math.round((+r.market_price || +r.price) * 1.15 * 100) / 100;
  const scarce = (r.flags || []).includes("scarce");
  return [
    `TITLE (${title.length}/80):`, title, "",
    `FORMAT: ${scarce ? "7-day auction · $0.99 start · NO reserve · end Sunday 7–10pm ET (scarce/chase)" : "Buy It Now + Best Offer"}`,
    `LIST PRICE: $${list.toFixed(2)}  (market $${(+r.market_price || +r.price).toFixed(2)} × 1.15)`,
    `BEST OFFER: auto-accept ≥ $${(list * 0.88).toFixed(2)} · auto-decline < $${(list * 0.65).toFixed(2)}`,
    `SHIPPING: ${r.price < 20 ? "eBay Standard Envelope (raw single < $20)" : r.price >= 250 ? "tracked mailer — routes through eBay Authenticity Guarantee ($250+)" : "USPS Ground Advantage, rigid tracked mailer"}`,
    "", "ITEM SPECIFICS:",
    `  Game: ${game}`,
    `  Card Name: ${r.name}`,
    `  Set: ${r.set_name}`,
    `  Card Number: ${r.number || "-"}`,
    `  Rarity/Finish: ${r.variance || "-"}`,
    `  Condition: ${r.condition === "NM" || !r.condition ? "Near Mint or Better" : r.condition}`,
    `  Language: ${(r.flags || []).includes("japanese") ? "Japanese" : "English"}`,
    `  Graded: No`,
  ].join("\n");
}

// ── Photos (Supabase Storage, private per-user) ─────────────────────────────
async function signedPhoto(uid, nkey, side) {
  const { data } = await sb.storage.from("card-photos").createSignedUrl(`${uid}/${nkey}/${side}.jpg`, 3600);
  return data?.signedUrl || null;
}
async function uploadPhoto(r, side, file) {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return;
  const path = `${user.id}/${r.natural_key}/${side}.jpg`;
  const { error } = await sb.storage.from("card-photos").upload(path, file, { upsert: true, contentType: file.type || "image/jpeg" });
  if (error) { alert("Photo upload failed: " + error.message); return; }
  const photos = Array.from(new Set([...(r.photos || []), side]));
  await save(r, { photos });
  openCard(r); render();
}
async function deletePhoto(r, side) {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return;
  await sb.storage.from("card-photos").remove([`${user.id}/${r.natural_key}/${side}.jpg`]);
  await save(r, { photos: (r.photos || []).filter((s) => s !== side) });
  openCard(r); render();
}
function photoSlot(r, side) {
  const has = (r.photos || []).includes(side);
  return `<div class="photo-slot">
      <label class="ps-drop" data-slot="${side}">
        ${has ? `<img data-photo="${side}" alt="${side}">` : `<span class="ps-hint">＋ ${side}</span>`}
        <input type="file" accept="image/*" capture="environment" data-side="${side}" hidden>
      </label>
      <div class="ps-row"><span>${side}</span>${has ? `<button class="linkbtn" data-mact="delphoto" data-side="${side}">remove</button>` : ""}</div>
    </div>`;
}

// ── Trend (price_history) ───────────────────────────────────────────────────
async function trendHtml(r) {
  const { data } = await sb.from("price_history").select("price,ts")
    .eq("natural_key", r.natural_key).order("ts", { ascending: true }).limit(100);
  if (!data || data.length < 2) return "";
  const first = data[0], last = data[data.length - 1];
  const days = (new Date(last.ts) - new Date(first.ts)) / 864e5;
  if (days < 1 || !+first.price) return "";
  const chg = (last.price - first.price) / first.price;
  const dir = chg > 0.03 ? "▲ rising" : chg < -0.03 ? "▼ falling" : "→ flat";
  return `<div class="m-line">${dir} ${(chg * 100).toFixed(0)}% over ${Math.round(days)}d <span class="dim">(${data.length} snapshots)</span></div>`;
}

// ── Modal (details left · actions right) ────────────────────────────────────
function closeCard() { $("#card-modal").classList.add("hidden"); }
function openCard(r) {
  const img = r.image_url ? `<img src="${r.image_url}">` : `<div class="noimg">no image</div>`;
  const psa = r.bucket === "pkmn" && r.psa10
    ? `<div class="m-line ${(r.psa10_x || 0) >= 8 ? "hot" : ""}">◆ PSA 10${r.psa10_real ? "" : " (est)"}: <b>${money(r.psa10)}</b> · ${r.psa10_x}× raw${(r.psa10_x || 0) >= 8 ? " 🔥 don't undersell" : ""}</div>` : "";
  $("#modal-panel").innerHTML = `
    <button class="modal-close" data-mact="close">×</button>
    <div class="modal-grid">
      <div class="modal-art">${img}</div>
      <div class="modal-info">
        <h3>${esc(r.name)}</h3>
        <p class="dim">${esc(r.set_name)} · #${esc(r.number) || "—"}${r.variance ? " · " + esc(r.variance) : ""}</p>
        <div class="m-cols">
          <div class="m-left">
            <div class="price-row">
              <span class="price-big">$${(+r.price).toFixed(2)}</span>
              ${(r.qty || 1) > 1 ? `<span class="qty-chip">×${r.qty}</span>` : ""}
              <span class="badge ${CHANNEL_CLASS[r.channel] || ""}">${esc(r.channel)}</span>
            </div>
            <div class="m-line dim">net $${Math.round(r.net_unit || 0)} · ${Math.round((r.net_pct || 0) * 100)}% back</div>
            <div class="m-row m-extra">
              <label class="filter-label">Condition
                <select id="m-cond">${Object.keys(COND_FACTORS).map((c) => `<option value="${c}" ${(r.condition || "NM") === c ? "selected" : ""}>${c}</option>`).join("")}</select>
              </label>
            </div>
            ${psa}
            <div class="m-line">🏪 Shop: trade <b>$${Math.round(r.shop_trade || 0)}</b> / cash $${Math.round(r.shop_cash || 0)}</div>
            <div id="m-trend"></div>
          </div>
          <div class="m-right">
            <button class="m-btn ${r.keep ? "on" : ""}" data-mact="keep">${r.keep ? "★ Keeper" : "☆ Keep"}</button>
            <button class="m-btn ${hasTag(r, "to-grade") ? "on" : ""}" data-mact="gradepile">◆ To grade</button>
            <button class="m-btn ${hasTag(r, "shop") ? "on" : ""}" data-mact="shop">🏪 Drop-off</button>
            <button class="m-btn ${notNM(r) ? "on" : ""}" data-mact="notnm">🔍 Not NM</button>
            <button class="m-btn ${offC(r) ? "on" : ""}" data-mact="oc">◎ Off-center</button>
            <button class="m-btn" data-mact="ebaycopy">📋 eBay listing</button>
            <button class="m-btn" data-mact="ebayopen">↗ eBay sell page</button>
          </div>
        </div>
        <div class="m-photos">
          <div class="filter-label">Photos for eBay</div>
          <div class="ps-wrap">${photoSlot(r, "front")}${photoSlot(r, "back")}</div>
        </div>
      </div>
    </div>`;
  const panel = $("#modal-panel");
  panel.onclick = async (ev) => {
    const act = ev.target.dataset && ev.target.dataset.mact;
    if (!act) return;
    ev.stopPropagation();
    if (act === "close") { closeCard(); return; }
    if (act === "keep") await save(r, { keep: !r.keep });
    else if (act === "oc") await toggleTag(r, "off-center");
    else if (act === "notnm") await toggleTag(r, "not-nm");
    else if (act === "gradepile") await toggleTag(r, "to-grade");
    else if (act === "shop") await toggleTag(r, "shop");
    else if (act === "ebaycopy") {
      try { await navigator.clipboard.writeText(ebayListingText(r)); ev.target.textContent = "📋 Copied ✓"; } catch (e) { alert(ebayListingText(r)); }
      return;
    } else if (act === "ebayopen") { window.open("https://www.ebay.com/sell/create", "_blank"); return; }
    else if (act === "delphoto") { await deletePhoto(r, ev.target.dataset.side); return; }
    renderSummary(); renderTabs(); render(); openCard(r);
  };
  panel.querySelectorAll("input[type=file]").forEach((inp) =>
    inp.addEventListener("change", () => { if (inp.files[0]) uploadPhoto(r, inp.dataset.side, inp.files[0]); }));
  const cs = $("#m-cond");
  cs.addEventListener("change", async () => {
    const cond = cs.value;
    const price = Math.round((r.market_price || 0) * (COND_FACTORS[cond] || 1) * 100) / 100;
    const tags = (r.tags || []).filter((x) => x !== "not-nm");
    await save(r, { condition: cond, price, tags });
    renderSummary(); renderTabs(); render(); openCard(r);
  });
  $("#card-modal").classList.remove("hidden");

  (async () => {
    const { data: { user } } = await sb.auth.getUser();
    if (user) {
      for (const side of r.photos || []) {
        const url = await signedPhoto(user.id, r.natural_key, side);
        const el = panel.querySelector(`img[data-photo="${side}"]`);
        if (url && el) el.src = url;
      }
    }
    const t = await trendHtml(r);
    const td = panel.querySelector("#m-trend");
    if (td && t) td.outerHTML = t;
  })();
}

// ── Import CSV ──────────────────────────────────────────────────────────────
async function importCsv(file) {
  const status = (m) => { $("#sell-meta").textContent = m; };
  try {
    status("Reading file…");
    const text = await file.text();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) { status("Sign in first."); return; }

    status("Loading existing tags…");
    const existing = {};
    for (let from = 0; from < 20000; from += 1000) {
      const { data, error } = await sb.from("cards")
        .select("natural_key,tags,condition,keep,photos")
        .order("id", { ascending: true }).range(from, from + 999);
      if (error) break;
      (data || []).forEach((r) => { existing[r.natural_key] = r; });
      if (!data || data.length < 1000) break;
    }

    const cards = await buildRows(text, existing, status);
    if (!cards.length) { status("No cards found — is this a Collectr export.csv?"); return; }
    cards.forEach((c) => {
      c.user_id = user.id;
      const prev = existing[c.natural_key];
      if (prev && prev.photos && prev.photos.length) c.photos = prev.photos;
    });

    // YGO card art via YGOPRODeck (53-card scale — quick).
    const ygo = cards.filter((c) => c.bucket === "ygo" && !c.image_url);
    if (ygo.length) {
      status(`Fetching ${ygo.length} Yu-Gi-Oh images…`);
      const q = [...ygo];
      const w = async () => {
        while (q.length) {
          const c = q.shift();
          try {
            const resp = await fetch("https://db.ygoprodeck.com/api/v7/cardinfo.php?name=" + encodeURIComponent(c.name));
            if (resp.ok) {
              const d = await resp.json();
              c.image_url = d?.data?.[0]?.card_images?.[0]?.image_url_small || null;
            }
          } catch (e) { /* leave null */ }
        }
      };
      await Promise.all([w(), w(), w()]);
    }

    status("Replacing your inventory…");
    const del = await sb.from("cards").delete().eq("user_id", user.id);
    if (del.error) { status("Import failed: " + del.error.message); return; }
    for (let i = 0; i < cards.length; i += 500) {
      status(`Uploading ${Math.min(i + 500, cards.length)}/${cards.length}…`);
      const ins = await sb.from("cards").insert(cards.slice(i, i + 500));
      if (ins.error) { status("Import failed at " + i + ": " + ins.error.message); return; }
    }
    status("Imported " + cards.length + " cards ✓");
    load();
  } catch (e) {
    status("Import failed: " + (e.message || e));
  }
}

// ── Wiring ──────────────────────────────────────────────────────────────────
$("#import-btn").addEventListener("click", () => $("#import-file").click());
$("#import-file").addEventListener("change", () => {
  const f = $("#import-file").files[0];
  if (f) importCsv(f);
  $("#import-file").value = "";
});
$("#lcs-btn").addEventListener("click", lcsCsv);
$("#prices-btn").addEventListener("click", updatePrices);
$("#tcgp-btn").addEventListener("click", tcgpExport);
$("#catalog-btn").addEventListener("click", () => $("#catalog-file").click());
$("#catalog-file").addEventListener("change", () => {
  const fs = [...$("#catalog-file").files];
  if (fs.length) catalogUpload(fs);
  $("#catalog-file").value = "";
});
$("#delete-btn").addEventListener("click", deleteInventory);
$("#signin-btn").addEventListener("click", signIn);
$("#signup-btn").addEventListener("click", signUp);
$("#auth-pass").addEventListener("keydown", (e) => { if (e.key === "Enter") signIn(); });
$("#signout-btn").addEventListener("click", () => sb.auth.signOut());
$("#modal-backdrop").addEventListener("click", closeCard);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeCard(); });
$("#view-grid").addEventListener("click", () => { viewMode = "grid"; localStorage.setItem("sellViewMode", "grid"); $("#view-grid").classList.add("active"); $("#view-list").classList.remove("active"); render(); });
$("#view-list").addEventListener("click", () => { viewMode = "list"; localStorage.setItem("sellViewMode", "list"); $("#view-list").classList.add("active"); $("#view-grid").classList.remove("active"); render(); });
[["#f-channel", "channel"], ["#f-band", "band"]].forEach(([sel, key]) => {
  $(sel).addEventListener("change", (e) => { filters[key] = e.target.value; render(); });
});
document.querySelectorAll("#sell-filters .chip").forEach((btn) => {
  btn.addEventListener("click", () => {
    const f = btn.dataset.filter, v = btn.dataset.value;
    filters[f] = filters[f] === v ? "" : v;
    btn.classList.toggle("active", filters[f] === v);
    render();
  });
});
$("#sell-sort").addEventListener("change", (e) => { sortKey = e.target.value; render(); });
$("#sell-tag-filter").addEventListener("input", (e) => { filters.tag = e.target.value.trim(); render(); });
$("#sell-search").addEventListener("input", (e) => { filters.search = e.target.value.trim(); render(); });
$("#view-grid").classList.toggle("active", viewMode === "grid");
$("#view-list").classList.toggle("active", viewMode === "list");

boot();
