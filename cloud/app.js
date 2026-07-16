/* SELL COCKPIT — "THE LINE": Decide → Prep → Cash Out (+ Browse).
   The structure answers "what do I do next": a computed Next-Up CTA, filing
   quick-actions on every card, exports living inside their Cash Out lanes.
   Vanilla JS + Supabase. ?demo=1 loads a sample collection with no writes. */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildRows, parseCSV, normSetTCGP, normNumTCGP, TCGP_SET_ALIASES, tcgpCondition, mtgFuzzyImageUrl, jpFallbackUrl, sealedImageUrl, routeRow, gradingBreakdown } from "./engine.js";

const SUPABASE_URL = "https://xmcohwtftpmnanootpia.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhtY29od3RmdHBtbmFub290cGlhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM2ODU5NTcsImV4cCI6MjA5OTI2MTk1N30.YVOa8JBdaJH9aXXsyUjOhdwKiohj4SZ6rVia36KfP0k";
const FN_PRICES = SUPABASE_URL + "/functions/v1/prices";
const sb = createClient(SUPABASE_URL, SUPABASE_ANON);
const DEMO = new URLSearchParams(location.search).has("demo");

const $ = (s) => document.querySelector(s);
const CAP = 300;
const COND_FACTORS = { NM: 1.0, LP: 0.9, MP: 0.75, HP: 0.6, DMG: 0.5 };
const CONDS = ["NM", "LP", "MP", "HP", "DMG"];
const catOf = (b) => ({ pkmn: "Pokemon", mtg: "Magic: The Gathering", ygo: "YuGiOh", op: "One Piece" }[b] || "Pokemon");
// Recompute price and every price-derived field (net, shop offers, band,
// channel, grading EV) whenever the market price or condition changes — the
// net figure must always track the price it's shown next to. Preserves real
// PSA-10 data and the language/art flags routeRow doesn't know about.
function derivePricePatch(r, { market = r.market_price, condition = r.condition, realPsa10 } = {}) {
  const mkt = +market || 0;
  const price = Math.round(mkt * (COND_FACTORS[condition] || 1) * 100) / 100;
  // Feed the real PSA-10 comp into routing so grade candidacy uses it, not a prior.
  const rp = realPsa10 != null ? (+realPsa10 || 0) : (r.psa10_real ? (+r.psa10 || 0) : 0);
  const route = routeRow(catOf(r.bucket), r.set_name, r.rarity || "", r.name, r.variance, r.number, price, rp);
  const keepFlags = (r.flags || []).filter((f) => f === "japanese" || f === "art-card");
  return { condition, market_price: mkt, price, ...route, flags: [...route.flags, ...keepFlags] };
}
const GAMES = [["pkmn", "Pokemon"], ["mtg", "MTG"], ["ygo", "Yu-Gi-Oh"], ["op", "One Piece"]];
// The primary decision is exclusive: Sell or Keep (or undecided). The channel
// (eBay / TCGplayer / shop) is chosen later in Prep, not at sort time.
const DECISIONS = [
  { key: "sell", icon: "i-sell", label: "Sell", aria: "Sell" },
  { key: "keep", icon: "i-keep", label: "Keep", aria: "Keep — personal collection" },
];
// Prep flags are NON-exclusive: a card can be Sell (or Keep, or undecided) AND
// still be flagged for a condition check or grading — these are prep steps.
const FLAGS = [
  { key: "check", icon: "i-check", label: "Check", aria: "Flag: check condition", tag: "not-nm" },
  { key: "grade", icon: "i-grade", label: "Grade", aria: "Flag: grade first", tag: "to-grade" },
];
const FLAG_TAG = { check: "not-nm", grade: "to-grade" };
const PRIMARY_TAGS = ["sell"];   // 'keep' lives on the keep boolean; 'sell' is a tag
const PILES = [
  ["all", "All"], ["undecided", "Undecided"], ["sell", "Sell"], ["keep", "Keep"],
  ["grade", "Grade"], ["check", "Check"], ["graded", "Graded"], ["sealed", "Sealed"], ["under1", "<$1"],
];

let rows = [];
let station = "decide";
let pileKey = "undecided";
let gameChip = localStorage.getItem("gameChip") || "";
let viewMode = localStorage.getItem("viewMode") || "grid";
let sortKey = "value";
let rarOpen = localStorage.getItem("rarOpen") === "1";   // rarity filter row expanded?
// Multi-select facets: within a facet any selected value passes (OR); facets
// combine with AND — "illustration rares under $1" = rarity ∪ price band.
const filters = { search: "", price: new Set(), route: new Set(), rarity: new Set(), grade: false, oc: false, photo: false };
let kfocus = -1;
let undoState = null;
let toastTimer = null;
let selected = new Set();   // row ids checked for batch filing (list/table views)
let pricing = null;         // {done,total} while a live price refresh is running

const money = (n) => "$" + Math.round(n).toLocaleString();
const plural = (n, s) => n + " " + s + (n === 1 ? "" : "s");
const money2 = (n) => "$" + (+n).toFixed(2);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ico = (name, size = "") => `<svg class="ic ${size}" aria-hidden="true"><use href="#${name}"/></svg>`;
const hasTag = (r, t) => (r.tags || []).includes(t);
const offC = (r) => hasTag(r, "off-center");
// A damaged or off-center card is not gem-mint material — showing a PSA-10
// payday on it is a lie the user asked us to stop telling.
const psaEligible = (r) => (r.condition || "NM") === "NM" && !offC(r);
const gradeClassLabel = (c) => ({ vintage: "vintage holos", modern_textured: "textured / alt-art holos", modern_smooth: "modern holos" }[c] || "this type");
// "PSA 10.0 GEM - MT" → "PSA 10"; "" if ungraded.
function gradeNum(r) {
  if (!r.grade || r.grade === "Ungraded") return "";
  const co = (r.grade.match(/\b(PSA|BGS|CGC|SGC)\b/i) || ["PSA"])[0].toUpperCase();
  const n = (r.grade.match(/(\d+(?:\.\d)?)/) || [])[1];
  return n ? `${co} ${parseFloat(n)}` : co;
}
const isRaw = (b) => ["pkmn", "mtg", "ygo", "op"].includes(b);
// Primary decision only (exclusive). Check/grade are separate flags via hasTag.
const decisionOf = (r) => r.keep ? "keep" : hasTag(r, "sell") ? "sell" : null;
const decided = (r) => decisionOf(r) !== null;
const flaggedCheck = (r) => hasTag(r, "not-nm");
const flaggedGrade = (r) => hasTag(r, "to-grade");
const SORTS = {
  value: (a, b) => b.price - a.price,
  valueasc: (a, b) => a.price - b.price,
  market: (a, b) => b.market_price - a.market_price,
  psa10x: (a, b) => (b.psa10_x || 0) - (a.psa10_x || 0),
  netpct: (a, b) => (b.net_pct || 0) - (a.net_pct || 0),
};

// Rows visible in a pile (before game chip / facet filters).
// Sub-$1 raw cards are bulk you don't want to hand-decide, so they live in the
// "<$1" pile and are kept OUT of Undecided (they don't inflate the queue).
const isBulk = (r) => isRaw(r.bucket) && (r.price || 0) < 1;
function pileRows(key) {
  if (key === "all") return rows;
  if (key === "graded" || key === "sealed") return rows.filter((r) => r.bucket === key);
  const raw = rows.filter((r) => isRaw(r.bucket));
  if (key === "under1") return raw.filter((r) => (r.price || 0) < 1);
  if (key === "undecided") return raw.filter((r) => !decided(r) && (r.price || 0) >= 1);
  if (key === "keep") return raw.filter((r) => r.keep);
  const map = { sell: "sell", grade: "to-grade", check: "not-nm" };   // grade/check are flags
  return raw.filter((r) => hasTag(r, map[key]));
}

// ── Session tally ────────────────────────────────────────────────────────────
const tallyKey = () => "decided-" + new Date().toISOString().slice(0, 10);
const tally = () => parseInt(localStorage.getItem(tallyKey()) || "0");
const bumpTally = (d) => localStorage.setItem(tallyKey(), Math.max(0, tally() + d));

// ── Data ─────────────────────────────────────────────────────────────────────
// Concurrent loads (boot + onAuthStateChange both firing) used to interleave
// their pushes into the shared rows array, showing every card twice. Each load
// now builds privately and only the newest one may publish.
let loadSeq = 0;
async function load() {
  const seq = ++loadSeq;
  if (DEMO) {
    const { DEMO_ROWS } = await import("./demo.js");
    if (seq !== loadSeq) return;
    rows = DEMO_ROWS;
    renderAll();
    return;
  }
  const acc = [];
  for (let from = 0; from < 20000; from += 1000) {
    const { data, error } = await sb.from("cards").select("*")
      .order("price", { ascending: false }).order("id", { ascending: true })
      .range(from, from + 999);
    if (seq !== loadSeq) return;
    if (error) { setStatus(error.message); return; }
    acc.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  rows = acc;
  renderAll();
}

async function save(row, patch) {
  Object.assign(row, patch);
  if (!DEMO) await sb.from("cards").update(patch).eq("id", row.id);
}

// ── Toast ────────────────────────────────────────────────────────────────────
function toast(msg, undoFn = null, ms = undoFn ? 5000 : 3000) {
  document.getElementById("toast")?.remove();
  clearTimeout(toastTimer);
  const t = document.createElement("div");
  t.id = "toast";
  t.innerHTML = `<span>${esc(msg)}</span>${undoFn ? `<button id="toast-undo">Undo</button>` : ""}`;
  document.body.appendChild(t);
  if (undoFn) $("#toast-undo").addEventListener("click", () => { t.remove(); undoFn(); });
  toastTimer = setTimeout(() => t.remove(), ms);
}

// Transient operation status (import/refresh) shown in the otherwise-empty
// #next-up slot; renderStrip clears it when the operation finishes.
function setStatus(msg) {
  const nu = $("#next-up");
  if (nu) nu.innerHTML = msg ? `<div class="op-status num">${esc(msg)}</div>` : "";
}

// ── Filing ───────────────────────────────────────────────────────────────────
const DLABEL = { sell: "Sell", keep: "Keep", grade: "Grade first", check: "Condition check" };
const isFlagKey = (k) => k === "check" || k === "grade";
// Toggle a card's state for `key`. Primary (sell/keep) is exclusive and toggles
// off to undecided; check/grade are independent flags that don't touch primary.
function toggledPatch(r, key) {
  if (isFlagKey(key)) {
    const tag = FLAG_TAG[key], has = hasTag(r, tag);
    return { tags: has ? (r.tags || []).filter((t) => t !== tag) : [...(r.tags || []), tag] };
  }
  const noPrimary = (r.tags || []).filter((t) => t !== "sell");   // preserve flags + off-center
  if (decisionOf(r) === key) return { keep: false, tags: noPrimary };            // toggle off
  if (key === "keep") return { keep: true, tags: noPrimary };
  return { keep: false, tags: [...noPrimary, "sell"] };                          // sell
}
async function fileCard(r, key, el = null) {
  const prev = { keep: r.keep, tags: [...(r.tags || [])] };
  const was = decided(r);
  const patch = toggledPatch(r, key);
  // Only the primary decision removes a card from the Undecided queue, so only
  // animate it leaving on a primary file.
  if (el && !isFlagKey(key)) { el.classList.add("filing"); await new Promise((res) => setTimeout(res, 150)); }
  await save(r, patch);
  const now = decided(r);
  if (!was && now) bumpTally(1);
  if (was && !now) bumpTally(-1);
  renderAll();
  const on = isFlagKey(key) ? hasTag(r, FLAG_TAG[key]) : decisionOf(r) === key;
  const msg = isFlagKey(key) ? `${on ? "Flagged" : "Cleared"}: ${DLABEL[key]}` : (on ? `Filed to ${DLABEL[key]}` : "Back to undecided");
  toast(msg, async () => { await save(r, prev); if (!was && now) bumpTally(-1); else if (was && !now) bumpTally(1); renderAll(); });
}

// ── Batch filing ─────────────────────────────────────────────────────────────
// Check rows in list/table view, then file them all at once. Unlike fileCard
// this SETS the state (no toggle) so re-applying is a no-op; whole batch = one undo.
function decisionPatch(r, key) {
  if (isFlagKey(key)) {   // add the flag (don't remove)
    const tag = FLAG_TAG[key];
    return { tags: hasTag(r, tag) ? (r.tags || []) : [...(r.tags || []), tag] };
  }
  const noPrimary = (r.tags || []).filter((t) => t !== "sell");
  return key === "keep" ? { keep: true, tags: noPrimary } : { keep: false, tags: [...noPrimary, "sell"] };
}
async function fileBatch(dkey) {
  const targets = currentPool().filter((r) => selected.has(r.id) && isRaw(r.bucket));
  if (!targets.length) return;
  const snaps = targets.map((r) => [r, { keep: r.keep, tags: [...(r.tags || [])] }]);
  let newly = 0;
  for (let i = 0; i < targets.length; i += 10) {
    await Promise.all(targets.slice(i, i + 10).map(async (r) => {
      const was = decided(r);
      await save(r, decisionPatch(r, dkey));
      if (!was) newly++;
    }));
    if (targets.length > 30) setStatus(`Filing ${Math.min(i + 10, targets.length)}/${targets.length}…`);
  }
  bumpTally(newly);
  selected.clear();
  renderAll();
  toast(`Filed ${plural(targets.length, "card")} to ${DLABEL[dkey]}`, async () => {
    for (let i = 0; i < snaps.length; i += 10)
      await Promise.all(snaps.slice(i, i + 10).map(([r, prev]) => save(r, prev)));
    bumpTally(-newly);
    renderAll();
  });
}
function updateBatchBar() {
  document.getElementById("batch-bar")?.remove();
  const n = [...selected].length;
  if (!n || station !== "decide") return;
  const bar = document.createElement("div");
  bar.id = "batch-bar";
  bar.innerHTML = `<span class="num"><b>${n}</b> selected</span>
    ${[...DECISIONS, ...FLAGS].map((d) => `<button class="d-${d.key}" data-batch="${d.key}" title="${isFlagKey(d.key) ? "Flag all" : "File all"} — ${d.label}">${ico(d.icon, "s")}<span>${d.label}</span></button>`).join("")}
    <button class="ghost" id="batch-clear" aria-label="Clear selection">${ico("i-x", "s")}</button>`;
  document.body.appendChild(bar);
  bar.querySelectorAll("[data-batch]").forEach((b) => b.addEventListener("click", () => fileBatch(b.dataset.batch)));
  bar.querySelector("#batch-clear").addEventListener("click", () => {
    selected.clear();
    document.querySelectorAll(".selbox, #sel-all-t").forEach((cb) => { cb.checked = false; });
    updateBatchBar();
  });
}

// ── Next-Up ladder ───────────────────────────────────────────────────────────
// Sell channel: a manual override (set in Prep) wins, else the routed channel.
function channelOf(r) {
  if (hasTag(r, "ch-shop")) return "shop";
  if (hasTag(r, "ch-tcg")) return "tcg";
  if (hasTag(r, "ch-ebay")) return "ebay";
  const c = r.channel || "";
  return c === "TCGplayer" ? "tcg" : c === "LCS" ? "shop" : "ebay";
}
const CHANNELS = [["ebay", "eBay"], ["tcg", "TCGplayer"], ["shop", "Local shop"]];

function stats() {
  const raw = rows.filter((r) => isRaw(r.bucket));
  const undecided = raw.filter((r) => !decided(r) && (r.price || 0) >= 1);   // bulk lives in the <$1 pile
  const sellRows = raw.filter((r) => hasTag(r, "sell"));
  const checkRows = raw.filter((r) => flaggedCheck(r));
  const gradePile = raw.filter((r) => flaggedGrade(r));
  const photosNeeded = sellRows.filter((r) => channelOf(r) === "ebay" && (r.photos || []).length < 1);
  const sellable = raw.filter((r) => !r.keep);
  const mkt = sellable.reduce((a, r) => a + r.price * (r.qty || 1), 0);
  const net = sellable.reduce((a, r) => a + (r.net_unit || 0) * (r.qty || 1), 0);
  const keepers = raw.filter((r) => r.keep);
  return { raw, undecided, sellRows, checkRows, gradePile, photosNeeded, mkt, net,
           keepers, keepersVal: keepers.reduce((a, r) => a + r.price * (r.qty || 1), 0) };
}

// Header projected-net only; the Next-Up strip is gone (refresh lives in the
// Data menu, the undecided count lives on the pile selector).
function renderStrip() {
  const s = stats();
  $("#hd-stat").innerHTML = rows.length ? `<div class="lbl">projected net</div><div class="val num">${money(s.net)}</div>` : "";
  const nu = $("#next-up"); if (nu) nu.innerHTML = "";
}

// ── Stations nav + router ────────────────────────────────────────────────────
function nav(st, pk = null) {
  location.hash = st === "decide" && pk ? `#/decide/${pk}` : `#/${st}`;
}
function applyHash() {
  const h = location.hash.replace(/^#\//, "");
  const [st, sub] = h.split("/");
  if (st === "browse") {   // legacy route from v5 bookmarks
    station = "decide";
    pileKey = ["graded", "sealed"].includes(sub) ? sub : "all";
  } else {
    station = ["decide", "prep", "cashout"].includes(st) ? st : "decide";
    if (station === "decide") pileKey = PILES.some(([k]) => k === sub) ? sub : "undecided";
  }
  localStorage.setItem("lastRoute", location.hash);
  renderAll();
}

function renderStations() {
  const s = stats();
  const prepCount = s.sellRows.length + s.checkRows.length + s.gradePile.length;
  const defs = [
    ["decide", "Cards", "i-grid", `${s.undecided.length}`],
    ["prep", "Prep", "i-camera", `${prepCount}`],
    ["cashout", "Trade", "i-refresh", ""],
  ];
  $("#stations").innerHTML = defs.map(([key, label, icon, pill, isMoney]) =>
    `<button class="${key === station ? "active" : ""}" data-st="${key}">
      ${ico(icon)}<span>${label}</span>${pill ? `<span class="st-pill num ${isMoney ? "money" : ""}">${pill}</span>` : ""}
    </button>`).join("");
  document.querySelectorAll("#stations button").forEach((b) =>
    b.addEventListener("click", () => nav(b.dataset.st)));
}

function renderAll() {
  renderStrip();
  renderStations();
  ["decide", "prep", "cashout", "browse"].forEach((k) =>
    $(`#view-${k}`)?.classList.toggle("hidden", k !== station));
  if (station === "decide") renderDecide();
  else if (station === "prep") renderPrep();
  else if (station === "cashout") renderTrade();
  if (station !== "decide") updateBatchBar();   // removes the bar off-station
}

// ── Shared card pieces ───────────────────────────────────────────────────────
// Variance is part of the identity line: a Foil and a Normal of the same card
// are different rows, and hiding the variance made them read as duplicates.
function subLine(r) {
  return `${esc(r.set_name)}${r.number ? " · #" + esc(r.number) : ""}${r.variance && r.variance !== "Normal" ? " · " + esc(r.variance) : ""}`;
}
function metaLine(r) {
  if (!isRaw(r.bucket)) {
    const label = r.grade && r.grade !== "Ungraded" ? r.grade : r.bucket === "sealed" ? "Sealed — hold" : "Hold";
    return `<div class="t-meta">${esc(label)}</div>`;
  }
  // PSA only when it's a real comp; otherwise just the net.
  if (r.bucket === "pkmn" && psaEligible(r) && r.psa10_real && (r.psa10_x || 0) >= 4) {
    const hot = r.psa10_x >= 8;
    return `<div class="t-meta ${hot ? "hot" : ""} num">PSA 10 ${money(r.psa10)} · ${r.psa10_x}×${hot ? " — don't sell raw" : ""}</div>`;
  }
  return `<div class="t-meta num">nets <span class="net">${money(r.net_unit || 0)}</span></div>`;
}
const fileActive = (r, key) => isFlagKey(key) ? hasTag(r, FLAG_TAG[key]) : decisionOf(r) === key;
// Primary (sell/keep) then a thin divider, then the flag toggles (check/grade).
function decideRow(r, compact = false) {
  const btn = (d) => `<button data-file="${d.key}" class="d-${d.key} ${fileActive(r, d.key) ? "on" : ""}" title="${d.aria}" aria-label="${d.aria}">${ico(d.icon, compact ? "s" : "")}</button>`;
  return `<div class="decide-row" role="group" aria-label="File this card">`
    + DECISIONS.map(btn).join("") + `<span class="dr-sep"></span>` + FLAGS.map(btn).join("") + `</div>`;
}
function imgTag(r, cls = "") {
  if (!r.image_url) return `<div class="noimg">${r.bucket === "sealed" ? ico("i-box", "l") : ico("i-grid")}</div>`;
  const fb = r.bucket === "mtg" ? mtgFuzzyImageUrl(r.name)
    : (r.flags || []).includes("japanese") ? jpFallbackUrl(r.set_name, r.number) : null;
  const fbAttr = fb && fb !== r.image_url ? ` data-fb="${esc(fb)}"` : "";
  return `<img ${cls ? `class="${cls}"` : ""} loading="lazy" src="${r.image_url}"${fbAttr} onerror="if(this.dataset.fb){this.src=this.dataset.fb;delete this.dataset.fb}else{this.classList.add('broken')}" alt="">`;
}
function badges(r) {
  const b = [];
  if (hasTag(r, "not-nm")) b.push(`<span class="tb warn" title="Awaiting condition check">${ico("i-check", "s")}</span>`);
  if (offC(r)) b.push(`<span class="tb" title="Off-center">${ico("i-offcenter", "s")}</span>`);
  if ((r.photos || []).length) b.push(`<span class="tb" title="Has photos">${ico("i-camera", "s")}</span>`);
  return b.join("");
}
function wireFileButtons(el, r) {
  el.querySelectorAll("[data-file]").forEach((b) =>
    b.addEventListener("click", (ev) => { ev.stopPropagation(); fileCard(r, b.dataset.file, el.closest(".tile")); }));
}

function tile(r, showPile = false, ctx = null) {
  const el = document.createElement("div");
  el.className = "tile";
  const cond = r.condition && r.condition !== "NM" ? `<span class="cond">${r.condition}</span>` : "";
  // Grade / $250-auth signals live in the card panel now, not the list; JP stays
  // because it's a quick language cue you can't get from the art.
  const fl = [];
  if ((r.flags || []).includes("japanese")) fl.push(`<span class="fl">JP</span>`);
  const pile = decisionOf(r);
  el.innerHTML = `
    <div class="tile-img">${imgTag(r)}<div class="tile-badges">${badges(r)}</div></div>
    <div class="tile-body">
      <div class="t-name">${esc(r.name)}</div>
      <div class="t-sub">${subLine(r)}</div>
      <div class="t-price"><span class="p num">${money2(r.price)}</span>${(r.qty || 1) > 1 ? `<span class="q num">×${r.qty}</span>` : ""}${cond}</div>
      ${metaLine(r)}
      ${fl.length || (showPile && pile) ? `<div class="t-flags">${showPile && pile ? `<span class="pile-chip">${DLABEL[pile]}</span>` : ""}${fl.slice(0, 2).join("")}</div>` : ""}
    </div>
    ${isRaw(r.bucket) ? decideRow(r) : ""}`;
  el.querySelector(".tile-body").addEventListener("click", () => openCard(r, ctx));
  el.querySelector(".tile-img").addEventListener("click", () => openCard(r, ctx));
  wireFileButtons(el, r);
  return el;
}

function listRow(r, ctx = null) {
  const el = document.createElement("div");
  el.className = "rowc";
  const raw = isRaw(r.bucket);
  const g = gradeNum(r);
  el.innerHTML = `
    ${raw ? `<input type="checkbox" class="selbox" data-id="${r.id}" ${selected.has(r.id) ? "checked" : ""} aria-label="Select ${esc(r.name)}">` : ""}
    ${imgTag(r)}
    <div class="r-main"><div class="r-name">${esc(r.name)}</div><div class="r-sub">${subLine(r)}</div></div>
    ${g ? `<span class="grade-pill num">${g}</span>` : ""}
    <div class="r-price num">${money2(r.price)}${(r.qty || 1) > 1 ? ` <span class="dim">×${r.qty}</span>` : ""}</div>
    ${raw ? decideRow(r, true) : ""}`;
  el.addEventListener("click", () => openCard(r, ctx));
  el.querySelector(".selbox")?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    ev.currentTarget.checked ? selected.add(r.id) : selected.delete(r.id);
    updateBatchBar();
  });
  wireFileButtons(el, r);
  return el;
}

// ── CARDS (Decide + piles) ───────────────────────────────────────────────────
function passes(r) {
  if (filters.price.size && !filters.price.has(r.band)) return false;
  if (filters.route.size && !filters.route.has(r.channel)) return false;
  if (filters.rarity.size && !filters.rarity.has(r.rarity || "")) return false;
  if (filters.grade && !r.grade_flag) return false;
  if (filters.oc && !offC(r)) return false;
  if (filters.photo && !((r.photos || []).length)) return false;
  if (filters.search) {
    const q = filters.search.toLowerCase();
    if (!((r.name || "") + " " + (r.set_name || "") + " " + (r.rarity || "")).toLowerCase().includes(q)) return false;
  }
  return true;
}

// The current visible pool: pile → game chip → facets → sort. Modal navigation
// walks this same list, so what you see is what "next card" means.
function currentPool() {
  const base = pileRows(pileKey);
  const pool = base.filter((r) => (!gameChip || r.bucket === gameChip) && passes(r));
  pool.sort(SORTS[sortKey] || SORTS.value);
  return pool;
}

const FACET_PRICE = [["o50", "$50+"], ["5_50", "$5–50"], ["1_5", "$1–5"], ["u1", "<$1"]];
const FACET_ROUTE = [["eBay (auction)", "eBay auction"], ["eBay (fixed)", "eBay fixed"], ["TCGplayer", "TCGplayer"], ["LCS", "Shop"]];

function renderDecide() {
  const v = $("#view-decide");
  const s = stats();
  if (!rows.length) { v.innerHTML = ""; v.appendChild(firstRun()); return; }

  const base = pileRows(pileKey);
  const pool = currentPool();
  const rawPile = !["graded", "sealed"].includes(pileKey);

  const pileHtml = PILES.map(([key, label]) => {
    const n = pileRows(key).length;
    return `<button class="pchip ${pileKey === key ? "active" : ""} ${n ? "" : "zero"}" data-pile="${key}">${label}<span class="c num">${n}</span></button>`;
  }).join("");

  const gameBase = (key) => base.filter((r) => r.bucket === key);
  const chips = !rawPile ? "" : GAMES.map(([key, label]) => {
    const g = gameBase(key);
    const val = g.reduce((a, r) => a + r.price * (r.qty || 1), 0);
    return `<button class="gchip ${gameChip === key ? "active" : ""}" data-chip="${key}">${label}
      <span class="v num">${money(val)}</span><span class="c num">${g.length}</span></button>`;
  }).join("");
  const allVal = base.reduce((a, r) => a + r.price * (isRaw(r.bucket) ? (r.qty || 1) : 1), 0);

  // Rarity facet is data-driven: every rarity actually present in this
  // pile+game, busiest first. Mirrors how the physical binder is organized.
  const gamePool = base.filter((r) => !gameChip || r.bucket === gameChip);
  const rarCounts = new Map();
  gamePool.forEach((r) => { const k = r.rarity || ""; if (k) rarCounts.set(k, (rarCounts.get(k) || 0) + 1); });
  const rarities = [...rarCounts.entries()].sort((a, b) => b[1] - a[1]);
  const rarityMissing = rawPile && !rarities.length && gamePool.length > 0;   // pre-rarity import
  [...filters.rarity].forEach((k) => { if (!rarCounts.has(k)) filters.rarity.delete(k); });

  const fchip = (facet, key, label, extra = "") =>
    `<button class="fchip ${filters[facet] instanceof Set ? (filters[facet].has(key) ? "active" : "") : (filters[facet] ? "active" : "")}"
      data-facet="${facet}" data-fkey="${esc(key)}">${label}${extra}</button>`;

  v.innerHTML = `
    <div class="chips pile-row">${pileHtml}</div>
    <div class="chips">
      <button class="gchip ${!gameChip ? "active" : ""}" data-chip="">All games
        <span class="v num">${money(allVal)}</span><span class="c num">${base.length}</span></button>${chips}
    </div>
    <div class="toolbar">
      <input type="search" id="q" placeholder="Search name, set, rarity…" value="${esc(filters.search)}" />
      <select id="sortsel">
        <option value="value" ${sortKey === "value" ? "selected" : ""}>Highest value</option>
        <option value="valueasc" ${sortKey === "valueasc" ? "selected" : ""}>Lowest value</option>
        <option value="psa10x" ${sortKey === "psa10x" ? "selected" : ""}>PSA-10 multiple</option>
        <option value="netpct" ${sortKey === "netpct" ? "selected" : ""}>Best net %</option>
      </select>
      <div class="seg" role="group" aria-label="View">
        <button id="vm-grid" class="${viewMode === "grid" ? "active" : ""}" aria-label="Grid view">${ico("i-grid")}</button>
        <button id="vm-list" class="${viewMode === "list" ? "active" : ""}" aria-label="List view">${ico("i-list")}</button>
      </div>
      ${viewMode === "list" && rawPile ? `<button class="ghost" id="sel-all">Select all</button>` : ""}
    </div>
    ${rawPile ? `
    <div class="filter-bar">
      <span class="fgroup">Price</span>${FACET_PRICE.map(([k, l]) => fchip("price", k, l)).join("")}
      <span class="fgroup">Route</span>${FACET_ROUTE.map(([k, l]) => fchip("route", k, l)).join("")}
      <span class="fgroup"></span>
      <button class="fchip ${filters.grade ? "active" : ""}" data-facet="grade" data-fkey="">Grade candidates</button>
      <button class="fchip ${filters.oc ? "active" : ""}" data-facet="oc" data-fkey="">Off-center</button>
      <button class="fchip ${filters.photo ? "active" : ""}" data-facet="photo" data-fkey="">Has photo</button>
      ${filters.price.size || filters.route.size || filters.rarity.size || filters.grade || filters.oc || filters.photo
        ? `<button class="fchip clear" id="f-clear">${ico("i-x", "s")} Clear</button>` : ""}
    </div>
    ${rarities.length ? `<div class="filter-bar rar">
      <button class="fgroup rar-toggle" id="rar-toggle">Rarity <span class="caret">${rarOpen ? "▾" : "▸"}</span></button>
      ${(rarOpen ? rarities.map(([k]) => k) : [...filters.rarity]).map((k) => fchip("rarity", k, esc(k))).join("")}
      ${!rarOpen && !filters.rarity.size ? `<span class="dim" style="font-size:12px">${rarities.length} types — click to filter</span>` : ""}
    </div>` : rarityMissing ? `<div class="filter-bar rar">
      <span class="fgroup">Rarity</span><span class="dim" style="font-size:12px">Re-import your export (Data → Import) to filter by rarity.</span>
    </div>` : ""}` : ""}
    <div id="decide-body"></div>`;

  const body = $("#decide-body");
  function fillBody() {
    const pool2 = currentPool();
    // Selection only ever means "checked cards in the current view" — prune
    // anything the active filter/search no longer shows.
    const ids = new Set(pool2.map((r) => r.id));
    [...selected].forEach((id) => { if (!ids.has(id)) selected.delete(id); });
    updateBatchBar();
    body.innerHTML = "";
    if (!pool2.length) { body.appendChild(decideEmpty(stats())); return; }
    if (viewMode === "list" && window.innerWidth >= 960) body.appendChild(renderTable(pool2.slice(0, CAP)));
    else if (viewMode === "list") { const w = document.createElement("div"); w.className = "rows"; pool2.slice(0, CAP).forEach((r, i) => w.appendChild(listRow(r, { pool: pool2, i }))); body.appendChild(w); }
    else { const g = document.createElement("div"); g.className = "grid"; pool2.slice(0, CAP).forEach((r, i) => g.appendChild(tile(r, pileKey === "all", { pool: pool2, i }))); body.appendChild(g); }
    if (pool2.length > CAP) body.insertAdjacentHTML("beforeend", `<div class="trunc-note num">Showing ${CAP} of ${pool2.length.toLocaleString()} — sort or filter to reach the rest.</div>`);
  }
  fillBody();

  // wiring
  document.querySelectorAll("[data-pile]").forEach((b) => b.addEventListener("click", () => nav("decide", b.dataset.pile)));
  document.querySelectorAll("[data-chip]").forEach((b) => b.addEventListener("click", () => {
    gameChip = b.dataset.chip; localStorage.setItem("gameChip", gameChip); renderDecide();
  }));
  document.querySelectorAll(".filter-bar [data-facet]").forEach((b) => b.addEventListener("click", () => {
    const f = b.dataset.facet, k = b.dataset.fkey;
    if (filters[f] instanceof Set) { filters[f].has(k) ? filters[f].delete(k) : filters[f].add(k); }
    else filters[f] = !filters[f];
    renderDecide();
  }));
  $("#f-clear")?.addEventListener("click", () => {
    filters.price.clear(); filters.route.clear(); filters.rarity.clear();
    filters.grade = false; filters.oc = false; filters.photo = false;
    renderDecide();
  });
  $("#rar-toggle")?.addEventListener("click", () => { rarOpen = !rarOpen; localStorage.setItem("rarOpen", rarOpen ? "1" : "0"); renderDecide(); });
  $("#q").addEventListener("input", (e) => { filters.search = e.target.value.trim(); fillBody(); });
  $("#sortsel").addEventListener("change", (e) => { sortKey = e.target.value; fillBody(); });
  $("#vm-grid").addEventListener("click", () => { viewMode = "grid"; localStorage.setItem("viewMode", "grid"); renderDecide(); });
  $("#vm-list").addEventListener("click", () => { viewMode = "list"; localStorage.setItem("viewMode", "list"); renderDecide(); });
  $("#sel-all")?.addEventListener("click", () => {
    const pool2 = currentPool();
    const allOn = pool2.length && pool2.every((r) => selected.has(r.id));
    pool2.forEach((r) => allOn ? selected.delete(r.id) : selected.add(r.id));
    fillBody();
  });
}

function decideEmpty(s) {
  const el = document.createElement("div");
  el.className = "empty";
  if (pileKey !== "undecided") {
    el.innerHTML = `${ico("i-search", "l")}<h4>Nothing in ${PILES.find(([k]) => k === pileKey)?.[1] || pileKey}${gameChip || filters.search ? " matching this view" : ""}.</h4>
      <p>${pileKey === "keep" ? "The ★ Keep quick-action files cards here." : "Filter, search, or file some cards."}</p>`;
    return el;
  }
  if (gameChip && s.undecided.length) {
    const other = GAMES.find(([k]) => k !== gameChip && s.undecided.some((r) => r.bucket === k));
    const label = GAMES.find(([k]) => k === gameChip)?.[1] || gameChip;
    el.innerHTML = `${ico("i-done", "l")}<h4>${label} is fully filed.</h4>
      ${other ? `<p>${other[1]} has ${s.undecided.filter((r) => r.bucket === other[0]).length} waiting.</p><button class="ghost" id="jump-chip">Go to ${other[1]} ${ico("i-chev", "s")}</button>` : ""}`;
    el.querySelector("#jump-chip")?.addEventListener("click", () => { gameChip = other[0]; renderDecide(); });
  } else if (!s.undecided.length) {
    const prepN = s.checkRows.length + s.gradePile.length + s.photosNeeded.length;
    el.innerHTML = `${ico("i-done", "l")}<h4>Decide pile is clear.</h4>
      <p>${prepN ? `${prepN} cards are in Prep — keep the line moving.` : "Everything's filed. Head to Cash Out."}</p>
      <button class="ghost" id="go-next">Go to ${prepN ? "Prep" : "Cash Out"}</button>`;
    el.querySelector("#go-next").addEventListener("click", () => nav(prepN ? "prep" : "cashout"));
  } else {
    el.innerHTML = `${ico("i-search", "l")}<h4>No cards match these filters.</h4><p>Clear a filter or two.</p>`;
  }
  return el;
}

function firstRun() {
  const el = document.createElement("div");
  el.className = "dropzone-hero";
  el.innerHTML = `<h3>Start with your Collectr export</h3>
    <p>In Collectr, go to Profile → Export Collection, then drop the CSV here.<br>Tags, piles, and photos survive every re-import.</p>
    <button class="cta" id="hero-pick">Choose export.csv</button>`;
  el.querySelector("#hero-pick").addEventListener("click", () => $("#import-file").click());
  ["dragover", "dragleave", "drop"].forEach((evName) => el.addEventListener(evName, (e) => {
    e.preventDefault();
    el.classList.toggle("drag", evName === "dragover");
    if (evName === "drop" && e.dataTransfer.files[0]) importCsv(e.dataTransfer.files[0]);
  }));
  return el;
}

// Desktop table. Fixed layout with explicit column widths so the File buttons
// stay at the same x across searches/re-renders — rapid filing needs a fixed
// target, not columns that re-flow with content. Card gets the remainder.
const TCOLS = [
  ["sel", null, null, 36], ["", null, null, 44], ["Card", null, null, 0], ["Cond", null, null, 76],
  ["Qty", "num", null, 48], ["Mkt", "num", "market", 88], ["Net", "num", "value", 80],
  ["Net %", "num", "netpct", 64], ["Route", null, null, 112], ["PSA 10", "num", null, 88],
  ["×", "num", "psa10x", 52], ["File", null, null, 186],
];
function renderTable(pool) {
  const w = document.createElement("div");
  w.className = "tablew";
  const t = document.createElement("table");
  t.className = "positions fixedcols";
  const poolIds = new Set(pool.map((r) => r.id));
  const canSelect = pool.some((r) => isRaw(r.bucket));   // graded/sealed: no batch filing
  const allSel = pool.length > 0 && pool.every((r) => selected.has(r.id));
  t.innerHTML = `<colgroup>${TCOLS.map(([, , , wpx]) => wpx ? `<col style="width:${wpx}px">` : "<col>").join("")}</colgroup>
    <thead><tr>${TCOLS.map(([label, cls, sk]) =>
    label === "sel"
      ? `<th>${canSelect ? `<input type="checkbox" id="sel-all-t" ${allSel ? "checked" : ""} aria-label="Select all in this view">` : ""}</th>`
      : `<th class="${cls || ""}" ${sk ? `data-sort="${sk}"` : ""}>${label}${sk === sortKey ? ' <span class="arrow">▼</span>' : ""}</th>`).join("")}</tr></thead><tbody></tbody>`;
  t.querySelector("#sel-all-t")?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const on = ev.currentTarget.checked;
    pool.forEach((r) => on ? selected.add(r.id) : selected.delete(r.id));
    document.querySelectorAll(".selbox").forEach((cb) => { cb.checked = on && poolIds.has(+cb.dataset.id); });
    updateBatchBar();
  });
  const tb = t.querySelector("tbody");
  pool.forEach((r, i) => {
    const tr = document.createElement("tr");
    const ctx = { pool, i };
    if (i === kfocus) tr.classList.add("kfocus");
    const showPsa = psaEligible(r);
    const raw = isRaw(r.bucket);   // graded/sealed: no filing controls
    tr.innerHTML = `
      <td>${raw ? `<input type="checkbox" class="selbox" data-id="${r.id}" ${selected.has(r.id) ? "checked" : ""} aria-label="Select ${esc(r.name)}">` : ""}</td>
      <td>${r.image_url ? `<img class="th" loading="lazy" src="${r.image_url}" alt="">` : ""}</td>
      <td><div class="cell-name">${esc(r.name)}</div><div class="cell-sub">${subLine(r)}</div></td>
      <td>${gradeNum(r) ? `<span class="grade-pill num">${gradeNum(r)}</span>` : r.condition && r.condition !== "NM" ? `<span class="fl" style="border-color:var(--amber);color:var(--amber);font-size:11px;border:1px solid;border-radius:4px;padding:0 5px">${r.condition}</span>` : ""}</td>
      <td class="num dim">${(r.qty || 1) > 1 ? "×" + r.qty : ""}</td>
      <td class="num">${money2(r.market_price || r.price)}</td>
      <td class="num net">${raw ? money(r.net_unit || 0) : ""}</td>
      <td class="num dim">${raw ? Math.round((r.net_pct || 0) * 100) + "%" : ""}</td>
      <td>${raw ? `<span class="route">${esc((r.channel || "").replace(" (", " ").replace(")", ""))}</span>` : ""}</td>
      <td class="num">${showPsa && r.psa10 ? (r.psa10_real ? "" : "~") + money(r.psa10) : ""}</td>
      <td class="num ${showPsa && r.psa10_x >= 8 ? "x-hot" : "dim"}">${showPsa && r.psa10_x ? r.psa10_x + "×" : ""}</td>
      <td>${raw ? `<div class="filecell">${[...DECISIONS, ...FLAGS].map((d) => `<button data-file="${d.key}" class="d-${d.key} ${fileActive(r, d.key) ? "on" : ""}" aria-label="${d.aria}" title="${d.aria}">${ico(d.icon, "s")}</button>`).join("")}</div>` : ""}</td>`;
    tr.addEventListener("click", () => openCard(r, ctx));
    tr.querySelector(".selbox")?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      ev.currentTarget.checked ? selected.add(r.id) : selected.delete(r.id);
      updateBatchBar();
    });
    wireFileButtons(tr, r);
    tb.appendChild(tr);
  });
  t.querySelectorAll("th[data-sort]").forEach((th) =>
    th.addEventListener("click", () => { sortKey = th.dataset.sort; renderDecide(); }));
  w.appendChild(t);
  w.dataset.pool = "table";
  return w;
}

// ── PREP ─────────────────────────────────────────────────────────────────────
function lane(title, count, total, sub) {
  const el = document.createElement("div");
  el.className = "lane";
  el.innerHTML = `<div class="lane-h"><h3>${title}</h3><span class="st-pill num">${count}</span>
    ${total != null ? `<span class="total num">${total}</span>` : ""}</div>
    <p class="lane-sub">${sub}</p><div class="lane-rows"></div><div class="lane-actions"></div>`;
  return el;
}
function laneRow(r, rightHtml) {
  const el = document.createElement("div");
  el.className = "lrow";
  el.innerHTML = `${imgTag(r)}<div class="lr-main"><div class="lr-name">${esc(r.name)}</div>
    <div class="lr-sub">${esc(r.set_name)} · <span class="num">${money2(r.price)}</span></div></div>${rightHtml}`;
  el.querySelector(".lr-main").addEventListener("click", () => openCard(r));
  return el;
}

function renderPrep() {
  const v = $("#view-prep");
  const s = stats();
  v.innerHTML = "";

  // 1) Condition check
  const l1 = lane("Condition check", s.checkRows.length, null, "Inspect each card and set its real condition — the price reprices instantly and the card goes back to Decide.");
  const r1 = l1.querySelector(".lane-rows");
  if (!s.checkRows.length) r1.innerHTML = `<div class="lane-empty">Nothing waiting on a condition check.</div>`;
  s.checkRows.slice(0, 50).forEach((r) => {
    const row = laneRow(r, `<div class="cond-seg">${CONDS.map((c) => `<button data-c="${c}" class="${(r.condition || "NM") === c ? "active" : ""}">${c}</button>`).join("")}</div>`);
    row.querySelectorAll("[data-c]").forEach((b) => b.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const cond = b.dataset.c;
      const patch = derivePricePatch(r, { condition: cond });
      patch.tags = (r.tags || []).filter((t) => t !== "not-nm");
      await save(r, patch);
      row.classList.add("flash");
      toast(`${r.name}: ${cond} — ${money2(patch.price)}, nets ${money(patch.net_unit || 0)}`);
      setTimeout(renderAll, 500);
    }));
    r1.appendChild(row);
  });
  v.appendChild(l1);

  // 2) Grade pile
  const rawSum = s.gradePile.reduce((a, r) => a + r.price * (r.qty || 1), 0);
  const gapSum = s.gradePile.reduce((a, r) => a + (r.grade_gap || 0) * (r.qty || 1), 0);
  const l2 = lane("Grade pile", s.gradePile.length, null,
    s.gradePile.length ? `${plural(s.gradePile.length, "card")} · ${money(rawSum)} raw · worth ~${money(gapSum)} more graded. Check centering before submitting.` : "Cards you file to Grade collect here.");
  const r2 = l2.querySelector(".lane-rows");
  if (!s.gradePile.length) r2.innerHTML = `<div class="lane-empty">Empty — the ${ico("i-grade", "s")} quick-action files cards here.</div>`;
  s.gradePile.slice(0, 50).forEach((r) => r2.appendChild(laneRow(r,
    `<div class="lr-val num" title="Extra net if graded">+${money(r.grade_gap || 0)}</div>`)));
  v.appendChild(l2);

  // 3) Photos needed
  const l3 = lane("Photos needed", s.photosNeeded.length, null, "eBay buyers trust real photos. Snap the front and back in good light.");
  const r3 = l3.querySelector(".lane-rows");
  if (!s.photosNeeded.length) r3.innerHTML = `<div class="lane-empty">Every eBay-bound card has photos.</div>`;
  s.photosNeeded.slice(0, 50).forEach((r) => {
    const row = laneRow(r, `<button class="ghost" aria-label="Add photos">${ico("i-camera")}</button>`);
    row.querySelector("button").addEventListener("click", (ev) => { ev.stopPropagation(); openCard(r); });
    r3.appendChild(row);
  });
  v.appendChild(l3);

  // 4) Sell — route each card to a channel, then export the sheets
  const sell = s.sellRows;
  const netOf = (arr) => arr.reduce((a, r) => a + (r.net_unit || 0) * (r.qty || 1), 0);
  const l4 = lane("Sell — route &amp; export", sell.length, money(netOf(sell)) + " net",
    "Set each card's channel (auto-suggested from best net). eBay listings copy per-card from the card panel; TCGplayer and shop export as sheets below.");
  const r4 = l4.querySelector(".lane-rows");
  if (!sell.length) r4.innerHTML = `<div class="lane-empty">Mark cards ${ico("i-sell", "s")} Sell in Cards — route them here.</div>`;
  sell.slice(0, 80).forEach((r) => {
    const ch = channelOf(r);
    const seg = `<div class="cond-seg ch-seg">${CHANNELS.map(([k, l]) => `<button data-ch="${k}" class="${ch === k ? "active" : ""}">${l}</button>`).join("")}</div>`;
    const row = laneRow(r, seg);
    row.querySelectorAll("[data-ch]").forEach((b) => b.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const tags = (r.tags || []).filter((t) => !["ch-ebay", "ch-tcg", "ch-shop"].includes(t));
      tags.push("ch-" + b.dataset.ch);
      await save(r, { tags });
      renderPrep();
    }));
    r4.appendChild(row);
  });
  if (sell.length > 80) r4.insertAdjacentHTML("beforeend", `<div class="trunc-note num">Showing 80 of ${sell.length}.</div>`);
  const tcgCards = sell.filter((r) => channelOf(r) === "tcg");
  const shopCards = sell.filter((r) => channelOf(r) === "shop");
  l4.querySelector(".lane-actions").innerHTML =
    `<button class="ghost" id="tcgp-export" ${tcgCards.length ? "" : "disabled"}>${ico("i-export", "s")} TCGplayer sheet (${tcgCards.length})</button>
     <button class="ghost" id="lcs-export" ${shopCards.length ? "" : "disabled"}>${ico("i-export", "s")} Shop drop-off sheet (${shopCards.length})</button>`;
  l4.querySelector("#tcgp-export").addEventListener("click", tcgpExport);
  l4.querySelector("#lcs-export").addEventListener("click", lcsCsv);
  v.appendChild(l4);
}

// ── CASH OUT ─────────────────────────────────────────────────────────────────
// ── TRADE ─────────────────────────────────────────────────────────────────────
// Two baskets: what you GIVE (your cards, inventory-autocomplete + cash) and
// what you GET (cash offer, or manually-entered cards). The middle shows what
// % of the market value you give you're getting back — the convention haggle
// check. Persisted so a session survives a reload.
let trade = (() => { try { return JSON.parse(localStorage.getItem("trade") || "") || { give: [], get: [] }; } catch { return { give: [], get: [] }; } })();
const saveTrade = () => localStorage.setItem("trade", JSON.stringify(trade));
const sideTotal = (side) => trade[side].reduce((a, it) => a + (it.kind === "cash" ? (+it.unit || 0) : (+it.unit || 0) * (it.qty || 1)), 0);

function tradeItemRow(side, it, idx) {
  const el = document.createElement("div");
  el.className = "trade-item";
  if (it.kind === "cash") {
    el.innerHTML = `<span class="ti-cash">${ico("i-sell", "s")}</span>
      <div class="ti-main"><div class="ti-name">Cash</div></div>
      <div class="ti-amt">$<input type="number" class="ti-unit" value="${+it.unit || 0}" min="0" step="1" inputmode="decimal"></div>
      <button class="ti-x" aria-label="Remove">${ico("i-x", "s")}</button>`;
  } else {
    el.innerHTML = `${it.image_url ? `<img class="ti-img" src="${esc(it.image_url)}" alt="">` : `<span class="ti-cash">${ico("i-grid", "s")}</span>`}
      <div class="ti-main"><div class="ti-name">${esc(it.name)}</div><div class="ti-sub">${esc(it.sub || "")}</div></div>
      <div class="ti-qty"><button class="qd" aria-label="Less">–</button><span class="num">${it.qty || 1}</span><button class="qu" aria-label="More">+</button></div>
      <div class="ti-amt">$<input type="number" class="ti-unit" value="${+it.unit || 0}" min="0" step="0.01" inputmode="decimal"></div>
      <button class="ti-x" aria-label="Remove">${ico("i-x", "s")}</button>`;
    el.querySelector(".qd").addEventListener("click", () => { it.qty = Math.max(1, (it.qty || 1) - 1); saveTrade(); renderTrade(); });
    el.querySelector(".qu").addEventListener("click", () => { it.qty = (it.qty || 1) + 1; saveTrade(); renderTrade(); });
  }
  el.querySelector(".ti-unit").addEventListener("change", (e) => { it.unit = Math.max(0, +e.target.value || 0); saveTrade(); renderTrade(); });
  el.querySelector(".ti-x").addEventListener("click", () => { trade[side].splice(idx, 1); saveTrade(); renderTrade(); });
  return el;
}

function renderTrade() {
  const v = $("#view-cashout");
  const give = sideTotal("give"), get = sideTotal("get");
  const pct = give > 0 ? Math.round((get / give) * 100) : 0;
  const pctCls = !give || !get ? "dim" : pct >= 100 ? "pos" : pct >= 80 ? "amber" : "neg";
  const delta = get - give;

  v.innerHTML = `
    <div class="trade-head">
      <h2>Trade calculator</h2>
      <p class="dim">Load your cards on the left and the cash/cards you'd get on the right — the middle tells you what % of market value you're being offered. ${trade.give.length || trade.get.length ? `<button class="linkbtn" id="trade-clear">Clear</button>` : ""}</p>
    </div>
    <div class="trade-cols">
      <div class="trade-col" id="col-give">
        <div class="tc-head"><h3>You give</h3><span class="tc-total num">${money2(give)}</span></div>
        <div class="tc-search">
          <input type="search" id="give-search" placeholder="Search your inventory…" autocomplete="off">
          <div class="tc-drop hidden" id="give-drop"></div>
        </div>
        <div class="tc-items" id="give-items"></div>
        <button class="ghost tc-cash" data-add-cash="give">${ico("i-sell", "s")} Add cash</button>
      </div>

      <div class="trade-mid">
        <div class="tm-pct num ${pctCls}">${give && get ? pct + "%" : "—"}</div>
        <div class="tm-lbl">of market value</div>
        <div class="tm-arrow">${ico("i-chev")}</div>
        <div class="tm-delta num ${delta >= 0 ? "pos" : "neg"}">${give && get ? (delta >= 0 ? "+" : "") + money(delta) : ""}</div>
        <div class="tm-note dim">${!give ? "Add what you're giving." : !get ? "Add the offer on the right." : pct >= 100 ? "At or above market — strong offer." : pct >= 80 ? "A bit under market — normal for a quick cash-out." : "Well under market — push back or hold."}</div>
      </div>

      <div class="trade-col" id="col-get">
        <div class="tc-head"><h3>You get</h3><span class="tc-total num">${money2(get)}</span></div>
        <div class="tc-items" id="get-items"></div>
        <div class="tc-adds">
          <button class="ghost tc-cash" data-add-cash="get">${ico("i-sell", "s")} Add cash</button>
          <button class="ghost" id="get-add-card">${ico("i-grid", "s")} Add a card</button>
        </div>
      </div>
    </div>`;

  const gi = $("#give-items");
  trade.give.forEach((it, i) => gi.appendChild(tradeItemRow("give", it, i)));
  if (!trade.give.length) gi.innerHTML = `<div class="tc-empty">Search above to add your cards, or add cash.</div>`;
  const ge = $("#get-items");
  trade.get.forEach((it, i) => ge.appendChild(tradeItemRow("get", it, i)));
  if (!trade.get.length) ge.innerHTML = `<div class="tc-empty">Add the cash offer (or a card) you'd receive.</div>`;

  // Inventory autocomplete (give side, inventory-only)
  const search = $("#give-search"), drop = $("#give-drop");
  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    if (q.length < 2) { drop.classList.add("hidden"); return; }
    const hits = rows.filter((r) => ((r.name || "") + " " + (r.set_name || "")).toLowerCase().includes(q)).slice(0, 8);
    if (!hits.length) { drop.innerHTML = `<div class="tc-opt dim">No inventory match</div>`; drop.classList.remove("hidden"); return; }
    drop.innerHTML = hits.map((r, i) => `<button class="tc-opt" data-i="${rows.indexOf(r)}">
      ${r.image_url ? `<img src="${esc(r.image_url)}" alt="">` : `<span class="noimg">${ico("i-grid", "s")}</span>`}
      <span class="o-main"><span class="o-name">${esc(r.name)}</span><span class="o-sub">${esc(subLine(r))}</span></span>
      <span class="o-price num">${money2(r.market_price || r.price)}</span></button>`).join("");
    drop.classList.remove("hidden");
    drop.querySelectorAll(".tc-opt[data-i]").forEach((b) => b.addEventListener("click", () => {
      const r = rows[+b.dataset.i];
      trade.give.push({ kind: "card", key: r.natural_key, name: r.name, sub: subLine(r).replace(/<[^>]*>/g, ""),
        qty: 1, unit: +(r.market_price || r.price) || 0, image_url: r.image_url });
      saveTrade(); renderTrade();
    }));
  });
  search.addEventListener("blur", () => setTimeout(() => drop.classList.add("hidden"), 200));

  v.querySelectorAll("[data-add-cash]").forEach((b) => b.addEventListener("click", () => {
    trade[b.dataset.addCash].push({ kind: "cash", unit: 0 }); saveTrade(); renderTrade();
  }));
  $("#get-add-card").addEventListener("click", () => {
    const name = prompt("Card name (what you're trading for):");
    if (!name) return;
    const val = parseFloat(prompt("Its market value ($):") || "0") || 0;
    trade.get.push({ kind: "card", name: name.trim(), sub: "manual entry", qty: 1, unit: val, image_url: null });
    saveTrade(); renderTrade();
  });
  $("#trade-clear")?.addEventListener("click", () => { trade = { give: [], get: [] }; saveTrade(); renderTrade(); });
}

function ledger(s) {
  const el = document.createElement("div");
  el.className = "ledger";
  const cents = s.mkt ? Math.round((s.net / s.mkt) * 100) : 0;
  el.innerHTML = `<h3>If everything sells</h3>
    <div class="big num">${money(s.net)}</div>
    <div class="lline num">from ${money(s.mkt)} market · ${cents}¢ on the dollar — projected, not sold.</div>
    <div class="bar"><i style="width:${cents}%"></i></div>
    <div class="lline num">${plural(s.keepers.length, "keeper")} held back (${money(s.keepersVal)}) · fees and shipping take the rest.</div>`;
  return el;
}

// ── Card modal ───────────────────────────────────────────────────────────────
// modalCtx = {pool, i}: the visible list the card was opened from. Filing a
// card auto-advances to the next one so a binder page can be worked without
// closing the panel; ←/→ and on-screen chevrons move manually.
let modalCtx = null;
function closeCard() { modalCtx = null; $("#card-modal").classList.add("hidden"); }
function modalStep(delta) {
  if (!modalCtx) return;
  const next = modalCtx.i + delta;
  if (next < 0 || next >= modalCtx.pool.length) {
    if (delta > 0) { closeCard(); toast("End of this pile — nice work."); }
    return;
  }
  openCard(modalCtx.pool[next], { pool: modalCtx.pool, i: next });
}
function openCard(r, ctx = null) {
  modalCtx = ctx;
  const panel = $("#modal-panel");
  const route = r.channel ? r.channel.replace(" (", " ").replace(")", "") : "";
  const soldUrl = "https://www.ebay.com/sch/i.html?LH_Sold=1&LH_Complete=1&_nkw=" +
    encodeURIComponent(`${r.bucket === "pkmn" ? "pokemon " : ""}${r.name} ${r.set_name} ${(r.number || "").split("/")[0]}`.replace(/\s+/g, " ").trim());
  const srcLabel = r.psa10_real ? "PriceCharting (sold)" : "Collectr import";
  // PSA is REAL sold data only — never an estimate.
  const psa = r.bucket === "pkmn" && r.psa10_real && r.psa10 > 0 && psaEligible(r)
    ? `<div class="m-line num ${(r.psa10_x || 0) >= 8 ? "hot" : ""}">PSA 10 ${money(r.psa10)} · ${r.psa10_x}× raw${(r.psa10_x || 0) >= 8 ? " — don't sell raw" : ""}</div>` : "";
  // Grade box: real comps only (psa10_real), plain profit/loss if it 10s or 9s.
  const gbd = r.bucket === "pkmn" && psaEligible(r) && r.psa10_real ? gradingBreakdown(r.net_unit || 0, +r.psa9 || 0, +r.psa10 || 0) : null;
  const plRow = (label, net, pl) => net == null ? "" :
    `<div class="gb-row"><span>${label} → nets ${money(net)}</span><b class="num ${pl >= 0 ? "pos" : "neg"}">${pl >= 0 ? "+" : ""}${money(pl)}</b></div>`;
  const gradeHtml = gbd ? `
        <div class="m-seclbl">Should you grade it?</div>
        <div class="grade-box">
          <div class="gb-row"><span>Sell raw now</span><b class="num">${money(r.net_unit || 0)}</b></div>
          ${plRow("If PSA 10", gbd.psa10Net, gbd.ifTenProfit)}
          ${plRow("If PSA 9", gbd.psa9Net, gbd.ifNineProfit)}
          <div class="gb-note">Profit/loss vs selling raw, after ~${money(gbd.gradeCost)} grading (${esc(gbd.tier)}) — verify centering first.</div>
        </div>` : "";
  const cur = decisionOf(r);
  const navHtml = ctx ? `<div class="m-nav">
      <button class="ghost" id="m-prev" ${ctx.i <= 0 ? "disabled" : ""} aria-label="Previous card">‹</button>
      <span class="num dim">${ctx.i + 1} / ${ctx.pool.length}</span>
      <button class="ghost" id="m-next" ${ctx.i >= ctx.pool.length - 1 ? "disabled" : ""} aria-label="Next card">›</button>
    </div>` : "";
  panel.innerHTML = `
    ${navHtml}
    <button class="modal-close" aria-label="Close">${ico("i-x", "m")}</button>
    <div class="m-grid">
      <div class="m-art">${imgTag(r)}</div>
      <div>
        <h3 class="m-title">${esc(r.name)}</h3>
        <div class="m-sub">${esc(r.set_name)}${r.number ? " · #" + esc(r.number) : ""}${r.variance ? " · " + esc(r.variance) : ""}${r.grade && r.grade !== "Ungraded" ? " · " + esc(r.grade) : ""}</div>
        <div class="m-price"><span class="p num">${money2(r.price)}</span>${(r.qty || 1) > 1 ? `<span class="q num" style="border:1px solid var(--border-strong);border-radius:6px;padding:0 8px;font-size:12px;color:var(--text-2)">×${r.qty}</span>` : ""}</div>
        ${isRaw(r.bucket) ? `<div class="m-line num dim">Best route: ${esc(route)} · nets <span class="net">${money(r.net_unit || 0)}</span> (${Math.round((r.net_pct || 0) * 100)}%)</div>` : ""}
        ${psa}
        ${isRaw(r.bucket) ? `<div class="m-line num">Shop offer: <span class="net">${money(r.shop_trade || 0)}</span> trade / ${money(r.shop_cash || 0)} cash</div>` : ""}
        ${isRaw(r.bucket) ? `<div class="m-line num dim">Price: ${srcLabel} · <a href="${soldUrl}" target="_blank" rel="noopener" style="color:var(--accent)">recent sold ↗</a></div>` : ""}
        ${gradeHtml}

        ${isRaw(r.bucket) ? `
        <div class="m-seclbl">Condition</div>
        <div class="cond-seg" id="m-cond">${CONDS.map((c) => `<button data-c="${c}" class="${(r.condition || "NM") === c ? "active" : ""}">${c}</button>`).join("")}</div>

        <div class="m-seclbl">Sell or keep?</div>
        <div class="m-decide">${DECISIONS.map((d) =>
          `<button data-file="${d.key}" class="d-${d.key} ${fileActive(r, d.key) ? "on" : ""}" aria-label="${d.aria}">${ico(d.icon)}<span>${d.label}</span></button>`).join("")}</div>
        <div class="m-seclbl">Prep flags <span class="dim" style="text-transform:none;letter-spacing:0">(optional, before or after deciding)</span></div>
        <div class="m-decide">${FLAGS.map((d) =>
          `<button data-file="${d.key}" class="d-${d.key} ${fileActive(r, d.key) ? "on" : ""}" aria-label="${d.aria}">${ico(d.icon)}<span>${d.label}</span></button>`).join("")}</div>
        <div class="m-tools">
          <button class="ghost ${offC(r) ? "active tog-chip" : ""}" id="m-oc">${ico("i-offcenter", "s")} Off-center${offC(r) ? " ✓" : ""}</button>
          <button class="ghost" id="m-ebay">${ico("i-copy", "s")} Copy eBay listing</button>
        </div>

        <div class="m-seclbl">Photos for eBay</div>
        <div class="m-line dim" style="margin-top:-2px">eBay buyers trust real photos. Snap the front and back in good light.</div>
        <div class="ps-wrap">${photoSlot(r, "front")}${photoSlot(r, "back")}</div>` : ""}
      </div>
    </div>`;
  panel.querySelector(".modal-close").addEventListener("click", closeCard);
  const ctxHere = ctx;
  $("#m-prev")?.addEventListener("click", () => modalStep(-1));
  $("#m-next")?.addEventListener("click", () => modalStep(1));
  if (isRaw(r.bucket)) {
    panel.querySelectorAll("#m-cond [data-c]").forEach((b) => b.addEventListener("click", async () => {
      const cond = b.dataset.c;
      const patch = derivePricePatch(r, { condition: cond });
      patch.tags = (r.tags || []).filter((t) => t !== "not-nm");
      await save(r, patch);
      renderAll(); openCard(r, ctxHere);
      toast(`Condition ${cond} — ${money2(patch.price)}, nets ${money(patch.net_unit || 0)}`);
    }));
    panel.querySelectorAll(".m-decide [data-file]").forEach((b) => b.addEventListener("click", async () => {
      const key = b.dataset.file;
      await fileCard(r, key);
      // A primary decision walks the line to the next card; a flag toggle stays.
      if (ctxHere && !isFlagKey(key) && decided(r)) { modalCtx = ctxHere; modalStep(1); }
      else openCard(r, ctxHere);
    }));
    $("#m-oc").addEventListener("click", async () => {
      const t = offC(r) ? (r.tags || []).filter((x) => x !== "off-center") : [...(r.tags || []), "off-center"];
      await save(r, { tags: t }); renderAll(); openCard(r, ctxHere);
    });
    $("#m-ebay").addEventListener("click", async (ev) => {
      try { await navigator.clipboard.writeText(ebayListingText(r)); ev.currentTarget.innerHTML = `${ico("i-done", "s")} Copied`; toast("Copied — paste into eBay's Sell form"); }
      catch (e) { alert(ebayListingText(r)); }
    });
    panel.querySelectorAll("input[type=file]").forEach((inp) =>
      inp.addEventListener("change", () => { if (inp.files[0]) uploadPhoto(r, inp.dataset.side, inp.files[0]); }));
    panel.querySelectorAll("[data-delphoto]").forEach((b) =>
      b.addEventListener("click", () => deletePhoto(r, b.dataset.delphoto)));
  }
  $("#card-modal").classList.remove("hidden");

  (async () => {
    if (!DEMO) {
      const { data: { user } } = await sb.auth.getUser();
      if (user) for (const side of r.photos || []) {
        const { data } = await sb.storage.from("card-photos").createSignedUrl(`${user.id}/${r.natural_key}/${side}.jpg`, 3600);
        const img = panel.querySelector(`img[data-photo="${side}"]`);
        if (data?.signedUrl && img) img.src = data.signedUrl;
      }
    }
  })();
}

function photoSlot(r, side) {
  const has = (r.photos || []).includes(side);
  return `<div class="photo-slot">
    <label class="ps-drop">${has ? `<img data-photo="${side}" alt="${side}">` : `${ico("i-camera", "m")}<span>Add ${side}</span>`}
      <input type="file" accept="image/*" capture="environment" data-side="${side}" hidden></label>
    <div class="ps-row"><span>${side}</span>${has ? `<button data-delphoto="${side}">remove</button>` : ""}</div></div>`;
}

async function uploadPhoto(r, side, file) {
  if (DEMO) { toast("Demo mode — sign in to save photos"); return; }
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return;
  const { error } = await sb.storage.from("card-photos").upload(`${user.id}/${r.natural_key}/${side}.jpg`, file, { upsert: true, contentType: file.type || "image/jpeg" });
  if (error) { toast("Photo upload failed: " + error.message); return; }
  await save(r, { photos: Array.from(new Set([...(r.photos || []), side])) });
  openCard(r, modalCtx); renderAll();
}
// Used by the bulk scanner: store a captured still as the card's front photo.
async function uploadScanPhoto(row, blob) {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return false;
  const { error } = await sb.storage.from("card-photos").upload(`${user.id}/${row.natural_key}/front.jpg`, blob, { upsert: true, contentType: "image/jpeg" });
  if (error) return false;
  await save(row, { photos: Array.from(new Set([...(row.photos || []), "front"])) });
  return true;
}
async function openScanner() {
  if (DEMO) { toast("Demo mode — sign in to scan your own cards"); return; }
  if (!rows.length) { toast("Import your collection first, then scan."); return; }
  try {
    const mod = await import("./scan.js");
    await mod.openScanner({
      sb, ANON: SUPABASE_ANON, FN_BASE: SUPABASE_URL + "/functions/v1",
      rows, derivePricePatch, save, uploadScanPhoto, toast, reload: load,
    });
  } catch (e) { toast("Scanner failed to load: " + (e.message || e)); }
}
async function deletePhoto(r, side) {
  if (DEMO) return;
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return;
  await sb.storage.from("card-photos").remove([`${user.id}/${r.natural_key}/${side}.jpg`]);
  await save(r, { photos: (r.photos || []).filter((s) => s !== side) });
  openCard(r, modalCtx); renderAll();
}

// Value over time — peak high/low, current-vs-peak, and trend — from the
// price_history snapshots taken on every import and price refresh. Shows a
// tracking note until there are ≥2 points so it never renders empty/misleading.
async function trendHtml(r) {
  if (!isRaw(r.bucket)) return "";
  const { data } = await sb.from("price_history").select("price,ts")
    .eq("natural_key", r.natural_key).order("ts", { ascending: true }).limit(400);
  const pts = (data || []).map((d) => ({ p: +d.price || 0, t: new Date(d.ts) })).filter((d) => d.p > 0);
  if (pts.length < 2) {
    return `<div class="m-seclbl">Value over time</div>
      <div class="m-line dim" style="margin-top:-2px">Tracking — one data point so far. Each import and price refresh adds a snapshot; check back to see the trend.</div>`;
  }
  const prices = pts.map((d) => d.p);
  const hi = Math.max(...prices), lo = Math.min(...prices);
  const hiPt = pts.find((d) => d.p === hi), loPt = pts.find((d) => d.p === lo);
  const first = pts[0], last = pts[pts.length - 1];
  const days = Math.max(1, Math.round((last.t - first.t) / 864e5));
  const chg = first.p ? (last.p - first.p) / first.p : 0;
  const fromPeak = hi ? Math.round((last.p / hi - 1) * 100) : 0;
  const icon = chg > 0.03 ? "i-trend-up" : chg < -0.03 ? "i-trend-down" : "i-list";
  const word = chg > 0.03 ? "Trending up" : chg < -0.03 ? "Trending down" : "Flat";
  const cls = chg > 0.03 ? "pos" : chg < -0.03 ? "neg" : "dim";
  const dt = (d) => d.t.toISOString().slice(0, 10);
  return `<div class="m-seclbl">Value over time</div>
    <div class="trend-box">
      <div class="trend-hd"><span class="${cls}" style="display:inline-flex;align-items:center;gap:5px">${ico(icon, "s")} ${word} ${chg >= 0 ? "+" : ""}${(chg * 100).toFixed(0)}%</span>
        <span class="dim num">over ${days}d · ${pts.length} snapshots</span></div>
      <div class="trend-grid num">
        <div><span class="dim">Peak high</span><b>${money2(hi)}</b><span class="dim">${dt(hiPt)}</span></div>
        <div><span class="dim">Peak low</span><b>${money2(lo)}</b><span class="dim">${dt(loPt)}</span></div>
        <div><span class="dim">Now</span><b>${money2(last.p)}</b><span class="${fromPeak < -1 ? "neg" : "dim"}">${fromPeak <= 0 ? "" : "+"}${fromPeak}% vs peak</span></div>
      </div>
      ${fromPeak <= -10 ? `<div class="gb-note">Down ${Math.abs(fromPeak)}% from its peak — if you're selling, sooner beats later while it's still soft.</div>`
        : chg > 0.1 ? `<div class="gb-note">Climbing — you may have room to wait, but peaks are hard to time.</div>` : ""}
    </div>`;
}

// ── eBay listing text ────────────────────────────────────────────────────────
function ebayListingText(r) {
  const game = r.bucket === "pkmn" ? "Pokemon TCG" : r.bucket === "mtg" ? "MTG Magic" : r.bucket === "op" ? "One Piece Card Game" : "Yu-Gi-Oh";
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
    `  Game: ${game}`, `  Card Name: ${r.name}`, `  Set: ${r.set_name}`,
    `  Card Number: ${r.number || "-"}`, `  Rarity/Finish: ${r.variance || "-"}`,
    `  Condition: ${r.condition === "NM" || !r.condition ? "Near Mint or Better" : r.condition}`,
    `  Language: ${(r.flags || []).includes("japanese") ? "Japanese" : "English"}`, `  Graded: No`,
  ].join("\n");
}

// ── CSV exports ──────────────────────────────────────────────────────────────
function downloadCsv(lines, filename) {
  const blob = new Blob([lines.join("\r\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  URL.revokeObjectURL(a.href);
}
const csvq = (s) => '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"';

function lcsCsv() {
  const picks = rows.filter((r) => hasTag(r, "sell") && channelOf(r) === "shop" && !r.keep).sort((a, b) => b.price - a.price);
  if (!picks.length) { toast("Shop pile is empty."); return; }
  let tv = 0, tt = 0, tc = 0;
  const lines = ["Card,Set,Number,Condition,Your Value,Trade (store credit),Cash"];
  for (const r of picks) {
    const v = +r.price || 0, t = +r.shop_trade || 0, c = +r.shop_cash || 0;
    tv += v; tt += t; tc += c;
    lines.push([csvq(r.name), csvq(r.set_name), csvq(r.number), csvq(r.condition || "NM"), v.toFixed(2), t.toFixed(2), c.toFixed(2)].join(","));
  }
  lines.push(["TOTAL", "", "", "", tv.toFixed(2), tt.toFixed(2), tc.toFixed(2)].join(","));
  downloadCsv(lines, "lcs_dropoff_" + new Date().toISOString().slice(0, 10) + ".csv");
  toast(`Drop-off sheet downloaded — ${picks.length} cards, ${money(tt)} trade`);
}

const TCGP_HEADER = ["TCGplayer Id", "Product Line", "Set Name", "Product Name", "Title", "Number", "Rarity", "Condition",
  "TCG Market Price", "TCG Direct Low", "TCG Low Price With Shipping", "TCG Low Price", "Total Quantity", "Add to Quantity",
  "TCG Marketplace Price", "Photo URL"];

async function tcgpExport() {
  if (DEMO) { toast("Demo mode — sign in to export"); return; }
  const picks = stats().sellRows.filter((r) => channelOf(r) === "tcg");
  if (!picks.length) { toast("No Sell cards routed to TCGplayer (set channels in Prep)."); return; }
  setStatus(`Matching ${picks.length} cards against the catalog…`);
  const matched = [], unmatched = [];
  const queue = [...picks];
  const worker = async () => {
    while (queue.length) {
      const r = queue.shift();
      const cond = tcgpCondition(r.bucket === "mtg" ? "Magic: The Gathering" : r.bucket === "op" ? "One Piece" : "Pokemon", r.variance, r.condition);
      const setName = TCGP_SET_ALIASES[(r.set_name || "").trim()] || r.set_name;
      const numN = normNumTCGP(r.number);
      if (!cond || !numN) { unmatched.push(r); continue; }
      const { data } = await sb.from("tcgp_catalog").select("raw")
        .eq("set_norm", normSetTCGP(setName)).eq("num_norm", numN).eq("condition", cond).limit(2);
      if (data && data.length === 1) matched.push([r, data[0].raw]);
      else unmatched.push(r);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  if (!matched.length) { toast(`0 of ${picks.length} matched — is the catalog loaded for these games?`); renderAll(); return; }
  const lines = [TCGP_HEADER.join(",")];
  for (const [r, raw] of matched) {
    const row = { ...raw };
    row["Add to Quantity"] = String(r.qty || 1);
    if (!(row["TCG Marketplace Price"] || "").trim()) {
      row["TCG Marketplace Price"] = row["TCG Market Price"] || row["TCG Low Price With Shipping"] || row["TCG Low Price"] || row["TCG Direct Low"] || (+r.price).toFixed(2);
    }
    lines.push(TCGP_HEADER.map((h) => csvq(row[h] ?? "")).join(","));
  }
  downloadCsv(lines, "TCGplayer_add_" + new Date().toISOString().slice(0, 10) + ".csv");
  toast(`TCGplayer sheet: ${matched.length} rows${unmatched.length ? ` · ${unmatched.length} unmatched (list manually)` : ""}`, null, 5000);
  renderAll();
}

// ── Import / catalog / prices / delete ───────────────────────────────────────
async function importCsv(file) {
  if (DEMO) { toast("Demo mode — sign in to import your own collection"); return; }
  try {
    setStatus("Reading file…");
    const text = await file.text();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return;
    setStatus("Loading existing tags…");
    const existing = {};
    for (let from = 0; from < 20000; from += 1000) {
      const { data, error } = await sb.from("cards").select("natural_key,tags,condition,keep,photos")
        .order("id", { ascending: true }).range(from, from + 999);
      if (error) break;
      (data || []).forEach((r) => { existing[r.natural_key] = r; });
      if (!data || data.length < 1000) break;
    }
    const cards = await buildRows(text, existing, setStatus);
    // Refuse a wrong file BEFORE touching the inventory. A non-Collectr CSV
    // (e.g. a TCGplayer pricing export) once wiped everything — never again.
    if (cards.meta?.notCollectr) {
      setStatus("");
      toast("That doesn't look like a Collectr export — needs Category, Product Name, and Market Price columns. Your inventory is untouched. (TCGplayer pricing files go under Data → TCGplayer catalog.)", null, 9000);
      return;
    }
    if (!cards.length) { setStatus("No cards found — is this a Collectr export.csv? Your inventory is untouched."); return; }
    cards.forEach((c) => {
      c.user_id = user.id;
      const prev = existing[c.natural_key];
      if (prev?.photos?.length) c.photos = prev.photos;
    });
    // Sealed art: exact-name lookup against the tcgp_products mirror.
    const sealedRows = cards.filter((c) => c.bucket === "sealed" && !c.image_url);
    if (sealedRows.length) {
      setStatus(`Matching ${sealedRows.length} sealed products…`);
      try {
        for (let i = 0; i < sealedRows.length; i += 100) {
          const chunk = sealedRows.slice(i, i + 100);
          const { data } = await sb.from("tcgp_products").select("product_id,name")
            .in("name", chunk.map((c) => c.name));
          const byName = Object.fromEntries((data || []).map((p) => [p.name, p.product_id]));
          chunk.forEach((c) => { if (byName[c.name]) c.image_url = sealedImageUrl(byName[c.name]); });
        }
      } catch (e) { /* lookup table optional */ }
    }
    const ygo = cards.filter((c) => c.bucket === "ygo" && !c.image_url);
    if (ygo.length) {
      setStatus(`Fetching ${ygo.length} Yu-Gi-Oh images…`);
      const q = [...ygo];
      const w = async () => {
        while (q.length) {
          const c = q.shift();
          try {
            const resp = await fetch("https://db.ygoprodeck.com/api/v7/cardinfo.php?name=" + encodeURIComponent(c.name));
            if (resp.ok) c.image_url = (await resp.json())?.data?.[0]?.card_images?.[0]?.image_url_small || null;
          } catch (e) { /* keep null */ }
        }
      };
      await Promise.all([w(), w(), w()]);
    }
    setStatus("Replacing your inventory…");
    const del = await sb.from("cards").delete().eq("user_id", user.id);
    if (del.error) { setStatus("Import failed: " + del.error.message); return; }
    for (let i = 0; i < cards.length; i += 500) {
      setStatus(`Uploading ${Math.min(i + 500, cards.length)}/${cards.length}…`);
      const ins = await sb.from("cards").insert(cards.slice(i, i + 500));
      if (ins.error) { setStatus("Import failed: " + ins.error.message); return; }
    }
    const skipV = cards.meta?.skippedValue || 0;
    toast(`Imported ${cards.length} cards${skipV >= 1 ? ` · left out ${money(skipV)} of tokens/misc (not sellable as singles)` : ""}`, null, 6000);
    load();
  } catch (e) { setStatus("Import failed: " + (e.message || e)); }
}

async function catalogUpload(files) {
  if (DEMO) { toast("Demo mode"); return; }
  let total = 0;
  for (const file of files) {
    setStatus(`Parsing ${file.name}…`);
    const recs = parseCSV(await file.text());
    const out = [];
    for (const r of recs) {
      const sku = parseInt(r["TCGplayer Id"]);
      if (!sku) continue;
      out.push({ sku_id: sku, product_line: r["Product Line"] || "", set_norm: normSetTCGP(r["Set Name"]),
                 num_norm: normNumTCGP(r["Number"]), condition: r["Condition"] || "", raw: r });
    }
    for (let i = 0; i < out.length; i += 500) {
      setStatus(`${file.name}: ${Math.min(i + 500, out.length).toLocaleString()}/${out.length.toLocaleString()}…`);
      const { error } = await sb.from("tcgp_catalog").upsert(out.slice(i, i + 500), { onConflict: "sku_id" });
      if (error) { setStatus("Catalog upload failed: " + error.message); return; }
    }
    total += out.length;
  }
  toast(`Catalog updated — ${total.toLocaleString()} rows`);
  renderAll();
}

async function updatePrices() {
  if (DEMO) { toast("Demo mode — sign in to refresh prices"); return; }
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return;
  const targets = rows.filter((r) => r.bucket === "pkmn" && !r.keep && r.price >= 10).sort((a, b) => b.price - a.price);
  if (!targets.length) { toast("No Pokemon cards ≥ $10 to update."); return; }
  if (!confirm(`Fetch real market + PSA prices for ${targets.length} Pokemon cards ($10+)?`)) return;
  let done = 0, hit = 0, failed = 0, skipped = 0, notConfigured = false;
  const hist = [];
  const queue = [...targets];
  const worker = async () => {
    while (queue.length && !notConfigured) {
      const r = queue.shift();
      try {
        const bare = r.name.replace(/\s*\([^)]*\)/g, "").split(" - ")[0].trim();
        const num = (r.number || "").split("/")[0].replace(/^0+(?=\d)/, "");
        // Include the SET — a name+number-only query fuzzy-matches the wrong
        // card/rarity (a common "Dragonite 18" hit a pricey variant).
        const q = `pokemon ${r.set_name} ${bare} ${num}`.replace(/\s+/g, " ").trim();
        const resp = await fetch(FN_PRICES, {
          method: "POST",
          headers: { "Content-Type": "application/json", "apikey": SUPABASE_ANON, "Authorization": "Bearer " + session.access_token },
          body: JSON.stringify({ q }),
        });
        if (resp.status === 503) { notConfigured = true; break; }
        if (resp.ok) {
          const d = await resp.json();
          // Sanity gate: reject a match whose loose price is wildly off the
          // current baseline — that's almost always a wrong product/rarity.
          const anchor = r.market_price || r.price || 0;
          const looseOk = d.loose > 0 && (!anchor || (d.loose >= anchor * 0.2 && d.loose <= anchor * 5));
          if (!looseOk && !(d.psa10 > 0 || d.psa9 > 0)) { skipped++; done++; continue; }
          const patch = looseOk ? derivePricePatch(r, { market: d.loose, realPsa10: d.psa10 || 0 })
                                : derivePricePatch(r, { realPsa10: d.psa10 || 0 });
          patch.psa9 = d.psa9 || 0;
          patch.psa10 = d.psa10 || 0;
          patch.psa10_real = !!(d.psa10 > 0 || d.psa9 > 0);
          await save(r, patch);
          hist.push({ natural_key: r.natural_key, price: r.price, psa10: r.psa10 || 0 });
          hit++;
        } else failed++;
      } catch (e) { failed++; }
      done++;
      if (done % 5 === 0 || done === targets.length) setStatus(`Refreshing prices… ${done}/${targets.length}`);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  for (let i = 0; i < hist.length; i += 500) await sb.from("price_history").insert(hist.slice(i, i + 500));
  if (notConfigured) toast("Real prices need the PriceCharting key configured server-side.");
  else toast(`Refreshed ${hit}${skipped ? ` · ${skipped} skipped (price mismatch)` : ""}${failed ? ` · ${failed} no match` : ""}`, null, 6000);
  renderAll();
}

async function deleteInventory() {
  if (DEMO) { toast("Demo mode"); return; }
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return;
  if (!confirm(`Delete all ${rows.length} cards? Photos and price history stay, and re-importing restores your piles.`)) return;
  if (!confirm("Last check — delete everything?")) return;
  const { error } = await sb.from("cards").delete().eq("user_id", user.id);
  if (error) { toast("Delete failed: " + error.message); return; }
  toast("Inventory cleared");
  load();
}

// ── Keyboard layer (desktop, Decide table): j/k move · 1–5 file · Enter open ─
const FILE_KEYS = { "1": "sell", "2": "keep", "3": "grade", "4": "check" };
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeCard(); return; }
  if (e.key === "u" && $("#toast-undo")) { $("#toast-undo").click(); return; }
  if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
  if (!$("#card-modal").classList.contains("hidden")) {   // modal layer owns the keys
    if (e.key === "ArrowRight") modalStep(1);
    else if (e.key === "ArrowLeft") modalStep(-1);
    else if (FILE_KEYS[e.key]) document.querySelector(`.m-decide [data-file="${FILE_KEYS[e.key]}"]`)?.click();
    return;
  }
  if (window.innerWidth < 960 || station !== "decide") return;
  const trows = document.querySelectorAll("table.positions tbody tr");
  if (!trows.length) return;
  if (e.key === "j" || e.key === "k") {
    kfocus = e.key === "j" ? Math.min(kfocus + 1, trows.length - 1) : Math.max(kfocus - 1, 0);
    trows.forEach((tr, i) => tr.classList.toggle("kfocus", i === kfocus));
    trows[kfocus]?.scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter" && kfocus >= 0) {
    trows[kfocus].click();
  } else if (FILE_KEYS[e.key] && kfocus >= 0) {
    trows[kfocus].querySelector(`[data-file="${FILE_KEYS[e.key]}"]`)?.click();
  }
});

// ── Auth + boot ──────────────────────────────────────────────────────────────
function showAuth() { $("#auth-section").classList.remove("hidden"); $("#app-main").classList.add("hidden"); }
function showApp() {
  $("#auth-section").classList.add("hidden"); $("#app-main").classList.remove("hidden");
  if (DEMO) $("#demo-note").classList.remove("hidden");
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

// Header / menu wiring
$("#data-btn").addEventListener("click", (e) => { e.stopPropagation(); $("#data-menu").classList.toggle("hidden"); });
document.addEventListener("click", (e) => { if (!e.target.closest(".menu-wrap")) $("#data-menu").classList.add("hidden"); });
$("#import-btn").addEventListener("click", () => $("#import-file").click());
$("#import-file").addEventListener("change", () => { const f = $("#import-file").files[0]; if (f) importCsv(f); $("#import-file").value = ""; });
$("#catalog-btn").addEventListener("click", () => $("#catalog-file").click());
$("#scan-btn")?.addEventListener("click", openScanner);
$("#catalog-file").addEventListener("change", () => { const fs = [...$("#catalog-file").files]; if (fs.length) catalogUpload(fs); $("#catalog-file").value = ""; });
$("#prices-btn").addEventListener("click", updatePrices);
$("#delete-btn").addEventListener("click", deleteInventory);
$("#signout-btn").addEventListener("click", () => sb.auth.signOut());
$("#signin-btn").addEventListener("click", signIn);
$("#signup-btn").addEventListener("click", signUp);
$("#auth-pass").addEventListener("keydown", (e) => { if (e.key === "Enter") signIn(); });
$("#modal-backdrop").addEventListener("click", closeCard);
window.addEventListener("hashchange", applyHash);
// Re-render when the window crosses the table-mode breakpoint (CSS handles the rest).
let wasDesktop = window.innerWidth >= 960;
window.addEventListener("resize", () => {
  const isDesktop = window.innerWidth >= 960;
  if (isDesktop !== wasDesktop) { wasDesktop = isDesktop; renderAll(); }
});

(async () => {
  const last = localStorage.getItem("lastRoute");
  if (!location.hash && last) history.replaceState(null, "", last);
  const h = location.hash.replace(/^#\//, "").split("/");
  if (h[0] === "browse") {   // legacy v5 bookmarks
    station = "decide";
    pileKey = ["graded", "sealed"].includes(h[1]) ? h[1] : "all";
  } else {
    station = ["decide", "prep", "cashout"].includes(h[0]) ? h[0] : "decide";
    if (station === "decide" && h[1]) pileKey = PILES.some(([k]) => k === h[1]) ? h[1] : "undecided";
  }
  if (DEMO) { showApp(); return; }
  // React only when signed-in/out actually flips — INITIAL_SESSION, SIGNED_IN
  // on tab focus, and TOKEN_REFRESHED all re-fire with the same presence.
  let authed = null;
  const onAuth = (s) => {
    const has = !!s;
    if (has === authed) return;
    authed = has;
    if (has) showApp(); else showAuth();
  };
  const { data: { session } } = await sb.auth.getSession();
  onAuth(session);
  sb.auth.onAuthStateChange((_e, s) => onAuth(s));
})();
