/* Sell Cockpit — visual board over /api/sell. Independent of app.js. */
(function () {
  const $ = (s) => document.querySelector(s);
  const RENDER_CAP = 300;

  const CHANNEL_CLASS = {
    "eBay (auction)": "ch-ebay-auction",
    "eBay (fixed)": "ch-ebay-fixed",
    "TCGplayer": "ch-tcg",
    "Bulk lot": "ch-bulk",
  };

  let rows = [];
  const filters = { channel: "", band: "", keep: "", tag: "", search: "" };

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
      const r = await fetch("/api/sell");
      if (!r.ok) { $("#sell-meta").textContent = "Run a match first (upload an export)."; return; }
      d = await r.json();
    } catch (e) { $("#sell-meta").textContent = "Error loading."; return; }
    rows = d.rows || [];
    render();
  }

  function passes(row) {
    if (filters.channel && row.channel !== filters.channel) return false;
    if (filters.band && row.band !== filters.band) return false;
    if (filters.keep === "keep" && !row.keep) return false;
    if (filters.keep === "sell" && row.keep) return false;
    if (filters.tag && !(row.tags || []).some((x) => x.includes(filters.tag.toLowerCase()))) return false;
    if (filters.search) {
      const q = filters.search.toLowerCase();
      if (!((row.name || "") + " " + (row.set || "")).toLowerCase().includes(q)) return false;
    }
    return true;
  }

  function render() {
    const shown = rows.filter(passes);
    const val = shown.reduce((a, r) => a + r.price * r.qty, 0);
    const capped = shown.length > RENDER_CAP;
    $("#sell-meta").textContent =
      `${shown.length} of ${rows.length} cards · $${val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} shown` +
      (capped ? ` · showing first ${RENDER_CAP} (filter to see more)` : "");
    $("#sell-empty").classList.toggle("hidden", shown.length > 0);

    const grid = $("#sell-grid");
    grid.innerHTML = "";
    const frag = document.createDocumentFragment();
    shown.slice(0, RENDER_CAP).forEach((r) => frag.appendChild(tile(r)));
    grid.appendChild(frag);
  }

  function flagChip(f) {
    if (f.startsWith("tcgp-tracking")) return `<span class="flag warn" title="TCGplayer requires tracking on $50+ orders — routed to eBay">📦 $50+</span>`;
    if (f.startsWith("ebay-authenticity")) return `<span class="flag lock" title="eBay authenticates cards $250+ (extra shipping leg + delay)">🔒 $250+</span>`;
    if (f === "scarce") return `<span class="flag scarce" title="Scarce/chase — auction realizes above market">✦ scarce</span>`;
    return `<span class="flag">${f}</span>`;
  }

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  function tile(row) {
    const el = document.createElement("div");
    el.className = "sell-tile" + (row.keep ? " is-keep" : "");
    const img = row.tcgplayer_id
      ? `<img loading="lazy" src="/api/image/${row.tcgplayer_id}?size=200" onerror="this.classList.add('broken')">`
      : `<div class="noimg">no image</div>`;
    const flags = (row.flags || []).map(flagChip).join("");
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
        <div class="tile-flags">${flags}</div>
        <div class="tile-tags">${tags}<button class="add-tag" data-act="addtag">+ tag</button></div>
      </div>`;
    el.addEventListener("click", (ev) => onClick(ev, row, el));
    return el;
  }

  async function patch(row, body) {
    try {
      await fetch("/api/tag", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ row_idx: row.row_idx, ...body }),
      });
    } catch (e) { /* best-effort; UI already updated */ }
  }

  async function onClick(ev, row, el) {
    const act = ev.target.dataset && ev.target.dataset.act;
    if (!act) return;
    ev.stopPropagation();
    if (act === "keep") {
      row.keep = !row.keep;
      el.classList.toggle("is-keep", row.keep);
      ev.target.textContent = row.keep ? "★" : "☆";
      patch(row, { keep: row.keep });
    } else if (act === "addtag") {
      const t = prompt("Add tag (e.g. under-1, sell-later, mint, graded-me):");
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
    const open = $("#open-sell-btn"); if (open) open.addEventListener("click", openSell);
    const back = $("#sell-back-btn"); if (back) back.addEventListener("click", backToSummary);
    document.querySelectorAll("#sell-filters .chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        const f = btn.dataset.filter;
        filters[f] = btn.dataset.value;
        document.querySelectorAll(`#sell-filters .chip[data-filter="${f}"]`)
          .forEach((b) => b.classList.toggle("active", b === btn));
        render();
      });
    });
    const tf = $("#sell-tag-filter"); if (tf) tf.addEventListener("input", (e) => { filters.tag = e.target.value.trim(); render(); });
    const sf = $("#sell-search"); if (sf) sf.addEventListener("input", (e) => { filters.search = e.target.value.trim(); render(); });
    document.querySelectorAll('#sell-filters .chip[data-value=""]').forEach((b) => b.classList.add("active"));
  }

  wire();
})();
