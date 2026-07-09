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
  const filters = { channel: "", band: "", status: "", grade: "", oc: "", photos: "", shop: "", tag: "", search: "" };
  let modalKey = null;   // natural_key of the card open in the detail modal
  let sortKey = "value";
  let viewMode = localStorage.getItem("sellViewMode") || "grid";   // 'grid' | 'list'

  function allSections() { return document.querySelectorAll("main > section.card"); }
  function openSell() {
    allSections().forEach((s) => s.classList.add("hidden"));
    $("#sell-section").classList.remove("hidden");
    load();
  }
  function showMatcher() {
    // Matcher is now secondary — reveal the upload/match tools.
    allSections().forEach((s) => s.classList.add("hidden"));
    $("#upload-section").classList.remove("hidden");
  }

  function setView(mode) {
    viewMode = mode;
    localStorage.setItem("sellViewMode", mode);
    const g = $("#view-grid"), l = $("#view-list");
    if (g) g.classList.toggle("active", mode === "grid");
    if (l) l.classList.toggle("active", mode === "list");
    render();
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
      </div>
      <div class="sum-ledger">
        <span class="led sold">✅ ${s.sold} sold · ${money(s.realized)} realized${s.market_sold ? ` (${Math.round(s.realized_pct * 100)}% of their market)` : ""}</span>
        <span class="led">📋 ${s.listed} listed</span>
        <span class="led dim">${s.unlisted_sellable} still to list</span>
      </div>`;
  }

  function passes(row) {
    if (filters.channel && row.channel !== filters.channel) return false;
    if (filters.band && row.band !== filters.band) return false;
    if (filters.status === "unlisted" && row.status) return false;
    if (filters.status === "listed" && row.status !== "listed") return false;
    if (filters.status === "sold" && row.status !== "sold") return false;
    if (filters.grade === "grade" && !row.grade_flag) return false;
    if (filters.oc === "oc" && !row.off_center) return false;
    if (filters.photos === "photos" && !(row.has_front || row.has_back)) return false;
    if (filters.shop === "shop" && !(row.tags || []).includes("shop")) return false;
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
    grid.className = "sell-grid" + (viewMode === "list" ? " list-view" : "");
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
    const isrc = row.image_url || (row.tcgplayer_id ? `/api/image/${row.tcgplayer_id}` : "");
    const img = isrc
      ? `<img loading="lazy" src="${isrc}" onerror="this.classList.add('broken')">`
      : `<div class="noimg">no image</div>`;
    const flags = (row.flags || []).map(flagChip).join("");
    const gradeBadge = row.grade_flag
      ? `<span class="flag grade" title="${esc(row.grade_reason)}">◆ grade +${money(row.grade_gap)}</span>` : "";
    const tags = (row.tags || []).filter((t) => t !== "shop" && t !== "off-center").map((t) =>
      `<span class="tag">${esc(t)}<button class="tag-x" data-act="untag" data-tag="${esc(t)}">×</button></span>`).join("");
    const badges =
      (row.status === "sold" ? '<span class="tb sold" title="Sold">✅</span>'
        : row.status === "listed" ? '<span class="tb listed" title="Listed">📋</span>' : "") +
      (row.off_center ? '<span class="tb oc" title="Off-center">◎</span>' : "") +
      ((row.tags || []).includes("shop") ? '<span class="tb shop" title="Shop drop-off">🏪</span>' : "") +
      ((row.has_front || row.has_back) ? '<span class="tb cam" title="Has photos">📷</span>' : "");
    el.innerHTML = `
      <div class="tile-img">${img}
        <button class="keep-star" data-act="keep" title="Keep for personal collection">${row.keep ? "★" : "☆"}</button>
        <div class="tile-badges">${badges}</div>
      </div>
      <div class="tile-body">
        <div class="tile-name" title="${esc(row.name)}">${esc(row.name)}</div>
        <div class="tile-sub">${esc(row.set)} · #${esc(row.number) || "—"}</div>
        <div class="tile-row">
          <span class="price">$${row.price.toFixed(2)}${row.qty > 1 ? ` ×${row.qty}` : ""}${row.condition && row.condition !== "NM" ? ` <span class="cond-chip">${row.condition}</span>` : ""}</span>
          <span class="badge ${CHANNEL_CLASS[row.channel] || ""}" title="${esc(row.channel_reason)}">${esc(row.channel)}</span>
        </div>
        <div class="tile-net">net $${row.net_unit.toFixed(0)} · <b>${Math.round(row.net_pct * 100)}%</b>${row.psa10 ? ` · PSA10 ~$${Math.round(row.psa10)}` : ""}</div>
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
    if (!act) { openCard(row); return; }   // click the tile (not a button) → detail modal
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
    const matcher = $("#sell-matcher-btn"); if (matcher) matcher.addEventListener("click", showMatcher);
    const vg = $("#view-grid"); if (vg) vg.addEventListener("click", () => setView("grid"));
    const vl = $("#view-list"); if (vl) vl.addEventListener("click", () => setView("list"));
    const bd = $("#modal-backdrop"); if (bd) bd.addEventListener("click", closeCard);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeCard(); });
    // Dropdown filters (channel / price band / status).
    [["#f-channel", "channel"], ["#f-band", "band"], ["#f-status", "status"]].forEach(([sel, key]) => {
      const el = $(sel);
      if (el) el.addEventListener("change", () => { filters[key] = el.value; render(); });
    });
    // Toggle chips (grade / off-center / photos / shop drop-off).
    document.querySelectorAll("#sell-filters .chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        const f = btn.dataset.filter, v = btn.dataset.value;
        filters[f] = filters[f] === v ? "" : v;
        btn.classList.toggle("active", filters[f] === v);
        render();
      });
    });
    const sort = $("#sell-sort"); if (sort) sort.addEventListener("change", (e) => { sortKey = e.target.value; render(); });
    const tf = $("#sell-tag-filter"); if (tf) tf.addEventListener("input", (e) => { filters.tag = e.target.value.trim(); render(); });
    const sf = $("#sell-search"); if (sf) sf.addEventListener("input", (e) => { filters.search = e.target.value.trim(); render(); });
    // Reflect the persisted view mode in the toggle buttons.
    const g = $("#view-grid"), l = $("#view-list");
    if (g) g.classList.toggle("active", viewMode === "grid");
    if (l) l.classList.toggle("active", viewMode === "list");
  }

  // ── Card detail modal: photos + list/sold + keep/tags ──────────────────
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
    modalKey = row.natural_key;
    const isrc = row.image_url || (row.tcgplayer_id ? `/api/image/${row.tcgplayer_id}` : "");
    const img = isrc ? `<img src="${isrc}">` : `<div class="noimg">no image</div>`;
    const grade = row.grade_flag
      ? `<div class="m-grade">◆ Grade-first — ${esc(row.grade_reason)}</div>`
      : (row.off_center ? `<div class="m-grade oc">◎ Off-center — excluded from grading</div>` : "");
    const tags = (row.tags || []).filter((t) => t !== "shop" && t !== "off-center").map((t) => `<span class="tag">${esc(t)}<button class="tag-x" data-mact="untag" data-tag="${esc(t)}">×</button></span>`).join("");
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
            <span class="m-net">net $${row.net_unit.toFixed(0)} · <b>${Math.round(row.net_pct * 100)}%</b></span>
          </div>
          ${grade}
          <div class="m-row m-extra">
            <label class="filter-label">Condition
              <select id="m-cond">${["NM", "LP", "MP", "HP", "DMG"].map((c) => `<option value="${c}" ${(row.condition || "NM") === c ? "selected" : ""}>${c}</option>`).join("")}</select>
            </label>
            ${row.condition && row.condition !== "NM" ? `<span class="dim">NM $${(row.market_price != null ? row.market_price : row.price).toFixed(2)}</span>` : ""}
          </div>
          <div class="m-extra-lines">
            <div class="m-line">◆ PSA 10 (est): <b>$${Math.round(row.psa10).toLocaleString()}</b> · ${row.psa10_pct}× raw</div>
            <div class="m-line">🏪 Local shop: trade <b>$${Math.round(row.shop_trade)}</b> / cash $${Math.round(row.shop_cash)}
              <button class="m-btn sm ${(row.tags || []).includes("shop") ? "on" : ""}" data-mact="shop">${(row.tags || []).includes("shop") ? "✓ drop-off" : "+ drop-off"}</button>
            </div>
          </div>
          <div class="m-row">
            <button class="m-btn ${row.keep ? "on" : ""}" data-mact="keep">${row.keep ? "★ Keeper" : "☆ Keep"}</button>
            <button class="m-btn ${(row.tags || []).includes("off-center") ? "on" : ""}" data-mact="oc">◎ Off-center</button>
            <button class="m-btn" data-mact="addtag">+ tag</button>
            <span class="m-tags">${tags}</span>
          </div>
          <div class="m-row m-status">
            <span class="filter-label">Status</span>
            <button class="m-btn ${row.status === "listed" ? "on" : ""}" data-mact="listed">📋 Listed</button>
            <button class="m-btn ${row.status === "sold" ? "on" : ""}" data-mact="sold">✅ Sold</button>
            <input type="number" step="0.01" id="m-price" class="m-price" placeholder="sale $" value="${row.sale_price != null ? row.sale_price : ""}">
            ${row.status ? `<button class="m-btn ghost" data-mact="unlist">clear</button>` : ""}
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
    const cs = document.querySelector("#m-cond");
    if (cs) cs.addEventListener("change", async () => {
      await fetch("/api/condition", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ row_idx: row.row_idx, condition: cs.value }) });
      await refreshReopen(row.natural_key);
    });
    $("#card-modal").classList.remove("hidden");
  }

  async function refreshReopen(nkey) {
    await load();
    const r = rows.find((x) => x.natural_key === nkey);
    if (r) openCard(r); else closeCard();
  }

  async function statusPatch(row, body) {
    try {
      await fetch("/api/status", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ row_idx: row.row_idx, ...body }) });
    } catch (e) { /* ignore */ }
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
    } else if (act === "listed" || act === "sold") {
      const body = { status: row.status === act ? null : act };
      const priceEl = $("#m-price");
      if (act === "sold" && priceEl && priceEl.value) body.sale_price = priceEl.value;
      await statusPatch(row, body); await refreshReopen(row.natural_key);
    } else if (act === "unlist") {
      await statusPatch(row, { status: null }); await refreshReopen(row.natural_key);
    } else if (act === "shop" || act === "oc") {
      const t = act === "oc" ? "off-center" : "shop";
      const has = (row.tags || []).includes(t);
      const tg = has ? (row.tags || []).filter((x) => x !== t) : [...(row.tags || []), t];
      await patch(row, { tags: tg }); await refreshReopen(row.natural_key);
    } else if (act === "delphoto") {
      const side = ev.target.dataset.side;
      try { await fetch(`/api/photo/${row.natural_key}/${side}`, { method: "DELETE" }); } catch (e) {}
      if (side === "front") row.has_front = false; else row.has_back = false;
      openCard(row); render();
    }
  }

  // ── Holds (graded + sealed) ────────────────────────────────────────────
  function closeHolds() {
    $("#holds-section").classList.add("hidden");
    $("#sell-section").classList.remove("hidden");
  }

  function holdTile(it) {
    const el = document.createElement("div");
    el.className = "sell-tile";
    const img = it.image_url
      ? `<img loading="lazy" src="${it.image_url}" onerror="this.classList.add('broken')">`
      : `<div class="noimg">${it.reason}</div>`;
    el.innerHTML = `
      <div class="tile-img">${img}<div class="tile-badges"><span class="tb">${it.reason === "graded" ? "🏆" : "📦"}</span></div></div>
      <div class="tile-body">
        <div class="tile-name" title="${esc(it.name)}">${esc(it.name)}</div>
        <div class="tile-sub">${esc(it.set)}${it.number ? " · #" + esc(it.number) : ""}${it.grade && it.grade !== "Ungraded" ? " · " + esc(it.grade) : ""}</div>
        <div class="tile-row"><span class="price">$${it.value.toFixed(2)}</span><span class="badge ch-bulk">HOLD</span></div>
      </div>`;
    return el;
  }

  async function openHolds() {
    allSections().forEach((s) => s.classList.add("hidden"));
    $("#holds-section").classList.remove("hidden");
    const g = $("#holds-grid");
    g.className = "sell-grid";
    g.innerHTML = "";
    $("#holds-meta").textContent = "Loading…";
    let d;
    try { d = await (await fetch("/api/holds")).json(); } catch (e) { $("#holds-meta").textContent = "Error."; return; }
    $("#holds-meta").textContent = `${d.count} holds · ${money(d.total)} · ${d.graded} graded · ${d.sealed} sealed — long-term keepers, never routed for sale.`;
    const frag = document.createDocumentFragment();
    (d.items || []).forEach((it) => frag.appendChild(holdTile(it)));
    g.appendChild(frag);
  }

  async function doManifest() {
    let d;
    try {
      d = await (await fetch("/api/manifest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tag: "shop" }) })).json();
    } catch (e) { alert("Error generating manifest."); return; }
    if (!d.count) { alert('No cards tagged for the shop yet.\nOpen a card → 🏪 "+ drop-off" to add it, then generate the manifest.'); return; }
    alert(`🏪 Shop drop-off manifest — ${d.count} cards\n\nYour value: $${Math.round(d.total_value).toLocaleString()}\nTrade credit (80/70%): $${Math.round(d.total_trade).toLocaleString()}\nCash (70/60%): $${Math.round(d.total_cash).toLocaleString()}\n\nSaved CSV: ${d.path}`);
  }

  wire();
  const hb = $("#holds-btn"); if (hb) hb.addEventListener("click", openHolds);
  const hbb = $("#holds-back-btn"); if (hbb) hbb.addEventListener("click", closeHolds);
  const mb = $("#manifest-btn"); if (mb) mb.addEventListener("click", doManifest);
  // Cockpit is the primary view — open it straight away (auto-matches if needed).
  openSell();
})();
