/* Sell Cockpit — tabbed liquidation board over /api/sell. Independent of app.js. */
(function () {
  const $ = (s) => document.querySelector(s);
  const RENDER_CAP = 300;

  const CHANNEL_CLASS = {
    "eBay (auction)": "ch-ebay-auction",
    "eBay (fixed)": "ch-ebay-fixed",
    "TCGplayer": "ch-tcg",
    "LCS": "ch-bulk",
  };
  const SORTS = {
    value: (a, b) => b.price - a.price,
    psa10x: (a, b) => (b.psa10_x || 0) - (a.psa10_x || 0),
    netpct: (a, b) => (b.net_pct || 0) - (a.net_pct || 0),
    sellnow: (a, b) => (b.sell_now || 0) - (a.sell_now || 0),
    gradegap: (a, b) => (b.grade_gap || 0) - (a.grade_gap || 0),
  };
  const TABS = [
    ["pkmn", "Pkmn Raw"], ["mtg", "MTG Raw"], ["ygo", "YGO Raw"],
    ["graded", "Graded"], ["sealed", "Sealed"],
  ];

  let rows = [];
  let summary = null;
  let tab = localStorage.getItem("sellTab") || "pkmn";
  const filters = { channel: "", band: "", notnm: "", grade: "", oc: "", shop: "",
                    keepers: "", photos: "", tag: "", search: "" };
  let sortKey = "value";
  let viewMode = localStorage.getItem("sellViewMode") || "grid";

  const money = (n) => "$" + Math.round(n).toLocaleString();
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function allSections() { return document.querySelectorAll("main > section.card"); }
  function openSell() {
    allSections().forEach((s) => s.classList.add("hidden"));
    $("#sell-section").classList.remove("hidden");
    load();
  }
  function showMatcher() {
    allSections().forEach((s) => s.classList.add("hidden"));
    $("#upload-section").classList.remove("hidden");
  }
  function setView(mode) {
    viewMode = mode;
    localStorage.setItem("sellViewMode", mode);
    $("#view-grid").classList.toggle("active", mode === "grid");
    $("#view-list").classList.toggle("active", mode === "list");
    render();
  }
  function setTab(t) {
    tab = t;
    localStorage.setItem("sellTab", t);
    renderTabs();
    render();
  }

  async function load() {
    $("#sell-meta").textContent = "Loading…";
    let d;
    try {
      let r = await fetch("/api/sell");
      if (r.status === 400) {
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
    renderTabs();
    render();
  }

  function renderSummary() {
    const bar = $("#sell-summary");
    if (!summary) { bar.innerHTML = ""; return; }
    const s = summary;
    bar.innerHTML = `
      <div class="sum-head">
        <div><span class="sum-pct">${Math.round(s.pct * 100)}%</span> recovered
          <span class="dim">· net ${money(s.net)} of ${money(s.market)} raw market</span></div>
      </div>
      <div class="sum-notes">
        <span class="sum-note grade">◆ ${s.grade_candidates} grade-first (~+${money(s.grade_extra)})</span>
        <span class="sum-note">🔍 ${s.not_nm_queue} awaiting condition check</span>
        <span class="sum-note">★ ${s.keepers} keepers (${money(s.keepers_value)})</span>
      </div>`;
    const nn = $("#notnm-count"); if (nn) nn.textContent = s.not_nm_queue ? `(${s.not_nm_queue})` : "";
  }

  function renderTabs() {
    const el = $("#sell-tabs");
    if (!summary) { el.innerHTML = ""; return; }
    el.innerHTML = TABS.map(([key, label]) => {
      const b = summary.by_bucket[key] || { market: 0, count: 0 };
      return `<button class="tab ${tab === key ? "active" : ""}" data-tab="${key}">
        ${label} <span class="tab-val">${money(b.market)}</span></button>`;
    }).join("");
    el.querySelectorAll(".tab").forEach((b) =>
      b.addEventListener("click", () => setTab(b.dataset.tab)));
  }

  function passes(row) {
    if (row.bucket !== tab) return false;
    if (filters.channel && row.channel !== filters.channel) return false;
    if (filters.band && row.band !== filters.band) return false;
    if (filters.notnm && !row.not_nm) return false;
    if (filters.grade && !row.grade_flag) return false;
    if (filters.oc && !row.off_center) return false;
    if (filters.shop && !(row.tags || []).includes("shop")) return false;
    if (filters.keepers && !row.keep) return false;
    if (filters.photos && !(row.has_front || row.has_back)) return false;
    if (filters.tag && !(row.tags || []).some((x) => x.includes(filters.tag.toLowerCase()))) return false;
    if (filters.search) {
      const q = filters.search.toLowerCase();
      if (!((row.name || "") + " " + (row.set || "")).toLowerCase().includes(q)) return false;
    }
    return true;
  }

  function render() {
    const holdsTab = tab === "graded" || tab === "sealed";
    $("#sell-filters").style.display = holdsTab ? "none" : "";
    const shown = rows.filter(passes).sort(SORTS[sortKey] || SORTS.value);
    const val = shown.reduce((a, r) => a + r.price * (holdsTab ? 1 : r.qty), 0);
    const capped = shown.length > RENDER_CAP;
    $("#sell-meta").textContent =
      `${shown.length} cards · ${money(val)}` + (capped ? ` · showing first ${RENDER_CAP}` : "");
    $("#sell-empty").classList.toggle("hidden", shown.length > 0);
    const grid = $("#sell-grid");
    grid.className = "sell-grid" + (viewMode === "list" ? " list-view" : "");
    grid.innerHTML = "";
    const frag = document.createDocumentFragment();
    shown.slice(0, RENDER_CAP).forEach((r) => frag.appendChild(holdsTab ? holdTile(r) : tile(r)));
    grid.appendChild(frag);
  }

  function flagChip(f) {
    if (f.startsWith("tcgp-tracking")) return `<span class="flag warn" title="TCGplayer requires tracking on $50+ — routed to eBay">📦 $50+</span>`;
    if (f.startsWith("ebay-authenticity")) return `<span class="flag lock" title="eBay authenticates cards $250+ (free, +few days)">🔒 $250+</span>`;
    if (f === "scarce") return `<span class="flag scarce" title="Scarce/chase — auction realizes above market">✦ scarce</span>`;
    if (f === "japanese") return `<span class="flag" title="Japanese — sell on eBay, not TCGplayer">🇯🇵 JP</span>`;
    if (f === "art-card") return `<span class="flag">🎨 art</span>`;
    return `<span class="flag">${esc(f)}</span>`;
  }

  function quickbar(row) {
    return `<div class="quickbar">
      <button class="qb ${row.keep ? "on" : ""}" data-act="keep" title="Keep (personal collection)">★</button>
      <button class="qb ${row.not_nm ? "on" : ""}" data-act="notnm" title="Not NM — send to conditioning queue">!NM</button>
      <button class="qb ${row.off_center ? "on" : ""}" data-act="oc" title="Off-center (excludes from grading)">◎</button>
      <button class="qb ${(row.tags || []).includes("shop") ? "on" : ""}" data-act="shop" title="Shop drop-off pile">🏪</button>
    </div>`;
  }

  function psaLine(row) {
    if (row.bucket !== "pkmn" || !row.psa10) {
      return `<div class="tile-net">net $${(row.net_unit || 0).toFixed(0)} · <b>${Math.round((row.net_pct || 0) * 100)}%</b> back</div>`;
    }
    const hot = row.psa10_x >= 8;
    const src = row.psa10_real ? "" : "~";
    return `<div class="tile-psa ${hot ? "hot" : ""}" title="${row.psa10_real ? "Real PSA-10 price (PriceCharting)" : "Estimated from class multiple — hit 💲 Update prices for real comps"}">
      PSA10 ${src}${money(row.psa10)} · <b>${row.psa10_x}×</b>${hot ? " 🔥" : ""}
      <span class="dim">· net $${(row.net_unit || 0).toFixed(0)} raw</span></div>`;
  }

  function tile(row) {
    const el = document.createElement("div");
    el.className = "sell-tile" + (row.keep ? " is-keep" : "");
    const isrc = row.image_url || (row.tcgplayer_id ? `/api/image/${row.tcgplayer_id}` : "");
    const img = isrc ? `<img loading="lazy" src="${isrc}" onerror="this.classList.add('broken')">`
                     : `<div class="noimg">no image</div>`;
    const badges =
      (row.not_nm ? '<span class="tb notnm" title="Awaiting condition check">🔍</span>' : "") +
      (row.off_center ? '<span class="tb oc" title="Off-center">◎</span>' : "") +
      ((row.tags || []).includes("shop") ? '<span class="tb shop" title="Shop drop-off">🏪</span>' : "") +
      ((row.has_front || row.has_back) ? '<span class="tb cam" title="Has photos">📷</span>' : "");
    const flags = (row.flags || []).map(flagChip).join("");
    const gradeBadge = row.grade_flag
      ? `<span class="flag grade" title="${esc(row.grade_reason)}">◆ grade +${money(row.grade_gap)}</span>` : "";
    const condChip = row.condition && row.condition !== "NM"
      ? ` <span class="cond-chip">${row.condition}</span>` : "";
    el.innerHTML = `
      <div class="tile-img">${img}<div class="tile-badges">${badges}</div></div>
      <div class="tile-body">
        <div class="tile-name" title="${esc(row.name)}">${row.keep ? "★ " : ""}${esc(row.name)}</div>
        <div class="tile-sub">${esc(row.set)} · #${esc(row.number) || "—"}</div>
        <div class="tile-row">
          <span class="price">$${row.price.toFixed(2)}${row.qty > 1 ? ` ×${row.qty}` : ""}${condChip}</span>
          <span class="badge ${CHANNEL_CLASS[row.channel] || ""}" title="${esc(row.channel_reason)}">${esc(row.channel)}</span>
        </div>
        ${psaLine(row)}
        <div class="tile-flags">${gradeBadge}${flags}</div>
        ${quickbar(row)}
      </div>`;
    el.addEventListener("click", (ev) => onClick(ev, row, el));
    return el;
  }

  function holdTile(it) {
    const el = document.createElement("div");
    el.className = "sell-tile";
    const isrc = it.image_url || "";
    el.innerHTML = `
      <div class="tile-img">${isrc ? `<img loading="lazy" src="${isrc}">` : `<div class="noimg">${it.bucket}</div>`}
        <div class="tile-badges"><span class="tb">${it.bucket === "graded" ? "🏆" : "📦"}</span></div></div>
      <div class="tile-body">
        <div class="tile-name" title="${esc(it.name)}">${esc(it.name)}</div>
        <div class="tile-sub">${esc(it.set)}${it.number ? " · #" + esc(it.number) : ""}${it.grade && it.grade !== "Ungraded" ? " · " + esc(it.grade) : ""}</div>
        <div class="tile-row"><span class="price">$${it.price.toFixed(2)}</span><span class="badge ch-bulk">HOLD</span></div>
      </div>`;
    return el;
  }

  // ── Actions ──────────────────────────────────────────────────────────────
  async function patch(row, body) {
    try {
      await fetch("/api/tag", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ row_idx: row.row_idx, ...body }) });
    } catch (e) { /* UI already updated */ }
  }

  function toggleTag(row, t) {
    const has = (row.tags || []).includes(t);
    row.tags = has ? (row.tags || []).filter((x) => x !== t) : [...(row.tags || []), t];
    if (t === "not-nm") row.not_nm = !has;
    if (t === "off-center") row.off_center = !has;
    return patch(row, { tags: row.tags });
  }

  async function onClick(ev, row, el) {
    const act = ev.target.dataset && ev.target.dataset.act;
    if (!act) { openCard(row); return; }
    ev.stopPropagation();
    if (act === "keep") {
      row.keep = !row.keep;
      await patch(row, { keep: row.keep });
      load();   // totals + keeper counts shift
    } else if (act === "notnm") {
      await toggleTag(row, "not-nm"); renderSummaryCounts(); render();
    } else if (act === "oc") {
      await toggleTag(row, "off-center"); render();
    } else if (act === "shop") {
      await toggleTag(row, "shop"); render();
    } else if (act === "untag") {
      row.tags = (row.tags || []).filter((x) => x !== ev.target.dataset.tag);
      patch(row, { tags: row.tags }); render();
    }
  }

  function renderSummaryCounts() {
    if (!summary) return;
    summary.not_nm_queue = rows.filter((r) => r.not_nm).length;
    renderSummary();
  }

  // ── Card detail modal ────────────────────────────────────────────────────
  let modalKey = null;
  function closeCard() { modalKey = null; $("#card-modal").classList.add("hidden"); }

  function photoSlot(row, side) {
    const has = side === "front" ? row.has_front : row.has_back;
    const src = has ? `/api/photo/${row.natural_key}/${side}?t=${Date.now()}` : "";
    return `<div class="photo-slot">
        <label class="ps-drop">
          ${has ? `<img src="${src}">` : `<span class="ps-hint">＋ ${side}</span>`}
          <input type="file" accept="image/*" capture="environment" data-side="${side}" hidden>
        </label>
        <div class="ps-row"><span>${side}</span>${has ? `<button class="linkbtn" data-mact="delphoto" data-side="${side}">remove</button>` : ""}</div>
      </div>`;
  }

  function openCard(row) {
    if (row.row_idx < 0) return;   // graded/sealed display rows
    modalKey = row.natural_key;
    const isrc = row.image_url || (row.tcgplayer_id ? `/api/image/${row.tcgplayer_id}` : "");
    const img = isrc ? `<img src="${isrc}">` : `<div class="noimg">no image</div>`;
    const grade = row.grade_flag
      ? `<div class="m-grade">◆ Grade-first — ${esc(row.grade_reason)}</div>`
      : (row.off_center ? `<div class="m-grade oc">◎ Off-center — excluded from grading</div>` : "");
    const tags = (row.tags || []).filter((t) => !["shop", "off-center", "not-nm"].includes(t)).map((t) =>
      `<span class="tag">${esc(t)}<button class="tag-x" data-mact="untag" data-tag="${esc(t)}">×</button></span>`).join("");
    const psa = row.bucket === "pkmn" && row.psa10
      ? `<div class="m-line ${row.psa10_x >= 8 ? "hot" : ""}">◆ PSA 10${row.psa10_real ? "" : " (est)"}: <b>${money(row.psa10)}</b> · ${row.psa10_x}× raw${row.psa10_x >= 8 ? " 🔥 don't undersell" : ""}</div>` : "";
    $("#modal-panel").innerHTML = `
      <button class="modal-close" data-mact="close">×</button>
      <div class="modal-grid">
        <div class="modal-art">${img}</div>
        <div class="modal-info">
          <h3>${esc(row.name)}</h3>
          <p class="dim">${esc(row.set)} · #${esc(row.number) || "—"}${row.variance ? " · " + esc(row.variance) : ""}</p>
          <div class="m-stats">
            <span class="price">$${row.price.toFixed(2)}</span>
            <span class="badge ${CHANNEL_CLASS[row.channel] || ""}">${esc(row.channel)}</span>
            <span class="m-net">net $${(row.net_unit || 0).toFixed(0)} · <b>${Math.round((row.net_pct || 0) * 100)}%</b></span>
          </div>
          ${grade}
          <div class="m-row m-extra">
            <label class="filter-label">Condition
              <select id="m-cond">${["NM", "LP", "MP", "HP", "DMG"].map((c) => `<option value="${c}" ${(row.condition || "NM") === c ? "selected" : ""}>${c}</option>`).join("")}</select>
            </label>
            <button class="m-btn ${row.not_nm ? "on" : ""}" data-mact="notnm">🔍 Not NM</button>
            ${row.condition && row.condition !== "NM" ? `<span class="dim">NM $${(row.market_price != null ? row.market_price : row.price).toFixed(2)}</span>` : ""}
          </div>
          <div class="m-extra-lines">
            ${psa}
            <div class="m-line">🏪 Shop: trade <b>$${Math.round(row.shop_trade || 0)}</b> / cash $${Math.round(row.shop_cash || 0)}
              <button class="m-btn sm ${(row.tags || []).includes("shop") ? "on" : ""}" data-mact="shop">${(row.tags || []).includes("shop") ? "✓ drop-off" : "+ drop-off"}</button>
            </div>
          </div>
          <div class="m-row">
            <button class="m-btn ${row.keep ? "on" : ""}" data-mact="keep">${row.keep ? "★ Keeper" : "☆ Keep"}</button>
            <button class="m-btn ${row.off_center ? "on" : ""}" data-mact="oc">◎ Off-center</button>
            <button class="m-btn" data-mact="addtag">+ tag</button>
            <span class="m-tags">${tags}</span>
          </div>
          <div class="m-photos">
            <div class="filter-label">Photos for eBay</div>
            <div class="ps-wrap">${photoSlot(row, "front")}${photoSlot(row, "back")}</div>
          </div>
        </div>
      </div>`;
    const panel = $("#modal-panel");
    panel.onclick = (ev) => onModalClick(ev, row);
    panel.querySelectorAll("input[type=file]").forEach((inp) =>
      inp.addEventListener("change", () => { if (inp.files[0]) uploadPhoto(row, inp.dataset.side, inp.files[0]); }));
    const cs = $("#m-cond");
    if (cs) cs.addEventListener("change", async () => {
      await fetch("/api/condition", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ row_idx: row.row_idx, condition: cs.value }) });
      // Setting a real condition resolves the "not NM?" question → clear the queue flag.
      if (row.not_nm) await toggleTag(row, "not-nm");
      await refreshReopen(row.natural_key);
    });
    $("#card-modal").classList.remove("hidden");
  }

  async function refreshReopen(nkey) {
    await load();
    const r = rows.find((x) => x.natural_key === nkey);
    if (r) openCard(r); else closeCard();
  }

  async function uploadPhoto(row, side, file) {
    const fd = new FormData();
    fd.append("photo", file); fd.append("side", side); fd.append("row_idx", row.row_idx);
    try {
      const r = await fetch("/api/photo", { method: "POST", body: fd });
      if (r.ok) { if (side === "front") row.has_front = true; else row.has_back = true; openCard(row); render(); }
    } catch (e) { /* ignore */ }
  }

  async function onModalClick(ev, row) {
    const act = ev.target.dataset && ev.target.dataset.mact;
    if (!act) return;
    ev.stopPropagation();
    if (act === "close") { closeCard(); return; }
    if (act === "keep") {
      await patch(row, { keep: !row.keep }); await refreshReopen(row.natural_key);
    } else if (act === "addtag") {
      const t = prompt("Add tag:");
      if (t && t.trim()) { const tg = Array.from(new Set([...(row.tags || []), t.trim().toLowerCase()])); await patch(row, { tags: tg }); await refreshReopen(row.natural_key); }
    } else if (act === "untag") {
      const tg = (row.tags || []).filter((x) => x !== ev.target.dataset.tag);
      await patch(row, { tags: tg }); await refreshReopen(row.natural_key);
    } else if (act === "shop" || act === "oc" || act === "notnm") {
      const t = act === "oc" ? "off-center" : act === "notnm" ? "not-nm" : "shop";
      await toggleTag(row, t); await refreshReopen(row.natural_key);
    } else if (act === "delphoto") {
      const side = ev.target.dataset.side;
      try { await fetch(`/api/photo/${row.natural_key}/${side}`, { method: "DELETE" }); } catch (e) {}
      if (side === "front") row.has_front = false; else row.has_back = false;
      openCard(row); render();
    }
  }

  // ── Update prices + Import ───────────────────────────────────────────────
  let pricesTimer = null;
  async function updatePrices() {
    const btn = $("#prices-btn");
    try {
      await fetch("/api/update-prices", { method: "POST" });
    } catch (e) { return; }
    btn.disabled = true;
    const tick = async () => {
      let st;
      try { st = await (await fetch("/api/update-prices")).json(); } catch (e) { return; }
      if (st.running) {
        btn.textContent = `💲 Updating ${st.done}/${st.total}…`;
        pricesTimer = setTimeout(tick, 2500);
      } else {
        btn.textContent = "💲 Update prices";
        btn.disabled = false;
        load();   // reload with fresh prices
      }
    };
    tick();
  }

  function importCsv() { $("#import-file").click(); }
  async function onImportFile() {
    const f = $("#import-file").files[0];
    if (!f) return;
    $("#sell-meta").textContent = "Importing + matching…";
    const fd = new FormData();
    fd.append("export", f);
    try {
      const r = await fetch("/api/match", { method: "POST", body: fd });
      if (!r.ok) { $("#sell-meta").textContent = "Import failed."; return; }
      const d = await r.json();
      const pruned = (d.stats || {}).pruned_decisions;
      await load();
      if (pruned) $("#sell-meta").textContent += ` · synced (${pruned} removed cards cleaned up)`;
    } catch (e) { $("#sell-meta").textContent = "Import failed."; }
    $("#import-file").value = "";
  }

  async function doManifest() {
    let d;
    try {
      d = await (await fetch("/api/manifest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tag: "shop" }) })).json();
    } catch (e) { alert("Error generating manifest."); return; }
    if (!d.count) { alert('No cards tagged 🏪 yet — use the quick-tag on any card, then generate.'); return; }
    alert(`🏪 Shop drop-off manifest — ${d.count} cards\n\nYour value: $${Math.round(d.total_value).toLocaleString()}\nTrade credit: $${Math.round(d.total_trade).toLocaleString()}\nCash: $${Math.round(d.total_cash).toLocaleString()}\n\nSaved: ${d.path}`);
  }

  // ── Wiring ───────────────────────────────────────────────────────────────
  function wire() {
    ["#open-sell-btn", "#open-sell-btn-landing"].forEach((sel) => {
      const b = $(sel); if (b) b.addEventListener("click", openSell);
    });
    $("#sell-matcher-btn").addEventListener("click", showMatcher);
    $("#view-grid").addEventListener("click", () => setView("grid"));
    $("#view-list").addEventListener("click", () => setView("list"));
    $("#modal-backdrop").addEventListener("click", closeCard);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeCard(); });
    [["#f-channel", "channel"], ["#f-band", "band"]].forEach(([sel, key]) => {
      const el = $(sel); el.addEventListener("change", () => { filters[key] = el.value; render(); });
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
    $("#prices-btn").addEventListener("click", updatePrices);
    $("#import-btn").addEventListener("click", importCsv);
    $("#import-file").addEventListener("change", onImportFile);
    $("#manifest-btn").addEventListener("click", doManifest);
    $("#view-grid").classList.toggle("active", viewMode === "grid");
    $("#view-list").classList.toggle("active", viewMode === "list");
  }

  wire();
  openSell();   // cockpit is the primary view
})();
