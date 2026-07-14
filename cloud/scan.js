/* Liquidatr — Bulk Scan & Match (flip-stream capture + in-browser CLIP → pgvector).
   Loaded lazily by app.js (openScanner). Because the collection is a CLOSED set
   whose rows already carry reference images, recognition = nearest-neighbor of a
   card crop against the user's own inventory embeddings. Condition comes from the
   pile the operator declares — never inferred from the image. See SCAN_SPEC.md. */

const MODEL = "Xenova/clip-vit-base-patch32";          // image_embeds = 512-d ⇒ vector(512)
const TF_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2";
// Hosts that DON'T send CORS headers must be read through the img-proxy Edge Fn.
const NO_CORS = new Set(["images.ygoprodeck.com", "limitlesstcg.nyc3.cdn.digitaloceanspaces.com"]);
const CONDS = ["NM", "LP", "MP", "HP", "DMG"];
const AUTO_ACCEPT = 0.86;        // cosine ≥ this ⇒ auto-accepted in the review grid

let ctx = null;                  // injected by app.js
let clip = null;                 // { processor, model, RawImage }
const $ = (s, r = document) => r.querySelector(s);
const ico = (n, c = "") => `<svg class="ic ${c}" aria-hidden="true"><use href="#${n}"/></svg>`;
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ── CLIP (lazy; WebGPU with wasm fallback) ────────────────────────────────────
async function initClip(onStatus) {
  if (clip) return clip;
  onStatus?.("Loading the recognition model (one-time, ~cached after)…");
  const tf = await import(/* @vite-ignore */ TF_URL);
  tf.env.allowLocalModels = false;
  const processor = await tf.AutoProcessor.from_pretrained(MODEL);
  let model;
  try {
    model = await tf.CLIPVisionModelWithProjection.from_pretrained(MODEL, { device: "webgpu", dtype: "fp32" });
  } catch (e) {
    onStatus?.("WebGPU unavailable — using CPU (slower).");
    model = await tf.CLIPVisionModelWithProjection.from_pretrained(MODEL);
  }
  clip = { processor, model, RawImage: tf.RawImage };
  return clip;
}

function l2(vec) {
  let n = 0; for (const x of vec) n += x * x;
  n = Math.sqrt(n) || 1; return vec.map((x) => x / n);
}
async function embedBlob(blob) {
  const { processor, model, RawImage } = clip;
  const img = await RawImage.fromBlob(blob);
  const inputs = await processor(img);
  const out = await model(inputs);
  return l2(Array.from(out.image_embeds.data));           // 512 floats, unit length
}
const vecLiteral = (v) => "[" + v.map((x) => x.toFixed(6)).join(",") + "]";

// ── Image fetch (direct for CORS hosts, proxy otherwise) ──────────────────────
async function fetchImageBlob(url) {
  let host = "";
  try { host = new URL(url).hostname; } catch { }
  if (NO_CORS.has(host)) {
    const r = await fetch(`${ctx.FN_BASE}/img-proxy?url=${encodeURIComponent(url)}`, {
      headers: { apikey: ctx.ANON, Authorization: "Bearer " + ctx.ANON },
    });
    if (!r.ok) throw new Error("proxy " + r.status);
    return await r.blob();
  }
  const r = await fetch(url);                              // CORS-open ⇒ readable
  if (!r.ok) throw new Error("img " + r.status);
  return await r.blob();
}

// ── Build match index (one-time backfill, incremental after) ──────────────────
async function existingKeys() {
  const set = new Set();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await ctx.sb.from("ref_embeddings").select("natural_key").range(from, from + 999);
    if (error || !data || !data.length) break;
    data.forEach((r) => set.add(r.natural_key));
    if (data.length < 1000) break;
  }
  return set;
}
async function buildIndex(onProgress) {
  await initClip((m) => onProgress({ status: m }));
  const have = await existingKeys();
  const seen = new Set();
  const targets = ctx.rows.filter((r) => {
    if (!r.image_url || seen.has(r.natural_key) || have.has(r.natural_key)) return false;
    seen.add(r.natural_key); return true;
  });
  const total = targets.length;
  if (!total) { onProgress({ done: 0, total: 0, failed: 0, status: "Index already complete." }); return { total: 0 }; }
  let done = 0, failed = 0;
  const queue = [...targets];
  const batch = [];
  const flush = async () => {
    if (!batch.length) return;
    const chunk = batch.splice(0, batch.length);
    await ctx.sb.from("ref_embeddings").upsert(chunk, { onConflict: "natural_key" });
  };
  const worker = async () => {
    while (queue.length) {
      const r = queue.shift();
      try {
        const blob = await fetchImageBlob(r.image_url);
        const emb = await embedBlob(blob);
        batch.push({ natural_key: r.natural_key, embedding: vecLiteral(emb), image_url: r.image_url });
      } catch (e) { failed++; }
      done++;
      if (batch.length >= 50) await flush();
      if (done % 5 === 0 || done === total) onProgress({ done, total, failed, status: `Embedding ${done}/${total}…` });
    }
  };
  await Promise.all([worker(), worker(), worker()]);       // 3-wide; embedding is the bottleneck
  await flush();
  onProgress({ done, total, failed, status: `Done — indexed ${done - failed}/${total}${failed ? ` (${failed} skipped)` : ""}.` });
  return { total, done, failed };
}

// ── Match a captured crop against the user's inventory ────────────────────────
async function matchCanvas(canvas) {
  const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.9));
  const emb = await embedBlob(blob);
  const { data, error } = await ctx.sb.rpc("match_card", { q: vecLiteral(emb), k: 5 });
  if (error) throw error;
  return { matches: data || [], blob };
}

// ── Capture helpers ───────────────────────────────────────────────────────────
// Center-crop the current video frame to card aspect (2.5:3.5) at decent res.
function grabCardFrame(video) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  const ar = 2.5 / 3.5;
  let cw = vh * ar, ch = vh;
  if (cw > vw) { cw = vw; ch = vw / ar; }
  const sx = (vw - cw) / 2, sy = (vh - ch) / 2;
  const c = document.createElement("canvas");
  c.width = 500; c.height = Math.round(500 / ar);
  c.getContext("2d").drawImage(video, sx, sy, cw, ch, 0, 0, c.width, c.height);
  return c;
}
// Laplacian-ish sharpness: variance of a cheap high-pass on a downscaled gray.
function sharpness(canvas) {
  const s = 96, c = document.createElement("canvas"); c.width = s; c.height = s;
  const g = c.getContext("2d"); g.drawImage(canvas, 0, 0, s, s);
  const d = g.getImageData(0, 0, s, s).data;
  const gray = new Float32Array(s * s);
  for (let i = 0; i < s * s; i++) gray[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  let mean = 0, n = 0; const lap = [];
  for (let y = 1; y < s - 1; y++) for (let x = 1; x < s - 1; x++) {
    const i = y * s + x;
    const v = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - s] - gray[i + s];
    lap.push(v); mean += v; n++;
  }
  mean /= n; let vv = 0; for (const v of lap) vv += (v - mean) * (v - mean);
  return vv / n;
}
// Coarse average-hash to tell "different card" from "same card, next frame".
function ahash(canvas) {
  const s = 8, c = document.createElement("canvas"); c.width = s; c.height = s;
  const g = c.getContext("2d"); g.drawImage(canvas, 0, 0, s, s);
  const d = g.getImageData(0, 0, s, s).data; const px = [];
  let mean = 0; for (let i = 0; i < s * s; i++) { const v = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3; px.push(v); mean += v; }
  mean /= s * s; return px.map((v) => v > mean ? 1 : 0);
}
const hamming = (a, b) => { if (!a || !b) return 99; let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; };

// ── UI ────────────────────────────────────────────────────────────────────────
export async function openScanner(injected) {
  ctx = injected;
  let condition = "LP";
  let stream = null, autoOn = false, autoTimer = null, busy = false, lastHash = null, lastSharp = 0;
  const captured = [];   // { id, dataUrl, blob, matches, chosen (natural_key|null), score }

  const ov = document.createElement("div");
  ov.id = "scan-ov";
  ov.innerHTML = `
    <div class="scan-head">
      <strong>Scan a pile</strong>
      <div class="cond-seg" id="scan-cond">${CONDS.map((c) => `<button data-c="${c}" class="${c === condition ? "active" : ""}">${c}</button>`).join("")}</div>
      <span class="scan-idx" id="scan-idx"></span>
      <button class="icon-btn" id="scan-close" aria-label="Close">${ico("i-x", "m")}</button>
    </div>
    <div class="scan-body" id="scan-body"></div>
    <div class="scan-foot" id="scan-foot"></div>`;
  document.body.appendChild(ov);
  $("#scan-close", ov).addEventListener("click", close);
  $("#scan-cond", ov).querySelectorAll("[data-c]").forEach((b) => b.addEventListener("click", () => {
    condition = b.dataset.c; $("#scan-cond", ov).querySelectorAll("[data-c]").forEach((x) => x.classList.toggle("active", x === b)); renderFoot();
  }));

  const body = $("#scan-body", ov), foot = $("#scan-foot", ov);
  const { count } = await ctx.sb.from("ref_embeddings").select("*", { count: "exact", head: true });
  $("#scan-idx", ov).textContent = `index: ${(count || 0).toLocaleString()}`;
  if (!count) renderBuild(); else renderScan();

  function renderBuild() {
    const distinct = new Set(ctx.rows.filter((r) => r.image_url).map((r) => r.natural_key)).size;
    body.innerHTML = `<div class="scan-panel">
      <h3>Build the match index</h3>
      <p class="dim">One-time: embeds your ${distinct.toLocaleString()} card images so scans can be recognized. Runs in your browser (downloads a ~model file the first time). Keep this tab open — a few minutes.</p>
      <button class="cta" id="scan-build">Build match index</button>
      <div class="scan-prog hidden" id="scan-prog"><div class="nu-bar"><i style="width:0%"></i></div><div class="scan-prog-t dim"></div></div>
    </div>`;
    foot.innerHTML = "";
    $("#scan-build", body).addEventListener("click", async () => {
      $("#scan-build", body).disabled = true;
      const prog = $("#scan-prog", body); prog.classList.remove("hidden");
      const bar = $(".nu-bar i", prog), txt = $(".scan-prog-t", prog);
      try {
        await buildIndex(({ done = 0, total = 1, status }) => {
          bar.style.width = Math.round((done / (total || 1)) * 100) + "%";
          txt.textContent = status || "";
        });
        const { count: c2 } = await ctx.sb.from("ref_embeddings").select("*", { count: "exact", head: true });
        $("#scan-idx", ov).textContent = `index: ${(c2 || 0).toLocaleString()}`;
        renderScan();
      } catch (e) {
        txt.textContent = "Index build failed: " + (e.message || e);
        $("#scan-build", body).disabled = false;
      }
    });
  }

  async function renderScan() {
    body.innerHTML = `
      <div class="scan-cam">
        <video id="scan-video" playsinline muted></video>
        <div class="scan-guide"></div>
      </div>
      <div class="scan-controls">
        <button class="cta" id="scan-cap">${ico("i-camera")} Capture</button>
        <button class="tog-chip" id="scan-auto">Auto-capture: off</button>
        <span class="dim" id="scan-hint">Hold a card in the frame (fills the guide) and tap Capture — or turn on Auto and flip cards one at a time.</span>
      </div>
      <div class="scan-grid" id="scan-grid"></div>`;
    renderFoot();
    const video = $("#scan-video", body);
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } } });
      video.srcObject = stream; await video.play();
    } catch (e) {
      body.innerHTML = `<div class="scan-panel"><h3>Camera unavailable</h3><p class="dim">${esc(e.message || e)}. Grant camera permission and reopen.</p></div>`;
      return;
    }
    $("#scan-cap", body).addEventListener("click", () => capture(video));
    $("#scan-auto", body).addEventListener("click", (e) => {
      autoOn = !autoOn; e.currentTarget.textContent = "Auto-capture: " + (autoOn ? "on" : "off");
      e.currentTarget.classList.toggle("active", autoOn);
      if (autoOn) autoTimer = setInterval(() => autoTick(video), 500); else clearInterval(autoTimer);
    });
  }

  async function autoTick(video) {
    if (busy) return;
    const c = grabCardFrame(video); if (!c) return;
    const sh = sharpness(c);
    if (sh < 40) return;                       // too blurry (tune live)
    const h = ahash(c);
    if (hamming(h, lastHash) < 6) return;      // same card still in frame
    lastHash = h; await capture(video, c);
  }

  async function capture(video, pre) {
    if (busy) return; busy = true;
    const cap = $("#scan-cap", body); if (cap) cap.disabled = true;
    try {
      const c = pre || grabCardFrame(video);
      if (!c) return;
      lastHash = ahash(c);
      const dataUrl = c.toDataURL("image/jpeg", 0.8);
      const { matches, blob } = await matchCanvas(c);
      const top = matches[0];
      captured.unshift({ id: Date.now() + "" + captured.length, dataUrl, blob, matches,
        chosen: top && top.score >= AUTO_ACCEPT ? top.natural_key : (top ? top.natural_key : null),
        auto: !!(top && top.score >= AUTO_ACCEPT) });
      renderGrid(); renderFoot();
    } catch (e) { ctx.toast("Match failed: " + (e.message || e)); }
    finally { busy = false; const b = $("#scan-cap", body); if (b) b.disabled = false; }
  }

  function renderGrid() {
    const grid = $("#scan-grid", body); if (!grid) return;
    grid.innerHTML = captured.map((it) => {
      const top = it.matches[0];
      const cls = !top ? "miss" : top.score >= AUTO_ACCEPT ? "ok" : "low";
      return `<div class="scap ${cls}" data-id="${it.id}">
        <img src="${it.dataUrl}" alt="">
        <div class="scap-m">
          <div class="scap-name">${top ? esc(top.name) : "no match"}</div>
          <div class="scap-sub dim">${top ? esc((top.set_name || "") + (top.number ? " · #" + top.number : "")) : "try again"}</div>
          <div class="scap-score num ${cls}">${top ? Math.round(top.score * 100) + "%" : "—"}</div>
        </div>
        <button class="scap-x" data-rm="${it.id}" aria-label="Remove">${ico("i-x", "s")}</button>
        ${top ? `<button class="scap-fix" data-fix="${it.id}">Fix</button>` : ""}
      </div>`;
    }).join("");
    grid.querySelectorAll("[data-rm]").forEach((b) => b.addEventListener("click", () => {
      const i = captured.findIndex((x) => x.id === b.dataset.rm); if (i >= 0) captured.splice(i, 1); renderGrid(); renderFoot();
    }));
    grid.querySelectorAll("[data-fix]").forEach((b) => b.addEventListener("click", () => openFix(b.dataset.fix)));
  }

  // Reassign a capture to one of its other candidate matches, or search inventory.
  function openFix(id) {
    const it = captured.find((x) => x.id === id); if (!it) return;
    const alts = it.matches.slice(0, 5).map((m) => `<button class="fix-opt" data-k="${esc(m.natural_key)}">
      <span>${esc(m.name)}</span><span class="dim">${esc(m.set_name || "")} · ${Math.round(m.score * 100)}%</span></button>`).join("");
    const dlg = document.createElement("div"); dlg.className = "scan-fix";
    dlg.innerHTML = `<div class="scan-fix-card"><h4>Pick the right card</h4>${alts}
      <input type="search" id="fix-q" placeholder="…or search your inventory">
      <div id="fix-res"></div><button class="ghost" id="fix-cancel">Cancel</button></div>`;
    ov.appendChild(dlg);
    const pick = (k) => { it.chosen = k; it.auto = false; dlg.remove(); renderGrid(); };
    dlg.querySelectorAll(".fix-opt").forEach((b) => b.addEventListener("click", () => pick(b.dataset.k)));
    $("#fix-cancel", dlg).addEventListener("click", () => dlg.remove());
    $("#fix-q", dlg).addEventListener("input", (e) => {
      const q = e.target.value.trim().toLowerCase(); const res = $("#fix-res", dlg);
      if (q.length < 2) { res.innerHTML = ""; return; }
      res.innerHTML = ctx.rows.filter((r) => ((r.name || "") + " " + (r.set_name || "")).toLowerCase().includes(q)).slice(0, 6)
        .map((r) => `<button class="fix-opt" data-k="${esc(r.natural_key)}"><span>${esc(r.name)}</span><span class="dim">${esc(r.set_name || "")}</span></button>`).join("");
      res.querySelectorAll(".fix-opt").forEach((b) => b.addEventListener("click", () => pick(b.dataset.k)));
    });
  }

  function renderFoot() {
    const ready = captured.filter((x) => x.chosen);
    foot.innerHTML = `<span class="dim">${captured.length} captured · <b>${ready.length}</b> matched → <b>${condition}</b></span>
      <button class="cta" id="scan-commit" ${ready.length ? "" : "disabled"}>Save ${ready.length} card${ready.length === 1 ? "" : "s"}</button>`;
    $("#scan-commit", foot)?.addEventListener("click", commit);
  }

  async function commit() {
    const ready = captured.filter((x) => x.chosen);
    if (!ready.length) return;
    const btn = $("#scan-commit", foot); btn.disabled = true; btn.textContent = "Saving…";
    let ok = 0;
    const byKey = new Map(ctx.rows.map((r) => [r.natural_key, r]));
    for (const it of ready) {
      const row = byKey.get(it.chosen); if (!row) continue;
      try {
        const okPhoto = await ctx.uploadScanPhoto(row, it.blob);
        const patch = ctx.derivePricePatch(row, { condition });
        patch.tags = (row.tags || []).filter((t) => t !== "not-nm");
        await ctx.save(row, patch);
        if (okPhoto) ok++;
      } catch (e) { /* continue */ }
    }
    ctx.toast(`Saved ${ok} card${ok === 1 ? "" : "s"} as ${condition} with photos`);
    captured.length = 0; renderGrid(); renderFoot();
    ctx.reload?.();
  }

  function close() {
    if (autoTimer) clearInterval(autoTimer);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    ov.remove();
  }
}
