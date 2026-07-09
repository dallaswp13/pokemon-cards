/* Sell Cockpit — visual liquidation board over /api/sell. Independent of app.js. */
(function () {
  const $ = (s) => document.querySelector(s);
  const RENDER_CAP = 300;

  const CHANNEL_CLASS = {
    "eBay (auction)": "ch-ebay-auction",
    "eBay (fixed)": "ch-ebay-fixed",
    "TCGplayer": "ch-tcg",
    "Bulk lot": "ch-bulk",
  };
  const SORTS = {
    value: (a, b) => b.price - a.price,
    netpct: (a, b) => b.net_pct - a.net_pct,
    sellnow: (a, b) => b.sell_now - a.sell_now,
    gradegap: (a, b) => b.grade_gap - a.grade_gap,
  };

  let rows = [];
  let summary = null;
  const filters = { channel: "", band: "", keep: "", grade: "", tag: "", search: "" };
  let sortKey = "value";

  function allSections() { return document.querySelectorAll("main > section.card"); }
  function openSell() {
    allSections().forEach((s) => s.classList.add("hidden"));
    $("#sell-section").classList.remove("hidden");
    load();
  }
  function backToSummary() {
    $("#sell-section").classList.add("hidden");
    $("#summary-section").classList.remove("hidden");
  }

  async function load() {
    $("#sell-meta").textContent = "Loading…";
    let d;
    try {
      let r = await fetch("/api/sell");
      if (r.status === 400) {
        // No match session yet — run one against inputs/export.csv, then retry.
        $("#sell-meta").textContent = "Preparing your inventory (matching export)…";
        const m = await fetch("/api/match", { method: "POST" });
        if (!m.ok) {
          const err = await m.json().catch(() => ({}));
          $("#sell-meta").textContent = "Couldn't match: " + (err.error || "is inputs/export.csv present?");
          return;
        }
        r = await fetch("/api/sell");
      }
      if (!r.ok) { $("#sell-meta").textContent = "Error loading."; return; }
      d = await r.json();
    } catch (e) { $("#sell-meta").textContent = "Error loading."; return; }
    rows = d.rows || [];
    summary = d.summary || null;
    renderSummary();
    render();
  }

  const money = (n) => "$" + Math.round(n).toLocaleString();

  function renderSummary() {
    const bar = $("#sell-summary");
    if (!summary) { bar.innerHTML = ""; return; }
    const s = summary;
    const tiers = ["HIGH", "MID", "LOW", "BULK"].map((t) => {
      const v = s.by_tier[t] || { pct: 0, market: 0 };
      return `<span class="sum-tier"><b>${t}</b> ${Math.round(v.pct * 100)}% <span class="dim">of ${money(v.market)}</span></span>`;
    }).join("");
    bar.innerHTML = `
      <div class="sum-head">
        <div><span class="sum-pct">${Math.round(s.pct * 100)}%</span> recovered
          <span class="dim">· net ${money(s.net)} of ${money(s.market)} market · ${Math.round(s.pct_excl_bulk * 100)}% excl. bulk tail</span></div>
      </div>
      <div class="sum-tiers">${tiers}</div>
      <div class="sum-notes">
        <span class="sum-note grade">◆ ${s.grade_candidates} grade-first (~+${money(s.grade_extra)})</span>
        <span class="sum-note">consignment: ${s.consign_eligible} eligible</span>
        <span class="sum-note">★ ${s.keepers} keepers (${money(s.keepers_value)})</span>
      </div>`;
  }

  function passes(row) {
    if (filters.channel && row.channel !== filters.channel) return false;
    if (filters.band && row.band !== filters.band) return false;
    if (filters.keep === "keep" && !row.keep) return false;
    if (filters.keep === "sell" && row.keep) return false;
    if (filters.grade === "grade" && !row.grade_flag) return false;
    if (filters.tag && !(row.tags || []).some((x) => x.includes(filters.tag.toLowerCase()))) return false;
    if (filters.search) {
      const q = filters.search.toLowerCase();
      if (!((row.name || "") + " " + (row.set || "")).toLowerCase().includes(q)) return false;
    }
    return true;
  }

  function render() {
    const shown = rows.filter(passes).sort(SORTS[sortKey] || SORTS.value);
    const val = shown.reduce((a, r) => a + r.price * r.qty, 0);
    const net = shown.reduce((a, r) => a + r.net_total, 0);
    const capped = shown.length > RENDER_CAP;
    $("#sell-meta").textContent =
      `${shown.length} of ${rows.length} · ${money(val)} market → ${money(net)} net` +
      (capped ? ` · showing first ${RENDER_CAP}` : "");
    $("#sell-empty").classList.toggle("hidden", shown.length > 0);
    const grid = $("#sell-grid");
    grid.innerHTML = "";
    const frag = document.createDocumentFragment();
    shown.slice(0, RENDER_CAP).forEach((r) => frag.appendChild(tile(r)));
    grid.appendChild(frag);
  }

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  function flagChip(f) {
    if (f.startsWith("tcgp-tracking")) return `<span class="flag warn" title="TCGplayer requires tracking on $50+ — routed to eBay">📦 $50+</span>`;
    if (f.startsWith("ebay-authenticity")) return `<span class="flag lock" title="eBay authenticates cards $250+ (free, +few days)">🔒 $250+</span>`;
    if (f === "scarce") return `<span class="flag scarce" title="Scarce/chase — auction realizes above market">✦ scarce</span>`;
    return `<span class="flag">${esc(f)}</span>`;
  }

  function tile(row) {
    const el = document.createElement("div");
    el.className = "sell-tile" + (row.keep ? " is-keep" : "");
    const img = row.tcgplayer_id
      ? `<img loading="lazy" src="/api/image/${row.tcgplayer_id}?size=200" onerror="this.classList.add('broken')">`
      : `<div class="noimg">no image</div>`;
    const flags = (row.flags || []).map(flagChip).join("");
    const gradeBadge = row.grade_flag
      ? `<span class="flag grade" title="${esc(row.grade_reason)}">◆ grade +${money(row.grade_gap)}</span>` : "";
    const tags = (row.tags || []).map((t) =>
      `<span class="tag">${esc(t)}<button class="tag-x" data-act="untag" data-tag="${esc(t)}">×</button></span>`).join("");
    el.innerHTML = `
      <div class="tile-img">${img}
        <button class="keep-star" data-act="keep" title="Keep for personal collection">${row.keep ? "★" : "☆"}</button>
      </div>
      <div class="tile-body">
        <div class="tile-name" title="${esc(row.name)}">${esc(row.name)}</div>
        <div class="tile-sub">${esc(row.set)} · #${esc(row.number) || "—"}</div>
        <div class="tile-row">
          <span class="price">$${row.price.toFixed(2)}${row.qty > 1 ? ` ×${row.qty}` : ""}</span>
          <span class="badge ${CHANNEL_CLASS[row.channel] || ""}" title="${esc(row.channel_reason)}">${esc(row.channel)}</span>
        </div>
        <div class="tile-net">net $${row.net_unit.toFixed(0)} · <b>${Math.round(row.net_pct * 100)}%</b> back</div>
        <div class="tile-flags">${gradeBadge}${flags}</div>
        <div class="tile-tags">${tags}<button class="add-tag" data-act="addtag">+ tag</button></div>
      </div>`;
    el.addEventListener("click", (ev) => onClick(ev, row, el));
    return el;
  }

  async function patch(row, body) {
    try {
      await fetch("/api/tag", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ row_idx: row.row_idx, ...body }) });
    } catch (e) { /* UI already updated */ }
  }

  async function onClick(ev, row, el) {
    const act = ev.target.dataset && ev.target.dataset.act;
    if (!act) return;
    ev.stopPropagation();
    if (act === "keep") {
      row.keep = !row.keep;
      el.classList.toggle("is-keep", row.keep);
      ev.target.textContent = row.keep ? "★" : "☆";
      await patch(row, { keep: row.keep });
      load();  // recompute recovery summary (keepers leave the sell pool)
    } else if (act === "addtag") {
      const t = prompt("Add tag (e.g. under-1, sell-later, graded-me):");
      if (t && t.trim()) {
        row.tags = Array.from(new Set([...(row.tags || []), t.trim().toLowerCase()]));
        patch(row, { tags: row.tags });
        render();
      }
    } else if (act === "untag") {
      row.tags = (row.tags || []).filter((x) => x !== ev.target.dataset.tag);
      patch(row, { tags: row.tags });
      render();
    }
  }

  function wire() {
    ["#open-sell-btn", "#open-sell-btn-landing"].forEach((sel) => {
      const b = $(sel); if (b) b.addEventListener("click", openSell);
    });
    const back = $("#sell-back-btn"); if (back) back.addEventListener("click", backToSummary);
    document.querySelectorAll("#sell-filters .chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        const f = btn.dataset.filter, v = btn.dataset.value;
        // Toggle grade-first (no "All" chip for it); others pick-one.
        if (f === "grade") {
          filters.grade = filters.grade === v ? "" : v;
          btn.classList.toggle("active", filters.grade === v);
        } else {
          filters[f] = v;
          document.querySelectorAll(`#sell-filters .chip[data-filter="${f}"]`)
            .forEach((b) => b.classList.toggle("active", b === btn));
        }
        render();
      });
    });
    const sort = $("#sell-sort"); if (sort) sort.addEventListener("change", (e) => { sortKey = e.target.value; render(); });
    const tf = $("#sell-tag-filter"); if (tf) tf.addEventListener("input", (e) => { filters.tag = e.target.value.trim(); render(); });
    const sf = $("#sell-search"); if (sf) sf.addEventListener("input", (e) => { filters.search = e.target.value.trim(); render(); });
    document.querySelectorAll('#sell-filters .chip[data-value=""]').forEach((b) => b.classList.add("active"));
  }

  wire();
})();
