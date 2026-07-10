/* Sell Cockpit (cloud) — Supabase-backed viewer/tagger. Data syncs up from the
   local tool (`sell.py push`); tags/conditions edited here flow back on `pull`. */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildRows } from "./engine.js";

const SUPABASE_URL = "https://xmcohwtftpmnanootpia.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhtY29od3RmdHBtbmFub290cGlhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM2ODU5NTcsImV4cCI6MjA5OTI2MTk1N30.YVOa8JBdaJH9aXXsyUjOhdwKiohj4SZ6rVia36KfP0k";
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
const TABS = [["pkmn", "Pkmn Raw"], ["mtg", "MTG Raw"], ["ygo", "YGO Raw"],
              ["graded", "Graded"], ["sealed", "Sealed"]];

let rows = [];
let tab = localStorage.getItem("sellTab") || "pkmn";
const filters = { channel: "", band: "", notnm: "", grade: "", oc: "", shop: "", keepers: "", tag: "", search: "" };
let sortKey = "value";
let viewMode = localStorage.getItem("sellViewMode") || "grid";

const money = (n) => "$" + Math.round(n).toLocaleString();
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const notNM = (r) => (r.tags || []).includes("not-nm");
const offC = (r) => (r.tags || []).includes("off-center");

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
    const { data, error } = await sb.from("cards").select("*")
      .order("price", { ascending: false }).range(from, from + 999);
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

// ── Render ──────────────────────────────────────────────────────────────────
function summaryOf() {
  const sellable = rows.filter((r) => ["pkmn", "mtg", "ygo"].includes(r.bucket) && !r.keep);
  const mkt = sellable.reduce((a, r) => a + r.price * (r.qty || 1), 0);
  const net = sellable.reduce((a, r) => a + (r.net_unit || 0) * (r.qty || 1), 0);
  const buckets = {};
  for (const [k] of TABS) {
    const rs = rows.filter((r) => r.bucket === k && !(["pkmn", "mtg", "ygo"].includes(k) && r.keep));
    buckets[k] = { market: rs.reduce((a, r) => a + r.price * (k === "graded" || k === "sealed" ? 1 : r.qty || 1), 0), count: rs.length };
  }
  const keepers = rows.filter((r) => r.keep);
  return { mkt, net, pct: mkt ? net / mkt : 0, buckets,
           grade: rows.filter((r) => r.grade_flag && !offC(r)).length,
           notnm: rows.filter(notNM).length,
           keepers: keepers.length, keepersVal: keepers.reduce((a, r) => a + r.price * (r.qty || 1), 0) };
}

function renderSummary() {
  const s = summaryOf();
  $("#sell-summary").innerHTML = `
    <div class="sum-head"><div><span class="sum-pct">${Math.round(s.pct * 100)}%</span> recovered
      <span class="dim">· net ${money(s.net)} of ${money(s.mkt)} raw market</span></div></div>
    <div class="sum-notes">
      <span class="sum-note grade">◆ ${s.grade} grade-first</span>
      <span class="sum-note">🔍 ${s.notnm} awaiting condition check</span>
      <span class="sum-note">★ ${s.keepers} keepers (${money(s.keepersVal)})</span>
    </div>`;
  $("#notnm-count").textContent = s.notnm ? `(${s.notnm})` : "";
}

function renderTabs() {
  const s = summaryOf();
  $("#sell-tabs").innerHTML = TABS.map(([key, label]) =>
    `<button class="tab ${tab === key ? "active" : ""}" data-tab="${key}">
       ${label} <span class="tab-val">${money(s.buckets[key].market)}</span></button>`).join("");
  document.querySelectorAll("#sell-tabs .tab").forEach((b) =>
    b.addEventListener("click", () => { tab = b.dataset.tab; localStorage.setItem("sellTab", tab); renderTabs(); render(); }));
}

function passes(r) {
  if (r.bucket !== tab) return false;
  if (filters.channel && r.channel !== filters.channel) return false;
  if (filters.band && r.band !== filters.band) return false;
  if (filters.notnm && !notNM(r)) return false;
  if (filters.grade && !r.grade_flag) return false;
  if (filters.oc && !offC(r)) return false;
  if (filters.shop && !(r.tags || []).includes("shop")) return false;
  if (filters.keepers && !r.keep) return false;
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

function tile(r, holdsTab) {
  const el = document.createElement("div");
  el.className = "sell-tile" + (r.keep ? " is-keep" : "");
  const img = r.image_url ? `<img loading="lazy" src="${r.image_url}" onerror="this.classList.add('broken')">`
                          : `<div class="noimg">no image</div>`;
  if (holdsTab) {
    el.innerHTML = `
      <div class="tile-img">${img}<div class="tile-badges"><span class="tb">${r.bucket === "graded" ? "🏆" : "📦"}</span></div></div>
      <div class="tile-body">
        <div class="tile-name">${esc(r.name)}</div>
        <div class="tile-sub">${esc(r.set_name)}${r.grade && r.grade !== "Ungraded" ? " · " + esc(r.grade) : ""}</div>
        <div class="tile-row"><span class="price">$${(+r.price).toFixed(2)}</span><span class="badge ch-bulk">HOLD</span></div>
      </div>`;
    return el;
  }
  const badges =
    (notNM(r) ? '<span class="tb notnm">🔍</span>' : "") +
    (offC(r) ? '<span class="tb oc">◎</span>' : "") +
    ((r.tags || []).includes("shop") ? '<span class="tb shop">🏪</span>' : "");
  const condChip = r.condition && r.condition !== "NM" ? ` <span class="cond-chip">${r.condition}</span>` : "";
  el.innerHTML = `
    <div class="tile-img">${img}<div class="tile-badges">${badges}</div></div>
    <div class="tile-body">
      <div class="tile-name">${r.keep ? "★ " : ""}${esc(r.name)}</div>
      <div class="tile-sub">${esc(r.set_name)} · #${esc(r.number) || "—"}</div>
      <div class="tile-row">
        <span class="price">$${(+r.price).toFixed(2)}${(r.qty || 1) > 1 ? ` ×${r.qty}` : ""}${condChip}</span>
        <span class="badge ${CHANNEL_CLASS[r.channel] || ""}" title="${esc(r.channel_reason)}">${esc(r.channel)}</span>
      </div>
      ${psaLine(r)}
      <div class="tile-flags">${r.grade_flag && !offC(r) ? `<span class="flag grade">◆ grade +${money(r.grade_gap || 0)}</span>` : ""}${(r.flags || []).map(flagChip).join("")}</div>
      <div class="quickbar">
        <button class="qb ${r.keep ? "on" : ""}" data-act="keep" title="Keep">★</button>
        <button class="qb ${notNM(r) ? "on" : ""}" data-act="notnm" title="Not NM → conditioning queue">!NM</button>
        <button class="qb ${offC(r) ? "on" : ""}" data-act="oc" title="Off-center">◎</button>
        <button class="qb ${(r.tags || []).includes("to-grade") ? "on" : ""}" data-act="gradepile" title="Add to grading pile">◆</button>
        <button class="qb ${(r.tags || []).includes("shop") ? "on" : ""}" data-act="shop" title="Shop drop-off pile">🏪</button>
      </div>
    </div>`;
  el.addEventListener("click", (ev) => onClick(ev, r));
  return el;
}

async function toggleTag(r, t) {
  const has = (r.tags || []).includes(t);
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

// ── LCS drop-off price sheet (browser CSV download of 🏪-tagged cards) ──────
function lcsCsv() {
  const picks = rows.filter((r) => (r.tags || []).includes("shop") && !r.keep)
    .sort((a, b) => b.price - a.price);
  if (!picks.length) { alert("No cards tagged 🏪 yet — use the quick-tag on the cards you're bringing in."); return; }
  const q = (s) => '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"';
  let tv = 0, tt = 0, tc = 0;
  const lines = ["Card,Set,Number,Condition,Your Value,Trade (store credit),Cash"];
  for (const r of picks) {
    const v = +r.price || 0, t = +r.shop_trade || 0, c = +r.shop_cash || 0;
    tv += v; tt += t; tc += c;
    lines.push([q(r.name), q(r.set_name), q(r.number), q(r.condition || "NM"),
                v.toFixed(2), t.toFixed(2), c.toFixed(2)].join(","));
  }
  lines.push(["TOTAL", "", "", "", tv.toFixed(2), tt.toFixed(2), tc.toFixed(2)].join(","));
  const blob = new Blob([lines.join("\r\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "lcs_dropoff_" + new Date().toISOString().slice(0, 10) + ".csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── Modal ───────────────────────────────────────────────────────────────────
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
        <div class="m-stats">
          <span class="price">$${(+r.price).toFixed(2)}</span>
          <span class="badge ${CHANNEL_CLASS[r.channel] || ""}">${esc(r.channel)}</span>
          <span class="m-net">net $${Math.round(r.net_unit || 0)} · <b>${Math.round((r.net_pct || 0) * 100)}%</b></span>
        </div>
        <div class="m-row m-extra">
          <label class="filter-label">Condition
            <select id="m-cond">${Object.keys(COND_FACTORS).map((c) => `<option value="${c}" ${(r.condition || "NM") === c ? "selected" : ""}>${c}</option>`).join("")}</select>
          </label>
        </div>
        <div class="m-extra-lines">
          ${psa}
          <div class="m-line">🏪 Shop: trade <b>$${Math.round(r.shop_trade || 0)}</b> / cash $${Math.round(r.shop_cash || 0)}</div>
        </div>
        <div class="m-row">
          <button class="m-btn ${r.keep ? "on" : ""}" data-mact="keep">${r.keep ? "★ Keeper" : "☆ Keep"}</button>
          <button class="m-btn ${offC(r) ? "on" : ""}" data-mact="oc">◎ Off-center</button>
          <button class="m-btn ${notNM(r) ? "on" : ""}" data-mact="notnm">🔍 Not NM</button>
          <button class="m-btn ${(r.tags || []).includes("to-grade") ? "on" : ""}" data-mact="gradepile">◆ To grade</button>
          <button class="m-btn ${(r.tags || []).includes("shop") ? "on" : ""}" data-mact="shop">🏪 Drop-off</button>
        </div>
        <p class="dim" style="font-size:12px">Photos + shop manifest live in the local tool · edits here sync back on <code>sell.py pull</code>.</p>
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
    renderSummary(); renderTabs(); render(); openCard(r);
  };
  const cs = $("#m-cond");
  cs.addEventListener("change", async () => {
    const cond = cs.value;
    const price = Math.round((r.market_price || 0) * (COND_FACTORS[cond] || 1) * 100) / 100;
    const tags = (r.tags || []).filter((x) => x !== "not-nm");   // condition set → resolved
    await save(r, { condition: cond, price, tags });
    renderSummary(); renderTabs(); render(); openCard(r);
  });
  $("#card-modal").classList.remove("hidden");
}

// ── Import CSV (fully in-browser: parse → route → store) ───────────────────
async function importCsv(file) {
  const status = (m) => { $("#sell-meta").textContent = m; };
  try {
    status("Reading file…");
    const text = await file.text();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) { status("Sign in first."); return; }

    // Carry tags/condition/keep forward from existing rows (sync semantics:
    // the upload replaces the list; your custom fields persist by card).
    status("Loading existing tags…");
    const existing = {};
    for (let from = 0; from < 20000; from += 1000) {
      const { data, error } = await sb.from("cards")
        .select("natural_key,tags,condition,keep").range(from, from + 999);
      if (error) break;
      (data || []).forEach((r) => { existing[r.natural_key] = r; });
      if (!data || data.length < 1000) break;
    }

    const cards = await buildRows(text, existing, status);
    if (!cards.length) { status("No cards found — is this a Collectr export.csv?"); return; }
    cards.forEach((c) => { c.user_id = user.id; });

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
$("#lcs-btn").addEventListener("click", lcsCsv);
$("#import-file").addEventListener("change", () => {
  const f = $("#import-file").files[0];
  if (f) importCsv(f);
  $("#import-file").value = "";
});
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
