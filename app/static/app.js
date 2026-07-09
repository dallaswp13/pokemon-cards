// TCGP Inventory Matcher — frontend (steps 3 + 4)

const $ = (id) => document.getElementById(id);

const dropzone     = $("dropzone");
const fileInput    = $("file-input");
const pickBtn      = $("pick-btn");
const rerunBtn     = $("rerun-btn");
const uploadStatus = $("upload-status");

const summarySec   = $("summary-section");
const summaryStats = $("summary-stats");
const summaryMeta  = $("summary-meta");
const openLinkBtn      = $("open-link-btn");
const openSheetBtn     = $("open-sheet-btn");
const openUnmatchedBtn = $("open-unmatched-btn");
const filterSelect     = $("filter-select");
const reviewTitle      = $("review-title");

const sheetSec    = $("sheet-section");
const sheetBody   = $("sheet-body");
const sheetMeta   = $("sheet-meta");
const sheetSearch = $("sheet-search");
const sheetAttrFilter = $("sheet-attr-filter");
const sheetBackBtn = $("sheet-back-btn");
const sheetTable  = $("sheet-table");

const reviewSec    = $("review-section");
const reviewEmpty  = $("review-empty");
const reviewBody   = $("review-body");
const reviewProgress = $("review-progress");
const heroImg      = $("hero-img");
const heroCaption  = $("hero-caption");
const invData      = $("inv-data");
const reviewReason = $("review-reason");
const decisionBadge = $("decision-badge");
const candidatesEl = $("candidates");
const prevBtn      = $("prev-btn");
const nextBtn      = $("next-btn");
const backBtn      = $("back-btn");

const nextSteps    = $("next-steps");
const exportBtn    = $("export-btn");
const exportResult = $("export-result");

// ── Image URL helpers ──────────────────────────────────────────────────────

function tcgpImageUrl(tid, size = 400) {
  // Proxied through our Flask server: tries TCGP CDN, falls back to
  // Scryfall (MTG) or Pokemon TCG API (Pokemon), caches to disk.
  return `/api/image/${tid}?size=${size}`;
}

// ── State ──────────────────────────────────────────────────────────────────

const state = {
  reviewRows: [],     // [{row_idx, inventory, candidates, decision, ...}]
  pos: 0,             // current index into reviewRows
  selected: 0,        // currently-highlighted candidate index
  filter: "review",   // 'review' | 'unmatched'
  // Spreadsheet
  sheetRows: [],
  sheetSort: { col: "inv_set", dir: "asc" },
};

const FILTER_TITLES = {
  review:    "Linking — needs review",
  unmatched: "Unmatched — find a match",
};

// ── Upload wiring ──────────────────────────────────────────────────────────

pickBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (e) => {
  if (e.target.files.length) runMatch(e.target.files[0]);
});
rerunBtn.addEventListener("click", () => runMatch(null));

dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("drag");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("drag");
  const f = e.dataTransfer.files[0];
  if (f) runMatch(f);
});

// ── Match flow ─────────────────────────────────────────────────────────────

async function runMatch(file) {
  setStatus("Running matcher…", "");
  let body = null;
  if (file) {
    body = new FormData();
    body.append("export", file);
  }
  try {
    const res = await fetch("/api/match", { method: "POST", body });
    const data = await res.json();
    if (!res.ok) {
      setStatus(data.error || "Match failed", "error");
      return;
    }
    setStatus(
      `Matched in ${data.elapsed_seconds}s — session ${data.session}`,
      "success"
    );
    renderSummary(data.stats);
  } catch (err) {
    setStatus(`Network error: ${err.message}`, "error");
  }
}

openLinkBtn.addEventListener("click",      () => openReview("review"));
openUnmatchedBtn.addEventListener("click", () => openReview("unmatched"));
openSheetBtn.addEventListener("click",     () => openSheet());
sheetBackBtn.addEventListener("click", () => {
  sheetSec.classList.add("hidden");
  summarySec.scrollIntoView({ behavior: "smooth" });
});

filterSelect.addEventListener("change", () => openReview(filterSelect.value));

backBtn.addEventListener("click", () => {
  reviewSec.classList.add("hidden");
  summarySec.scrollIntoView({ behavior: "smooth" });
  document.removeEventListener("keydown", handleKey);
});

prevBtn.addEventListener("click", () => navigate(-1));
nextBtn.addEventListener("click", () => navigate(+1));

// Toolbar buttons
document.querySelectorAll(".toolbar [data-action]").forEach((btn) => {
  btn.addEventListener("click", () => doAction(btn.dataset.action));
});

// Export
exportBtn.addEventListener("click", async () => {
  exportBtn.disabled = true;
  exportResult.textContent = "Writing…";
  try {
    const res = await fetch("/api/export", { method: "POST" });
    const data = await res.json();
    if (!res.ok) {
      exportResult.textContent = data.error || "Export failed";
      return;
    }
    const lines = [
      `Pokemon  : ${data.pokemon.rows} rows, qty=${data.pokemon.quantity}, filled prices=${data.pokemon.filled_prices}`,
      `           → ${data.pokemon.path}`,
      `MTG      : ${data.mtg.rows} rows, qty=${data.mtg.quantity}, filled prices=${data.mtg.filled_prices}`,
      `           → ${data.mtg.path}`,
      `Set-aside: ${data.set_aside.rows} rows, value=$${data.set_aside.value.toFixed(2)}`,
      `           → ${data.set_aside.path}`,
      `Unmatched: ${data.unmatched.rows} rows`,
      `           → ${data.unmatched.path}`,
    ];
    exportResult.textContent = lines.join("\n");
  } catch (err) {
    exportResult.textContent = `Network error: ${err.message}`;
  } finally {
    exportBtn.disabled = false;
  }
});

// ── Review queue ───────────────────────────────────────────────────────────

async function openReview(filter = "review") {
  state.filter = filter;
  if (filterSelect.value !== filter) filterSelect.value = filter;
  reviewTitle.textContent = FILTER_TITLES[filter] || "Review";

  const res = await fetch(`/api/review?filter=${encodeURIComponent(filter)}`);
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || "Failed to load review queue");
    return;
  }
  state.reviewRows = data.rows;
  // For 'review' filter, jump to first undecided. For 'auto'/'all', start at 0.
  state.pos = (filter === "review") ? firstUndecidedPos() : 0;
  reviewSec.classList.remove("hidden");
  reviewSec.scrollIntoView({ behavior: "smooth" });
  if (state.reviewRows.length === 0) {
    reviewEmpty.classList.remove("hidden");
    reviewBody.classList.add("hidden");
    document.removeEventListener("keydown", handleKey);
    return;
  }
  reviewEmpty.classList.add("hidden");
  reviewBody.classList.remove("hidden");
  renderReview();
  // Detach any prior keydown listener before re-attaching, so opening review
  // a second time doesn't double-fire actions.
  document.removeEventListener("keydown", handleKey);
  document.addEventListener("keydown", handleKey);
}

function firstUndecidedPos() {
  const i = state.reviewRows.findIndex((r) => !r.decision?.link_kind);
  return i === -1 ? 0 : i;
}

function renderReview() {
  if (state.reviewRows.length === 0) return;
  const row = state.reviewRows[state.pos];

  // Progress
  const decided = state.reviewRows.filter((r) => r.decision?.link_kind).length;
  reviewProgress.textContent =
    `${decided} of ${state.reviewRows.length} linked · viewing row ${state.pos + 1} of ${state.reviewRows.length}`;

  // Inventory panel
  const inv = row.inventory;
  invData.innerHTML = "";
  const fields = [
    ["Category",      inv.category],
    ["Set",           inv.set_name],
    ["Card",          inv.product_name],
    ["Number",        inv.card_number],
    ["Variance",      inv.variance],
    ["Quantity",      inv.quantity],
    ["Market price",  `$${(inv.market_price || 0).toFixed(2)}`],
  ];
  for (const [k, v] of fields) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v ?? "—";
    invData.append(dt, dd);
  }
  reviewReason.textContent = row.reason ? `Why review: ${row.reason}` : "";

  // Linking decision badge — linking only cares about link_kind
  const lk = row.decision?.link_kind;
  if (lk === "confirm") {
    decisionBadge.className = "decision-badge confirm";
    decisionBadge.textContent = "Linked";
    decisionBadge.classList.remove("hidden");
  } else if (lk === "skip") {
    decisionBadge.className = "decision-badge skip";
    decisionBadge.textContent = "No match";
    decisionBadge.classList.remove("hidden");
  } else {
    decisionBadge.classList.add("hidden");
  }

  // Candidates
  candidatesEl.innerHTML = "";
  // Pre-select previously-confirmed candidate if any, else 0
  state.selected = 0;
  if (row.decision?.link_kind === "confirm" && row.decision.tcgplayer_id) {
    const idx = row.candidates.findIndex(
      (c) => c.tcgplayer_id === row.decision.tcgplayer_id
    );
    if (idx >= 0) state.selected = idx;
  }
  row.candidates.forEach((c, i) => {
    const el = document.createElement("div");
    el.className = "candidate" + (i === state.selected ? " selected" : "");
    el.dataset.idx = String(i);
    el.dataset.tid = c.tcgplayer_id;
    el.innerHTML = `
      <img loading="lazy" src="${tcgpImageUrl(c.tcgplayer_id, 400)}"
           onerror="this.style.opacity=0.2"/>
      ${i < 9 ? `<span class="candidate-key">${i + 1}</span>` : ""}
      <div class="candidate-meta">
        <div class="pname">${escapeHtml(c.product_name)}</div>
        <div class="sub">${escapeHtml(c.set_name)} · #${escapeHtml(c.number)}</div>
        <div class="sub">${escapeHtml(c.condition)}</div>
      </div>`;
    el.addEventListener("click", () => selectCandidate(i));
    el.addEventListener("dblclick", () => doAction("confirm"));
    candidatesEl.append(el);
  });

  updateHero();
  prefetchAdjacent();
  setReviewStatus("");
}

function setReviewStatus(msg, kind = "") {
  // Lazy-create the status element if missing
  let el = document.getElementById("review-status");
  if (!el) {
    el = document.createElement("p");
    el.id = "review-status";
    el.className = "review-status";
    document.querySelector(".toolbar").after(el);
  }
  el.textContent = msg;
  el.className = "review-status" + (kind ? " " + kind : "");
}

function selectCandidate(i) {
  state.selected = i;
  candidatesEl.querySelectorAll(".candidate").forEach((el, idx) => {
    el.classList.toggle("selected", idx === i);
  });
  updateHero();
}

function updateHero() {
  const row = state.reviewRows[state.pos];
  if (!row || !row.candidates.length) {
    heroImg.src = "";
    heroCaption.textContent = "";
    return;
  }
  const c = row.candidates[state.selected];
  heroImg.src = tcgpImageUrl(c.tcgplayer_id, 1000);
  heroImg.alt = c.product_name;
  heroCaption.textContent = `${c.product_name} — ${c.set_name} #${c.number} (${c.condition})`;
}

function prefetchAdjacent() {
  // Prefetch hero images for the next 2 rows
  for (let n = 1; n <= 2; n++) {
    const next = state.reviewRows[state.pos + n];
    if (!next || !next.candidates.length) continue;
    const c = next.candidates[0];
    const img = new Image();
    img.src = tcgpImageUrl(c.tcgplayer_id, 1000);
  }
}

function navigate(delta) {
  const n = state.reviewRows.length;
  state.pos = (state.pos + delta + n) % n;
  renderReview();
}

// ── Decisions ──────────────────────────────────────────────────────────────

let actionInFlight = false;

async function doAction(kind) {
  if (actionInFlight) return;          // prevent double-fire from key + click
  const row = state.reviewRows[state.pos];
  if (!row) return;

  // Read the *currently rendered selected candidate* directly from DOM,
  // not just state.selected — defensive against any stale state.
  const selectedEl = candidatesEl.querySelector(".candidate.selected");
  const selectedTid = selectedEl?.dataset.tid;

  // Build a /api/decide POST body. Linking actions only patch `link`;
  // attributes are managed from the spreadsheet view.
  let body;
  if (kind === "undecide") {
    body = { row_idx: row.row_idx, link: null };
  } else if (kind === "confirm") {
    if (!selectedTid) {
      setReviewStatus("No candidate selected.", "error");
      return;
    }
    body = { row_idx: row.row_idx, link: "confirm", tcgplayer_id: selectedTid };
  } else if (kind === "skip") {
    body = { row_idx: row.row_idx, link: "skip" };
  } else {
    setReviewStatus(`Unknown action '${kind}'`, "error");
    return;
  }

  actionInFlight = true;
  setReviewStatus(
    kind === "confirm" ? `Confirming candidate ${state.selected + 1}…`
    : kind === "skip"  ? "Recording: no match…"
    :                    "Clearing…"
  );

  let res;
  try {
    res = await fetch("/api/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    setReviewStatus(`Network error: ${err.message}`, "error");
    actionInFlight = false;
    return;
  }

  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    setReviewStatus(`Server: ${e.error || `HTTP ${res.status}`}`, "error");
    actionInFlight = false;
    return;
  }

  // Reflect server state on the local row
  if (kind === "undecide") {
    row.decision = null;
  } else if (kind === "confirm") {
    row.decision = { ...(row.decision || {}), link_kind: "confirm", tcgplayer_id: body.tcgplayer_id };
  } else if (kind === "skip") {
    row.decision = { ...(row.decision || {}), link_kind: "skip", tcgplayer_id: null };
  }

  // Auto-advance: jump to next undecided
  if (kind !== "undecide") {
    const next = nextUndecidedPosFrom(state.pos);
    if (next !== -1) state.pos = next;
  }
  renderReview();
  setReviewStatus(
    kind === "confirm"  ? `Confirmed (id ${selectedTid}). Moved to next.`
    : kind === "skip"   ? "Marked as no match. Moved to next."
    :                     "Cleared.",
    "success"
  );
  actionInFlight = false;
}

function nextUndecidedPosFrom(start) {
  const n = state.reviewRows.length;
  for (let off = 1; off <= n; off++) {
    const i = (start + off) % n;
    if (!state.reviewRows[i].decision?.link_kind) return i;
  }
  return -1;
}

// ── Keyboard ───────────────────────────────────────────────────────────────

function handleKey(e) {
  if (reviewSec.classList.contains("hidden")) return;
  if (e.target.matches("input, textarea")) return;
  const k = e.key;
  if (/^[1-9]$/.test(k)) {
    const i = parseInt(k, 10) - 1;
    const row = state.reviewRows[state.pos];
    if (row && i < row.candidates.length) {
      e.preventDefault();
      selectCandidate(i);
    }
  } else if (k === "Enter") {
    e.preventDefault();
    doAction("confirm");
  } else if (k === "s" || k === "S") {
    e.preventDefault();
    doAction("skip");          // "no match" in linking
  } else if (k === "ArrowLeft") {
    e.preventDefault();
    navigate(-1);
  } else if (k === "ArrowRight") {
    e.preventDefault();
    navigate(+1);
  }
}

// ── Rendering helpers ──────────────────────────────────────────────────────

function setStatus(msg, kind) {
  uploadStatus.textContent = msg;
  uploadStatus.className = "status" + (kind ? " " + kind : "");
}

function renderSummary(stats) {
  const total = stats.total_singles || 1;
  const pct = (n) => ((n / total) * 100).toFixed(1) + "%";

  summaryStats.innerHTML = "";
  const make = (cls, label, value, sub) => {
    const div = document.createElement("div");
    div.className = "stat " + cls;
    div.innerHTML = `<div class="label">${label}</div>
                     <div class="value">${value}</div>
                     <div class="pct">${sub || ""}</div>`;
    return div;
  };

  summaryStats.append(
    make("",          "Singles",        stats.total_singles, ""),
    make("auto",      "Auto-matched",   stats.auto_matched,  pct(stats.auto_matched)),
    make("review",    "Review queue",   stats.review,        pct(stats.review)),
    make("unmatched", "Unmatched",      stats.unmatched,     pct(stats.unmatched)),
    make("",          "Sealed",         stats.sealed,        "set aside"),
    make("",          "Graded",         stats.graded,        "set aside"),
    make("",          "Filtered out",   stats.filtered_out,  "other categories"),
  );

  const cats = stats.category_counts || {};
  const catSummary = Object.entries(cats)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}: ${v}`)
    .join("  ·  ");
  summaryMeta.textContent = `Source breakdown — ${catSummary}`;

  summarySec.classList.remove("hidden");
  nextSteps.classList.remove("hidden");

  openLinkBtn.disabled      = stats.review === 0;
  openLinkBtn.textContent   = `1. Linking — needs review (${stats.review})`;
  openUnmatchedBtn.disabled    = stats.unmatched === 0;
  openUnmatchedBtn.textContent = `Unmatched (${stats.unmatched})`;
  openSheetBtn.disabled    = stats.auto_matched === 0;
  openSheetBtn.textContent = `2. Reviewing — matched cards (${stats.auto_matched})`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;",
    '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ── Spreadsheet view (matched cards) ───────────────────────────────────────

async function openSheet() {
  const res = await fetch("/api/matched");
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || "Failed to load matched rows");
    return;
  }
  state.sheetRows = data.rows;
  sheetSec.classList.remove("hidden");
  sheetSec.scrollIntoView({ behavior: "smooth" });
  renderSheet();
}

sheetSearch?.addEventListener("input", () => renderSheet());
sheetAttrFilter?.addEventListener("change", () => renderSheet());

// Sortable column headers
sheetTable.querySelectorAll("thead th[data-sort]").forEach((th) => {
  th.addEventListener("click", () => {
    const col = th.dataset.sort;
    if (state.sheetSort.col === col) {
      state.sheetSort.dir = state.sheetSort.dir === "asc" ? "desc" : "asc";
    } else {
      state.sheetSort = { col, dir: "asc" };
    }
    renderSheet();
  });
});

function renderSheet() {
  const q = (sheetSearch?.value || "").toLowerCase().trim();
  const af = sheetAttrFilter?.value || "";

  let rows = state.sheetRows.slice();
  if (q) {
    rows = rows.filter((r) =>
      (r.inv_name || "").toLowerCase().includes(q) ||
      (r.inv_set || "").toLowerCase().includes(q) ||
      (r.matched_name || "").toLowerCase().includes(q) ||
      (r.matched_set || "").toLowerCase().includes(q) ||
      String(r.inv_number || "").toLowerCase().includes(q)
    );
  }
  if (af) rows = rows.filter((r) => (r.attribute || "for_sale") === af);

  // Sort
  const { col, dir } = state.sheetSort;
  const sortKey = (r) => {
    switch (col) {
      case "inv_name":     return (r.inv_name || "").toLowerCase();
      case "set":          return (r.inv_set || "").toLowerCase();
      case "number":       return (r.inv_number || "");
      case "variance":     return (r.variance || "");
      case "qty":          return r.quantity || 0;
      case "price":        return r.market_price || 0;
      case "matched_name": return (r.matched_name || "").toLowerCase();
      case "matched_cond": return (r.condition || "");
      case "attribute":    return (r.attribute || "for_sale");
      default:             return "";
    }
  };
  rows.sort((a, b) => {
    const av = sortKey(a), bv = sortKey(b);
    if (av < bv) return dir === "asc" ? -1 : 1;
    if (av > bv) return dir === "asc" ?  1 : -1;
    return 0;
  });

  // Update sort indicators in headers
  sheetTable.querySelectorAll("thead th[data-sort]").forEach((th) => {
    const ind = th.querySelector(".sort-indicator");
    if (!ind) return;
    ind.textContent = th.dataset.sort === col
      ? (dir === "asc" ? "▲" : "▼")
      : "";
  });

  sheetMeta.textContent =
    `${rows.length.toLocaleString()} of ${state.sheetRows.length.toLocaleString()} matched rows` +
    (q || af ? " (filtered)" : "");

  // Render rows
  sheetBody.innerHTML = "";
  if (rows.length === 0) {
    document.getElementById("sheet-empty").classList.remove("hidden");
    return;
  }
  document.getElementById("sheet-empty").classList.add("hidden");

  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.dataset.rowIdx = r.row_idx;
    tr.innerHTML = `
      <td class="col-img"><img loading="lazy"
           src="/api/image/${r.tcgplayer_id}?size=200"
           alt="" onerror="this.style.opacity=0.2"/></td>
      <td>${escapeHtml(r.inv_name)}</td>
      <td>${escapeHtml(r.inv_set)}</td>
      <td>${escapeHtml(r.inv_number || "")}</td>
      <td>${escapeHtml(r.variance || "")}</td>
      <td class="qty">${r.quantity}</td>
      <td class="price">${r.market_price ? "$" + r.market_price.toFixed(2) : "—"}</td>
      <td>${escapeHtml(r.matched_name)}</td>
      <td>${escapeHtml(r.condition || "")}</td>
      <td class="attr ${r.attribute === "for_sale" ? "" : r.attribute}">
        <select data-row-idx="${r.row_idx}">
          <option value="for_sale" ${r.attribute === "for_sale" ? "selected" : ""}>For sale</option>
          <option value="personal" ${r.attribute === "personal" ? "selected" : ""}>Personal</option>
          <option value="psa"      ${r.attribute === "psa"      ? "selected" : ""}>PSA</option>
          <option value="bad"      ${r.attribute === "bad"      ? "selected" : ""}>Bad</option>
          <option value="ignore"   ${r.attribute === "ignore"   ? "selected" : ""}>Ignore</option>
        </select>
      </td>
    `;
    frag.appendChild(tr);
  }
  sheetBody.appendChild(frag);

  // Wire up attribute selects
  sheetBody.querySelectorAll("select[data-row-idx]").forEach((sel) => {
    sel.addEventListener("change", async (e) => {
      const rowIdx = parseInt(sel.dataset.rowIdx, 10);
      const value = sel.value;
      const r = state.sheetRows.find((x) => x.row_idx === rowIdx);
      try {
        const res = await fetch("/api/decide", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ row_idx: rowIdx, attribute: value }),
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        if (r) r.attribute = value;
        // Update color class on the cell
        const td = sel.closest("td");
        td.className = "attr" + (value === "for_sale" ? "" : " " + value);
      } catch (err) {
        alert("Failed to update: " + err.message);
        // revert
        if (r) sel.value = r.attribute;
      }
    });
  });

  // Image lightbox on thumbnail click
  sheetBody.querySelectorAll(".col-img img").forEach((img) => {
    img.addEventListener("click", () => {
      const big = document.createElement("div");
      big.className = "lightbox";
      big.innerHTML = `<img src="${img.src.replace("size=400", "size=1000")}" alt=""/>`;
      big.addEventListener("click", () => big.remove());
      document.body.appendChild(big);
    });
  });
}

// ── On load: resume existing session if any ──────────────────────────────

(async () => {
  try {
    const res = await fetch("/api/state");
    const data = await res.json();
    // The Sell Cockpit is the primary view (sell.js auto-opens it). Don't reveal
    // the matcher summary on load — it renders when you open Matcher tools and
    // run/re-run a match.
    if (data.session) setStatus(`Session ${data.session} ready`, "");
  } catch {}
})();
