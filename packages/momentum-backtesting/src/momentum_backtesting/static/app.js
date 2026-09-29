"use strict";

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------
const GROUP_ORDER = {
  etf: ["Broad", "Sector", "Thematic", "Commodity", "International", "Debt"],
  stock: ["Current member", "Former member", "Commodity", "Debt"],
  custom_index: ["Official (NSE)", "Custom", "Commodity", "International", "Debt"],
};
const UNIVERSE_PRESETS = {
  etf: [
    ["core", "Core"],
    ["all", "All"],
    ["equity", "Equity only"],
    ["none", "None"],
  ],
  stock: [
    ["core", "Current members"],
    ["all", "All ever-members (recommended)"],
    ["none", "None"],
  ],
  custom_index: [
    ["all", "All (recommended)"],
    ["official", "Official (NSE) only"],
    ["custom", "Custom only"],
    ["none", "None"],
  ],
};
const LOOKBACK_PRESETS = {
  equal: [[1, 1], [4, 1], [13, 1], [26, 1], [52, 1]],
  recency: [[1, 1.5], [4, 1.25], [13, 1], [26, 1], [52, 0.8]],
  long: [[4, 1], [13, 1], [26, 1], [52, 1]],
  short: [[1, 1], [4, 1], [13, 1]],
};
const RUN_COLORS = ["#8b5cf6", "#10b981", "#ef4444", "#0ea5e9", "#d946ef", "#84cc16", "#f97316", "#64748b"];
const MAX_RUNS = 12;

let activeDataset = "etf";
let activeView = "backtest";
let activeResultTab = "overview";
let metaByDataset = {}; // dataset -> /api/meta response, fetched lazily and cached per tab
let lastResultByDataset = {}; // dataset -> { result, config } of its last successful run
let meta = null; // always metaByDataset[activeDataset] - kept as a bare global so the rest of
                  // this file (largely dataset-agnostic) can keep reading `meta` directly
let lastResult = null;
let lastConfig = null;
let runs = []; // run history for the active dataset (see loadRunsFor/saveRuns)
let compareRunId = null;

// Momentum Scores page (TODO.md 3.9.16): a live/current-state snapshot, not a backtest config+
// run dataset, so it's fetched once and cached here rather than going through
// metaByDataset/lastResultByDataset (which key on a backtest's own request/result shape).
let momentumScoresData = null;
let scoreDetailTrigger = null;

// Custom Index only: whether the main chart's Rotations hover includes stock-level (inner)
// detail (`innerEventLine`/`innerHoldingsLine`, below) or stays category-only. A display
// preference, not a backtest parameter - it never goes into `mbt.config.*` (readConfig/
// applyConfig) or the request body, so it survives dataset switches and doesn't get bundled
// into a saved run's config. Defaults ON: 3.9.7 already shipped the coincident-trade version of
// this unconditionally, so ON preserves that behaviour and this toggle is purely the requested
// escape hatch for when the now-denser tooltip (see innerHoldingsLine) gets in the way.
let showStockHover = (() => {
  try {
    const saved = localStorage.getItem("mbt.showStockHover");
    return saved === null ? true : JSON.parse(saved);
  } catch {
    return true;
  }
})();

// Sidebar accordion (TODO.md 3.9.14): a per-viewer display preference, same storage pattern as
// showStockHover above - persisted collapse state per panel id, never folded into mbt.config.*.
// Default open: universe, period, portfolio (the most-tuned controls this session's own use of
// the tool bears out). Default collapsed: ranking, crash, execution (set-and-forget for most
// sessions). "broad" and "inner-rotation" are deliberately excluded from persistence - both are
// already dataset-conditionally hidden/shown (see syncDependentFields), and reset to expanded on
// every hidden->visible reveal rather than remembering a manual collapse across tab switches.
const PANEL_DEFAULT_COLLAPSED = { universe: true, ranking: true, crash: true, execution: true };
let panelCollapsed = (() => {
  try {
    return JSON.parse(localStorage.getItem("mbt.panelCollapsed") || "null") || {};
  } catch {
    return {};
  }
})();

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------
const inr = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
function rupees(v) {
  if (v == null) return "–";
  const sign = v < 0 ? "-" : "";
  return `${sign}₹${inr.format(Math.abs(v))}`;
}
function rupeesShort(v) {
  if (v == null) return "–";
  const a = Math.abs(v), sign = v < 0 ? "-" : "";
  if (a >= 1e7) return `${sign}₹${(a / 1e7).toFixed(2)} cr`;
  if (a >= 1e5) return `${sign}₹${(a / 1e5).toFixed(2)} L`;
  return rupees(v);
}
function pct(v, digits = 1, sign = false) {
  if (v == null || Number.isNaN(v)) return "–";
  const s = (v * 100).toFixed(digits) + "%";
  return sign && v > 0 ? "+" + s : s;
}
function num(v, digits = 1) {
  return v == null || Number.isNaN(v) ? "–" : Number(v).toFixed(digits);
}
function fmtDate(iso) {
  if (!iso) return "–";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function signClass(v) {
  return v == null ? "" : v > 0 ? "good" : v < 0 ? "bad" : "";
}
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Trades/timeline/rotations/instruments identify a stock by its raw company_id (e.g. "C0042") -
// the same id the engine ranks and trades on. `lastResult.companies` (present only for
// dataset="stock") maps that id to the real company name; ETF results carry no `companies` map,
// so this falls back to the id unchanged (ETF names are already human-readable). Use this ONLY
// for what's rendered on screen - the raw id stays the CSV/sort/search/chart-series key.
function displayName(id) {
  return (lastResult && lastResult.companies && lastResult.companies[id]) || id;
}

// Custom Index only: `lastResult.inner_categories[categoryName]` (present only for
// dataset="custom_index", see api.py's _inner_category_detail) is that category's own
// within-category stock rotation - `trades` (raw BUY/SELL/... rows, same shape the outer
// chart's Rotations hover already reads) and `holdings_now` (what it holds as of the backtest's
// own latest week). Inner trades identify a stock by its raw NSE ticker (e.g. "DIVISLAB") - this
// dataset has no company_id-style id/name split the way stock mode does (see api.py's
// _inner_category_detail docstring), so `lastResult.companies` never has an entry for one and
// displayName() already falls back to the raw ticker unchanged - same convention stock mode
// itself falls back to when a name isn't known.
function innerDetailFor(categoryName) {
  return (lastResult && lastResult.inner_categories && lastResult.inner_categories[categoryName]) || null;
}
function innerHoldingsText(categoryName) {
  const inner = innerDetailFor(categoryName);
  if (!inner || !inner.holdings_now.length) return "";
  return inner.holdings_now.map((h) => `${displayName(h.asset)} ${pct(h.share, 0)}`).join(", ");
}
function innerTradesOnWeek(categoryName, week) {
  const inner = innerDetailFor(categoryName);
  if (!inner || !week) return [];
  return inner.trades.filter((t) => t.week === week);
}

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------
function datasetLabel(dataset) {
  return { etf: "ETF", stock: "Nifty 50 stock", custom_index: "category", broad: "Broad Momentum" }[dataset] || dataset;
}

function dataRangeText() {
  const range = `Data ${fmtDate(meta.first_week)} → ${fmtDate(meta.last_week)}`;
  // "broad" has no fixed instrument count to report (see _broad_meta's docstring - what's
  // eligible changes every quarter) - showing "0 instruments" would read as a bug, not a design.
  return activeDataset === "broad" ? range : `${range} · ${meta.instruments.length} instruments`;
}

async function fetchMeta(dataset) {
  const res = await fetch(`/api/meta?dataset=${dataset}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body.detail || res.statusText);
  return body;
}

async function init() {
  // The URL hash (if any) carries the full config of the run that produced it, including which
  // dataset was active - restore that tab rather than always booting on ETFs.
  const fromHash = decodeHash();
  activeDataset = fromHash && ["stock", "custom_index", "broad"].includes(fromHash.dataset) ? fromHash.dataset : "etf";
  runs = loadRunsFor(activeDataset);
  $("#strategy-select").value = activeDataset;

  try {
    meta = await fetchMeta(activeDataset);
    metaByDataset[activeDataset] = meta;
  } catch (err) {
    setStatus(`Couldn't load data: ${err.message}`, true);
    $("#data-range").textContent = "No data";
    return;
  }
  $("#data-range").textContent = dataRangeText();
  $("#header-data-range").textContent = dataRangeText();
  buildUniverse();
  buildBenchmarks();
  bindEvents();
  initPanelAccordion();
  applyConfig(initialConfig(true));
  renderRuns();
  updateStrategySummary();
  if (window.matchMedia("(max-width: 900px)").matches) {
    document.body.classList.remove("settings-open");
    $("#settings-toggle").setAttribute("aria-expanded", "false");
  }
  syncMobileControls();
  if (typeof Plotly === "undefined") {
    setStatus("The chart library didn't load (it's downloaded once from the internet). Check your connection and reload.", true);
  }
}

async function switchDataset(dataset) {
  if (dataset === activeDataset) return;
  activeDataset = dataset;
  $("#strategy-select").value = dataset;
  runs = loadRunsFor(dataset);
  compareRunId = null;

  if (!metaByDataset[dataset]) {
    setStatus(`Loading ${datasetLabel(dataset)} data…`);
    try {
      metaByDataset[dataset] = await fetchMeta(dataset);
    } catch (err) {
      setStatus(`Couldn't load data: ${err.message}`, true);
      return;
    }
  }
  meta = metaByDataset[dataset];
  $("#data-range").textContent = dataRangeText();
  $("#header-data-range").textContent = dataRangeText();
  buildUniverse();
  buildBenchmarks();

  // Reshape the same one-screen form and reuse the same results area: if this tab already has a
  // run from earlier in the session, bring it straight back (form + results together, so they
  // never show a mismatched pair); otherwise reset to that dataset's own defaults/last-saved
  // config and wait for a new run, exactly like a fresh page load for it.
  const saved = lastResultByDataset[dataset];
  if (saved) {
    applyConfig(saved.config);
    lastResult = saved.result;
    lastConfig = saved.config;
    $("#results").hidden = false;
    render(saved.result, saved.config);
    setStatus("");
  } else {
    applyConfig(initialConfig(false));
    lastResult = null;
    lastConfig = null;
    $("#results").hidden = true;
    showEmptyState();
    if (window.matchMedia("(max-width: 900px)").matches) {
      document.body.classList.add("settings-open");
      $("#settings-toggle").setAttribute("aria-expanded", "true");
    }
  }
  renderRuns();
  updateRunState();
  if (activeView === "saved_runs") renderRuns($("#saved-runs-content"));
}

async function showAppView(view) {
  activeView = view;
  if (view !== "momentum_scores") $("#score-detail-panel").hidden = true;
  $$("#app-tabs button").forEach((button) => {
    const selected = button.dataset.view === view;
    button.classList.toggle("active", selected);
    if (selected) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
  });
  $(".layout").hidden = view !== "backtest";
  $("#momentum-scores-view").hidden = view !== "momentum_scores";
  $("#saved-runs-view").hidden = view !== "saved_runs";
  $("#context-bar").hidden = view === "momentum_scores";
  $("#settings-toggle").hidden = view !== "backtest";
  if (view === "momentum_scores") await loadMomentumScores();
  if (view === "saved_runs") renderRuns($("#saved-runs-content"));
  if (view === "backtest" && lastResult) showTab(activeResultTab);
  syncMobileControls();
}

function defaultConfig() {
  const d = meta.defaults;
  // The whole point of the stock dataset is to avoid survivorship bias, so it must default to
  // EVERY company that has ever been a Nifty 50 member (has_data is always true for stocks) -
  // not just today's constituents. Defaulting to only-current would silently defeat that.
  // Custom Index defaults to every resolvable category too - the diversification this tab
  // exists for comes from the outer top_n cap holding only N of them at once, not from the user
  // pre-narrowing the ranked pool (see the "Custom Index" design note at the top of
  // categories/compose.py).
  // "broad" has no per-instrument picker at all (see buildUniverse) - the backend still
  // requires a non-empty `universe` list, so a fixed sentinel is sent and simply ignored
  // server-side (see api._broad_backtest).
  const universe = activeDataset === "broad"
    ? ["*"]
    : activeDataset === "stock" || activeDataset === "custom_index"
    ? meta.instruments.filter((i) => i.has_data).map((i) => i.name)
    : meta.instruments.filter((i) => i.include === "core" && i.has_data).map((i) => i.name);
  return {
    dataset: activeDataset,
    universe,
    start: d.start,
    end: meta.last_week,
    lookbacks: d.lookbacks,
    weights: d.lookbacks.map(() => 1),
    top_n: d.top_n,
    exit_rank: d.exit_rank,
    portfolio: d.portfolio,
    entry: d.entry,
    max_position: d.max_position,
    max_category: d.max_category ?? null,
    max_stock_price: d.max_stock_price ?? null,
    cap_band: d.cap_band,
    momentum_sizing: d.momentum_sizing ?? false,
    momentum_sizing_window: d.momentum_sizing_window ?? 10,
    momentum_sizing_floor: d.momentum_sizing_floor ?? 0,
    defensive: d.defensive,
    filter_lookback: d.filter_lookback,
    cost_pct: d.cost_pct,
    signal_delay: d.signal_delay,
    track: d.track || "index",
    execution: d.execution || "fri_close",
    tax: false,
    slab_rate: 0.3,
    benchmark: d.benchmark,
    score: d.score || "ranksum",
    voladj_skip_recent_month: d.voladj_skip_recent_month ?? true,
    rebalance: d.rebalance || "weekly",
    cost_model: d.cost_model || "flat",
    capital: d.capital || 1000000,
    slippage_bps: d.slippage_bps ?? 5,
    inner_top_n: d.inner_top_n ?? 2,
    inner_exit_rank: d.inner_exit_rank ?? 8,
    commodity_copies: d.commodity_copies ?? 1,
    debt_copies: d.debt_copies ?? 1,
    broad_category_mode: d.broad_category_mode ?? "on",
    broad_pool_top_n: d.broad_pool_top_n ?? 200,
    broad_pool_exit_rank: d.broad_pool_exit_rank ?? 300,
    broad_coverage_floor: d.broad_coverage_floor ?? 0.4,
    broad_category_top_n: d.broad_category_top_n ?? 4,
    broad_category_exit_rank: d.broad_category_exit_rank ?? 8,
    broad_picks_per_category: d.broad_picks_per_category ?? 2,
    broad_off_top_n: d.broad_off_top_n ?? 10,
    broad_off_exit_rank: d.broad_off_exit_rank ?? 20,
  };
}

// `preferHash`: only the very first page load should adopt a #cfg= hash from the URL - once the
// user has switched tabs, re-reading a stale hash (still describing whichever dataset was active
// when that hash was written) would splice one dataset's universe/instrument names onto the
// other. Tab switches always fall back to that dataset's own last-saved config instead.
function initialConfig(preferHash) {
  if (preferHash) {
    const fromHash = decodeHash();
    if (fromHash) return { ...defaultConfig(), ...fromHash };
  }
  try {
    const saved = JSON.parse(localStorage.getItem(`mbt.config.${activeDataset}`) || "null");
    if (saved) return { ...defaultConfig(), ...saved };
  } catch { /* ignore */ }
  return defaultConfig();
}

function decodeHash() {
  const m = location.hash.match(/cfg=([^&]+)/);
  if (!m) return null;
  try { return JSON.parse(decodeURIComponent(escape(atob(m[1])))); } catch { return null; }
}
function encodeHash(cfg) {
  return "cfg=" + btoa(unescape(encodeURIComponent(JSON.stringify(cfg))));
}

// ---------------------------------------------------------------------------------------------
// Sidebar: universe
// ---------------------------------------------------------------------------------------------
function buildUniversePresetChips() {
  const box = $("#universe-presets");
  box.innerHTML = UNIVERSE_PRESETS[activeDataset]
    .map(([key, label]) => `<button type="button" data-preset="${key}">${esc(label)}</button>`)
    .join("");
  $$("[data-preset]", box).forEach((b) => b.addEventListener("click", () => applyUniversePreset(b.dataset.preset)));
}

function buildUniverse() {
  // "broad": no per-instrument sidebar picker at all (see api._broad_meta's docstring) - the
  // whole universe section is hidden and #broad-panel (its own settings) is shown instead, see
  // syncDependentFields.
  $("#universe-panel").hidden = activeDataset === "broad";
  if (activeDataset === "broad") return;
  const heading = { etf: "ETFs", stock: "Nifty 50 Stocks", custom_index: "Categories" }[activeDataset];
  $("#universe-heading").innerHTML = `${heading} <span class="count" id="universe-count"></span>`;
  buildUniversePresetChips();
  const root = $("#universe");
  root.innerHTML = "";
  $("#universe-search").value = "";
  const order = GROUP_ORDER[activeDataset];
  const groups = order.filter((g) => meta.instruments.some((i) => i.group === g));
  for (const group of groups) {
    const items = meta.instruments.filter((i) => i.group === group);
    const box = document.createElement("div");
    box.className = "group";
    const note = group === "Debt"
      ? `<span class="group-note">— ranked only in "Debt in ranking" mode</span>`
      : group === "Former member"
      ? `<span class="group-note">— include these too, or you're only testing survivorship-biased winners</span>`
      : group === "Custom"
      ? `<span class="group-note">— hand-curated theme, no official NSE index (see category_extras.csv)</span>`
      : "";
    box.innerHTML = `<label class="group-head"><input type="checkbox" data-group="${esc(group)}"> ${esc(group)} ${note}</label>`;
    for (const inst of items) {
      const label = inst.display_name || inst.name;
      const year = inst.first_week ? Number(inst.first_week.slice(0, 4)) : null;
      const late = year && year > 2016 ? `<span class="badge warn" title="Price history starts ${fmtDate(inst.first_week)}">from ${year}</span>` : "";
      const optional = inst.include === "optional" ? `<span class="badge">optional</span>` : "";
      const turnover = inst.etf_turnover_cr_day != null ? `₹${num(inst.etf_turnover_cr_day, inst.etf_turnover_cr_day < 10 ? 1 : 0)} cr/d` : "";
      const row = document.createElement("label");
      row.className = "etf";
      row.title = inst.note || "";
      row.innerHTML = `<input type="checkbox" value="${esc(inst.name)}" data-member="${esc(group)}" ${inst.has_data ? "" : "disabled"}>
        <span>${esc(label)} ${inst.trade_etf ? `<small>${esc(inst.trade_etf)}</small>` : ""}${late}${optional}</span>
        <span class="meta">${turnover}</span>`;
      box.appendChild(row);
    }
    root.appendChild(box);
  }
  root.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.group) {
      $$(`input[data-member="${CSS.escape(t.dataset.group)}"]:not(:disabled)`).forEach((c) => (c.checked = t.checked));
    }
    syncUniverseState();
  });
}

function selectedUniverse() {
  return $$("#universe input[data-member]:checked").map((c) => c.value);
}
function setUniverse(names) {
  const set = new Set(names);
  $$("#universe input[data-member]").forEach((c) => (c.checked = set.has(c.value) && !c.disabled));
  syncUniverseState();
}
function syncUniverseState() {
  for (const head of $$("#universe input[data-group]")) {
    const members = $$(`input[data-member="${CSS.escape(head.dataset.group)}"]:not(:disabled)`);
    const on = members.filter((m) => m.checked).length;
    head.checked = on > 0 && on === members.length;
    head.indeterminate = on > 0 && on < members.length;
  }
  const chosen = selectedUniverse();
  const total = meta.instruments.filter((i) => i.has_data).length;
  $("#universe-count").textContent = `${chosen.length} of ${total}`;
  validateLive();
}

function filterUniverse() {
  const query = $("#universe-search").value.trim().toLowerCase();
  $$("#universe .group").forEach((group) => {
    let visible = 0;
    $$(".etf", group).forEach((row) => {
      row.hidden = !!query && !row.textContent.toLowerCase().includes(query);
      if (!row.hidden) visible++;
    });
    group.hidden = !!query && !visible;
  });
}

function applyUniversePreset(name) {
  const pick = {
    core: (i) => i.include === "core",
    all: () => true,
    equity: (i) => ["Broad", "Sector", "Thematic"].includes(i.group),
    official: (i) => i.group === "Official (NSE)",
    custom: (i) => i.group === "Custom",
    none: () => false,
  }[name];
  setUniverse(meta.instruments.filter(pick).map((i) => i.name));
}

function buildBenchmarks() {
  const sel = $("#benchmark");
  // ETF mode: benchmarks are just the tradeable instruments themselves. Stock and Custom Index
  // modes have no "instrument" benchmarks - a stock TRI column or a category rotation isn't a
  // sensible thing to benchmark other categories/stocks against, so the API hands back an
  // explicit `benchmarks` list instead (Custom Index's is just ["Nifty 50"] - see api.py's
  // _custom_index_meta).
  const names = activeDataset === "stock" || activeDataset === "custom_index" || activeDataset === "broad"
    ? meta.benchmarks
    : meta.instruments.filter((i) => i.has_data).map((i) => i.name);
  sel.innerHTML = names.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join("");
}

// ---------------------------------------------------------------------------------------------
// Sidebar: lookbacks, form read/write
// ---------------------------------------------------------------------------------------------
function setLookbacks(rows) {
  const body = $("#lookbacks");
  body.innerHTML = "";
  for (const [weeks, weight] of rows) addLookbackRow(weeks, weight);
}
function addLookbackRow(weeks = 8, weight = 1) {
  const tr = document.createElement("tr");
  tr.innerHTML = `<td><input type="number" class="lb-weeks" min="1" max="260" step="1" value="${weeks}"></td>
    <td><input type="number" class="lb-weight" min="0" max="10" step="0.05" value="${weight}"></td>
    <td><button type="button" title="Remove">×</button></td>`;
  tr.querySelector("button").addEventListener("click", () => { tr.remove(); validateLive(); });
  $("#lookbacks").appendChild(tr);
}
function readLookbacks() {
  return $$("#lookbacks tr").map((tr) => [
    Number(tr.querySelector(".lb-weeks").value),
    Number(tr.querySelector(".lb-weight").value),
  ]);
}

function radio(name) {
  return $(`input[name="${name}"]:checked`).value;
}
function setRadio(name, value) {
  const el = $(`input[name="${name}"][value="${value}"]`);
  if (el) el.checked = true;
}

function readConfig() {
  const lb = readLookbacks();
  const broad = activeDataset === "broad";
  return {
    dataset: activeDataset,
    universe: broad ? ["*"] : selectedUniverse(),
    start: $("#start").value,
    end: $("#end").value || null,
    lookbacks: lb.map((r) => r[0]),
    weights: lb.map((r) => r[1]),
    top_n: Number($("#top_n").value),
    exit_rank: Number($("#exit_rank").value),
    portfolio: radio("portfolio"),
    entry: radio("entry"),
    max_position: Number($("#max_position").value) > 0 ? Number($("#max_position").value) / 100 : null,
    // Broad Momentum only; the other datasets never show these fields, so they send null (0 = off).
    max_category: broad && Number($("#max_category").value) > 0 ? Number($("#max_category").value) / 100 : null,
    max_stock_price: broad && Number($("#max_stock_price").value) > 0 ? Number($("#max_stock_price").value) : null,
    cap_band: Number($("#cap_band").value) / 100,
    momentum_sizing: $("#momentum_sizing").checked,
    momentum_sizing_window: Number($("#momentum_sizing_window").value),
    momentum_sizing_floor: Number($("#momentum_sizing_floor").value) / 100,
    defensive: radio("defensive"),
    filter_lookback: Number($("#filter_lookback").value),
    cost_pct: Number($("#cost_pct").value),
    signal_delay: Number($("#signal_delay").value),
    track: $("#track").value,
    execution: $("#execution").value,
    tax: $("#tax").checked,
    slab_rate: Number($("#slab_rate").value),
    benchmark: $("#benchmark").value,
    // score/cost_model: the selectors are now shown for every dataset (TODO.md 3.9.15 - all
    // four already thread these through server-side), so the DOM value is read directly instead
    // of being forced to the "off" default for a subset of datasets.
    score: $("#score").value,
    voladj_skip_recent_month: $("#voladj_skip_recent_month").checked,
    rebalance: $("#rebalance").value,
    cost_model: $("#cost_model").value,
    capital: Number($("#capital").value) || 1000000,
    slippage_bps: Number($("#slippage_bps").value),
    inner_top_n: Number($("#inner_top_n").value),
    inner_exit_rank: Number($("#inner_exit_rank").value),
    commodity_copies: Number($("#commodity_copies").value) || 1,
    debt_copies: Number($("#debt_copies").value) || 1,
    broad_category_mode: broad ? radio("broad_category_mode") : "on",
    broad_pool_top_n: Number($("#broad_pool_top_n").value) || 200,
    broad_pool_exit_rank: Number($("#broad_pool_exit_rank").value) || 300,
    broad_coverage_floor: Number($("#broad_coverage_floor").value) / 100,
    broad_category_top_n: Number($("#broad_category_top_n").value) || 4,
    broad_category_exit_rank: Number($("#broad_category_exit_rank").value) || 8,
    broad_picks_per_category: Number($("#broad_picks_per_category").value) || 2,
    broad_off_top_n: Number($("#broad_off_top_n").value) || 10,
    broad_off_exit_rank: Number($("#broad_off_exit_rank").value) || 20,
  };
}

function applyConfig(cfg) {
  setUniverse(cfg.universe);
  $("#start").value = cfg.start;
  $("#end").value = cfg.end || meta.last_week;
  const weights = cfg.weights || cfg.lookbacks.map(() => 1);
  setLookbacks(cfg.lookbacks.map((w, i) => [w, weights[i] ?? 1]));
  $("#top_n").value = cfg.top_n;
  $("#exit_rank").value = cfg.exit_rank;
  setRadio("portfolio", cfg.portfolio);
  setRadio("entry", cfg.entry);
  $("#max_position").value = cfg.max_position ? Math.round(cfg.max_position * 100) : 0;
  $("#max_category").value = cfg.max_category ? Math.round(cfg.max_category * 100) : 0;
  $("#max_stock_price").value = cfg.max_stock_price || 0;
  $("#cap_band").value = Math.round((cfg.cap_band ?? 0.05) * 100);
  $("#momentum_sizing").checked = !!cfg.momentum_sizing;
  $("#momentum_sizing_window").value = cfg.momentum_sizing_window ?? 10;
  $("#momentum_sizing_floor").value = Math.round((cfg.momentum_sizing_floor ?? 0) * 100);
  setRadio("defensive", cfg.defensive);
  $("#filter_lookback").value = cfg.filter_lookback;
  $("#cost_pct").value = cfg.cost_pct;
  $("#signal_delay").value = String(cfg.signal_delay);
  $("#track").value = cfg.track || "index";
  $("#execution").value = cfg.execution || "fri_close";
  $("#tax").checked = !!cfg.tax;
  $("#slab_rate").value = String(cfg.slab_rate);
  $("#benchmark").value = cfg.benchmark;
  $("#score").value = cfg.score || "ranksum";
  $("#voladj_skip_recent_month").checked = cfg.voladj_skip_recent_month ?? true;
  $("#rebalance").value = cfg.rebalance || "weekly";
  $("#cost_model").value = cfg.cost_model || "flat";
  $("#capital").value = cfg.capital || 1000000;
  $("#slippage_bps").value = cfg.slippage_bps ?? 5;
  $("#inner_top_n").value = cfg.inner_top_n ?? 2;
  $("#inner_exit_rank").value = cfg.inner_exit_rank ?? 8;
  $("#commodity_copies").value = cfg.commodity_copies ?? 1;
  $("#debt_copies").value = cfg.debt_copies ?? 1;
  setRadio("broad_category_mode", cfg.broad_category_mode ?? "on");
  $("#broad_pool_top_n").value = cfg.broad_pool_top_n ?? 200;
  $("#broad_pool_exit_rank").value = cfg.broad_pool_exit_rank ?? 300;
  $("#broad_coverage_floor").value = Math.round((cfg.broad_coverage_floor ?? 0.4) * 100);
  $("#broad_category_top_n").value = cfg.broad_category_top_n ?? 4;
  $("#broad_category_exit_rank").value = cfg.broad_category_exit_rank ?? 8;
  $("#broad_picks_per_category").value = cfg.broad_picks_per_category ?? 2;
  $("#broad_off_top_n").value = cfg.broad_off_top_n ?? 10;
  $("#broad_off_exit_rank").value = cfg.broad_off_exit_rank ?? 20;
  syncDependentFields();
  validateLive();
}

function syncDependentFields() {
  const buffer = radio("portfolio") === "buffer";
  $("#entry-options").hidden = !buffer;
  $("#cap-options").style.display = buffer ? "" : "none";
  $("#cap_band").disabled = !(Number($("#max_position").value) > 0 || Number($("#max_category").value) > 0);
  $("#filter-weeks").style.display = radio("defensive") === "filter" ? "" : "none";
  $("#slab_rate").disabled = !$("#tax").checked;

  const stock = activeDataset === "stock";
  const customIndex = activeDataset === "custom_index";
  const broad = activeDataset === "broad";
  $("#max-position-label").textContent =
    customIndex ? "Max per category %" : broad ? "Max per stock %" : stock ? "Max per stock %" : "Max per ETF %";
  // Broad only: a category cap (its stocks together; needs categories, so ON mode) and a share-
  // price ceiling. Both sit in the same row as the per-stock cap, which is buffer-rule only.
  const broadOn = broad && radio("broad_category_mode") === "on";
  $("#category-cap-field").hidden = !broadOn;
  $("#price-cap-field").hidden = !broad;
  $("#inner-rotation-panel").hidden = !customIndex;
  // Win-rate position sizing (buffer rule only): already backend-generic for every dataset via
  // _config_kwargs (etf/stock/custom_index) and run_broad_backtest's own Config() call (broad,
  // wired TODO.md 3.9.15) - was arbitrarily UI-gated to Custom Index only. Shown for all four now.
  $("#momentum-sizing-row").hidden = false;
  $("#momentum-sizing-options").hidden = false;
  const sizingOn = $("#momentum_sizing").checked;
  $("#momentum_sizing_window").disabled = !sizingOn;
  $("#momentum_sizing_floor").disabled = !sizingOn;

  // "Broad Momentum" settings panel: its own universe/rank-table section, category-mode ON/OFF
  // sub-panels, and the generic Top N/exit-rank row (superseded by the broad panel's own
  // top_n/exit_rank equivalents - see api._broad_backtest, which ignores req.top_n/exit_rank
  // entirely for this dataset) hidden instead of left as dead controls. Crash protection/tax
  // stay hidden too (TODO.md 3.9.15 audit, bucket (c) - see run_broad_backtest's own docstring:
  // CASH never enters this dataset's external rank table, so "Debt in ranking" would silently
  // do nothing, and tax has no equivalent stock/gold_silver classification for the 755-name
  // Total Market universe) - genuinely dataset-specific, not the same arbitrary gating as the
  // fields above.
  $("#broad-panel").hidden = !broad;
  if (broad) {
    const on = radio("broad_category_mode") === "on";
    $("#broad-on-options").hidden = !on;
    $("#broad-off-options").hidden = on;
  }
  $("#rank-rule-row").hidden = broad;
  $("#crash-protection-panel").hidden = broad;
  $("#protection-group-title").hidden = broad;
  $("#tax-row").hidden = broad;

  // Ranking rule: score/voladj_skip_recent_month are backend-generic for every dataset (all four
  // already thread `score` through _config_kwargs or run_broad_backtest's own Config() call) -
  // was arbitrarily UI-gated to stock/broad only (ETF/Custom Index were forced to "ranksum" in
  // readConfig). voladj AND blend both feed through _compute_ranks_voladj internally (see
  // engine.py), so voladj_skip_recent_month affects both - shown for either, not just voladj.
  $("#score-row").hidden = false;
  const score = $("#score").value;
  $("#lookback-panel").hidden = score !== "ranksum";
  $("#voladj-skip-row").hidden = !(score === "voladj" || score === "blend");

  // Execution & tax: cost model (flat % vs itemised STT/stamp duty/fees/slippage/DP) is
  // backend-generic for every dataset the same way (_config_kwargs for etf/stock/custom_index,
  // run_broad_backtest's own Config() call for broad, wired TODO.md 3.9.15) - was arbitrarily
  // UI-gated to stock only. Itemised swaps cost_pct for capital/slippage inputs regardless of
  // dataset.
  $("#cost-model-row").hidden = false;
  const costModel = $("#cost_model").value;
  const itemised = costModel === "itemised";
  $("#cost-pct-field").hidden = itemised;
  $("#capital-field").hidden = !itemised;
  $("#slippage-field").hidden = !itemised;

  // Stock, Custom Index and Broad Momentum backtests have no ETF-vs-index track/fill-time
  // concept at all - each ranked column already IS the traded thing (a stock, a category's own
  // inner-rotation equity curve, or - for broad - a stock/atomic).
  $("#trackfill-row").hidden = stock || customIndex || broad;

  if (broad) {
    const catOn = radio("broad_category_mode") === "on";
    const catTop = Number($("#broad_category_top_n").value), catExit = Number($("#broad_category_exit_rank").value);
    const picks = Number($("#broad_picks_per_category").value);
    const offTop = Number($("#broad_off_top_n").value), offExit = Number($("#broad_off_exit_rank").value);
    $("#broad-rule-hint").textContent = catOn
      ? `Holds between ${catTop} and ${catExit} categories or standalone assets at once (${catTop} freshly ` +
        `selected, the rest lingering in the buffer), up to ${picks} stock(s) each - up to ` +
        `${catExit * picks} positions.`
      : `Holds between ${offTop} and ${offExit} individual stocks, no category layer.`;
    const stockCap = Number($("#max_position").value), catCap = Number($("#max_category").value);
    const priceCap = Number($("#max_stock_price").value);
    const extra = [];
    if (radio("portfolio") === "buffer") {
      if (stockCap > 0) extra.push(`No stock is bought past ${stockCap}%.`);
      if (catOn && catCap > 0) extra.push(`No category (its stocks together) is bought past ${catCap}%.`);
      const stocksFresh = catOn ? catTop * picks : offTop;
      if (stockCap > 0 && stockCap * stocksFresh < 100) extra.push(`With ${stocksFresh} stocks × ${stockCap}%, only ${stockCap * stocksFresh}% can be invested — the rest waits in cash.`);
      if (catOn && catCap > 0 && catCap * catTop < 100) extra.push(`With ${catTop} categories × ${catCap}%, only ${catCap * catTop}% can be invested — the rest waits in cash.`);
    }
    if (priceCap > 0) extra.push(`Stocks priced above ₹${priceCap.toLocaleString("en-IN")} a share are skipped.`);
    if (extra.length) $("#broad-rule-hint").textContent += ` ${extra.join(" ")}`;
    $("#rule-hint").textContent = "";
  } else {
    const top = Number($("#top_n").value), exit = Number($("#exit_rank").value);
    const cap = Number($("#max_position").value), band = Number($("#cap_band").value);
    const unit = customIndex ? "categories" : stock ? "stocks" : "ETFs";
    const unitOne = customIndex ? "category" : stock ? "stock" : "ETF";
    let hint = buffer
      ? `Holds between ${top} and ${exit} ${unit}: anything bought is kept until its rank passes ${exit}.`
      : `Always ${top} positions; ranks ${top + 1}–${exit} are kept but block a new buy until sold.`;
    if (buffer && cap > 0) {
      hint += ` No ${unitOne} is bought past ${cap}%; one that grows past ${cap + band}% is trimmed back to ${cap}%.`;
      if (top * cap < 100) hint += ` With top ${top} × ${cap}%, only ${top * cap}% can be invested — the rest waits in cash.`;
    }
    $("#rule-hint").textContent = hint;
  }
  const unitOne = customIndex ? "category" : broad ? "stock" : stock ? "stock" : "ETF";
  const maxLb = Math.max(...readLookbacks().map((r) => r[0]).filter((x) => x > 0), 0);
  $("#period-hint").textContent = maxLb
    ? `Ranking needs ${maxLb} weeks of history, so a ${unitOne} joins ${maxLb} weeks after its data starts.`
    : "";

  // Sidebar accordion (TODO.md 3.9.14): "broad" and "inner-rotation" are dataset-conditionally
  // hidden/shown above - reset each to expanded on every hidden->visible reveal (guarded on that
  // specific edge, not re-fired every syncDependentFields() call, so a manual collapse made while
  // staying on the same tab isn't fought on the next keystroke).
  if (broad && !wasBroadPanelVisible) setPanelCollapsed($("#broad-panel"), false);
  wasBroadPanelVisible = broad;
  const innerVisible = customIndex;
  if (innerVisible && !wasInnerRotationVisible) setPanelCollapsed($("#inner-rotation-panel"), false);
  wasInnerRotationVisible = innerVisible;
  updatePanelSummaries();
}

function updatePanelSummaries() {
  const summaries = {
    universe: `${selectedUniverse().length} selected`,
    broad: radio("broad_category_mode") === "on" ? "Category mode" : "Direct stocks",
    period: `${$("#start").value || "Start"} → ${$("#end").value || "End"}`,
    ranking: $("#score").selectedOptions[0]?.textContent || "",
    portfolio: `${radio("portfolio") === "buffer" ? "Buffer" : "Fixed slots"} · ${$("#rebalance").value}`,
    "inner-rotation": `${$("#inner_top_n").value} stocks / category`,
    crash: ({ off: "Off", ranked: "Debt in ranking", filter: "Cash filter" })[radio("defensive")],
    execution: `${$("#cost_model").value === "itemised" ? "Itemised" : `${$("#cost_pct").value}% per side`} · ${$("#benchmark").value || "benchmark"}`,
  };
  $$(".panel").forEach((section) => {
    const header = $(".panel-header", section);
    const key = $(".panel-body", section)?.id.replace(/^panel-body-/, "");
    if (!header || !key) return;
    let summary = $(".panel-summary", header);
    if (!summary) {
      summary = document.createElement("span");
      summary.className = "panel-summary";
      $(".chevron", header).before(summary);
    }
    summary.textContent = summaries[key] || "";
  });
}

let wasBroadPanelVisible = false;
let wasInnerRotationVisible = false;

function setPanelCollapsed(section, collapsed) {
  section.classList.toggle("collapsed", collapsed);
  const header = $(".panel-header", section);
  if (header) header.setAttribute("aria-expanded", String(!collapsed));
}

function initPanelAccordion() {
  $$(".panel").forEach((section) => {
    const body = $(".panel-body", section);
    const header = $(".panel-header", section);
    if (!body || !header) return; // e.g. run-bar isn't a .panel; every real .panel has both
    const id = body.id.replace(/^panel-body-/, "");
    // "broad"/"inner-rotation" are session-only (see syncDependentFields) - never read/write
    // their persisted state, always start expanded, matching their own reveal-reset behaviour.
    const sessionOnly = id === "broad" || id === "inner-rotation";
    const collapsed = sessionOnly ? false : (panelCollapsed[id] ?? PANEL_DEFAULT_COLLAPSED[id] ?? false);
    setPanelCollapsed(section, collapsed);
    header.addEventListener("click", () => {
      const nowCollapsed = !section.classList.contains("collapsed");
      setPanelCollapsed(section, nowCollapsed);
      if (!sessionOnly) {
        panelCollapsed[id] = nowCollapsed;
        try { localStorage.setItem("mbt.panelCollapsed", JSON.stringify(panelCollapsed)); }
        catch { /* storage full/blocked: keep in memory for this session */ }
      }
    });
  });
}

function validate(cfg) {
  if (!cfg.lookbacks.length) return "Add at least one lookback.";
  if (cfg.lookbacks.some((w) => !Number.isInteger(w) || w < 1 || w > 260)) return "Lookbacks must be whole weeks between 1 and 260.";
  if (new Set(cfg.lookbacks).size !== cfg.lookbacks.length) return "Each lookback can appear only once.";
  if (cfg.weights.some((w) => Number.isNaN(w) || w < 0)) return "Weights can't be negative.";
  if (cfg.weights.every((w) => w === 0)) return "At least one weight must be above 0.";
  if (cfg.dataset === "broad") {
    if (cfg.broad_pool_top_n > cfg.broad_pool_exit_rank) return "Pool top N can't be greater than the pool exit rank.";
    if (cfg.broad_category_mode === "on") {
      if (cfg.broad_category_top_n > cfg.broad_category_exit_rank) return "Categories held (fresh) can't be greater than the category exit rank.";
      if (!(cfg.broad_picks_per_category >= 1)) return "Top stocks per category must be at least 1.";
      if (!(cfg.broad_coverage_floor >= 0 && cfg.broad_coverage_floor <= 1)) return "Coverage floor must be between 0 and 100%.";
    } else if (cfg.broad_off_top_n > cfg.broad_off_exit_rank) {
      return "Stocks to hold can't be greater than the exit rank.";
    }
  } else {
    if (!(cfg.top_n >= 1)) return "Top N must be at least 1.";
    if (cfg.exit_rank < cfg.top_n) return `The sell rank must be at least top N (${cfg.top_n}), or new buys would be sold at once.`;
    const includeOf = Object.fromEntries(meta.instruments.map((i) => [i.name, i.include]));
    const ranked = cfg.universe.filter((n) => cfg.defensive === "ranked" || includeOf[n] !== "defensive");
    if (ranked.length < cfg.top_n) {
      return `Only ${ranked.length} ETF(s) will be ranked but top N is ${cfg.top_n}. Select more ETFs or lower top N.`;
    }
  }
  if (cfg.start && cfg.end && cfg.start >= cfg.end) return "The start date must be before the end date.";
  if (cfg.cost_pct < 0) return "Cost can't be negative.";
  if (cfg.max_position != null && !(cfg.max_position > 0 && cfg.max_position <= 1)) return "Max per ETF must be between 1 and 100% (0 = no cap).";
  if (cfg.max_category != null && !(cfg.max_category > 0 && cfg.max_category <= 1)) return "Max per category must be between 1 and 100% (0 = no cap).";
  if (cfg.max_stock_price != null && !(cfg.max_stock_price > 0)) return "Max share price must be a positive amount (0 = no limit).";
  if (cfg.cap_band < 0) return "The trim band can't be negative.";
  if (cfg.cost_model === "itemised" && !(cfg.capital > 0)) return "Capital must be a positive amount.";
  if (cfg.slippage_bps < 0) return "Slippage can't be negative.";
  if (cfg.momentum_sizing && !(cfg.momentum_sizing_window >= 1)) return "Sizing window must be at least 1 trade.";
  if (cfg.momentum_sizing && !(cfg.momentum_sizing_floor >= 0 && cfg.momentum_sizing_floor <= 1)) return "Min size floor must be between 0 and 100%.";
  return "";
}
function validationTarget(problem) {
  if (!problem) return null;
  const match = [
    [/lookback|weight/i, "#lookback-panel"], [/Pool top/i, "#broad_pool_exit_rank"],
    [/Categories held/i, "#broad_category_exit_rank"], [/Top stocks per category/i, "#broad_picks_per_category"],
    [/Coverage floor/i, "#broad_coverage_floor"], [/Stocks to hold/i, "#broad_off_exit_rank"],
    [/Only .*ETF/i, "#universe-panel"], [/Top N must/i, "#top_n"],
    [/sell rank/i, "#exit_rank"], [/start date/i, "#end"],
    [/Cost can/i, "#cost_pct"], [/Max per ETF/i, "#max_position"],
    [/Max per category/i, "#max_category"], [/Max share price/i, "#max_stock_price"],
    [/trim band/i, "#cap_band"], [/Capital/i, "#capital"],
    [/Slippage/i, "#slippage_bps"], [/Sizing window/i, "#momentum_sizing_window"],
    [/Min size floor/i, "#momentum_sizing_floor"],
  ].find(([pattern]) => pattern.test(problem));
  return match ? $(match[1]) : null;
}

function validateLive(reveal = false) {
  if (!meta) return;
  syncDependentFields();
  const problem = validate(readConfig());
  $("#form-error").textContent = problem;
  $$(".field-error").forEach((node) => node.remove());
  $$('[aria-invalid="true"]').forEach((node) => {
    node.removeAttribute("aria-invalid");
    node.removeAttribute("aria-describedby");
  });
  const target = validationTarget(problem);
  if (target) {
    const label = target.closest("label");
    const holder = label || target;
    const error = document.createElement("span");
    error.className = "field-error";
    error.id = "inline-field-error";
    error.textContent = problem;
    holder.insertAdjacentElement("afterend", error);
    if (target.matches("input,select")) {
      target.setAttribute("aria-invalid", "true");
      target.setAttribute("aria-describedby", error.id);
    }
    if (reveal === true) {
      const panel = target.closest(".panel");
      if (panel) setPanelCollapsed(panel, false);
      target.scrollIntoView({ block: "nearest" });
      if (target.matches("input,select")) target.focus();
    }
  }
  $("#run").disabled = !!problem;
  updateRunState();
}

function comparableConfig(cfg) {
  return JSON.stringify(Object.fromEntries(Object.entries(cfg).sort(([a], [b]) => a.localeCompare(b))));
}

function updateRunState() {
  const state = $("#run-state");
  if (!state) return;
  const dirty = !!lastConfig && comparableConfig(readConfig()) !== comparableConfig(lastConfig);
  state.textContent = dirty ? "Settings changed · run again to update results" : lastConfig ? "Results match these settings" : "Ready to run";
  state.classList.toggle("dirty", dirty);
  const badge = $("#result-state");
  if (badge) {
    badge.textContent = dirty ? "Results use previous settings" : "Current settings";
    badge.classList.toggle("dirty", dirty);
  }
  updateStrategySummary();
  syncMobileControls();
}

function updateStrategySummary() {
  if (!meta) return;
  const cfg = readConfig();
  const label = { etf: "ETF rotation", stock: "Nifty 50 stocks", custom_index: "Custom Index", broad: "Broad Momentum" }[cfg.dataset];
  const selection = cfg.dataset === "broad"
    ? (cfg.broad_category_mode === "on" ? `top ${cfg.broad_category_top_n} categories · exit after rank ${cfg.broad_category_exit_rank}` : `top ${cfg.broad_off_top_n} stocks · exit after rank ${cfg.broad_off_exit_rank}`)
    : `top ${cfg.top_n} · exit after rank ${cfg.exit_rank}`;
  const summary = `${cfg.start || "Start"} → ${cfg.end || "End"} · ${cfg.rebalance} · ${selection} · ${cfg.benchmark}`;
  $("#strategy-summary").textContent = summary;
  if ($("#empty-strategy")) $("#empty-strategy").textContent = label;
  if ($("#empty-summary")) $("#empty-summary").textContent = `Test ${summary}. Review the controls, then run to see performance and signals.`;
  $("#empty-run")?.toggleAttribute("disabled", $("#run").disabled);
}

function showEmptyState() {
  const el = $("#status");
  el.className = "status empty-state";
  el.hidden = false;
  el.innerHTML = '<p class="eyebrow">Ready to explore</p><h2 id="empty-strategy"></h2><p id="empty-summary"></p><button type="button" class="primary" id="empty-run">Run with these settings</button>';
  $("#empty-run").addEventListener("click", runBacktest);
  updateStrategySummary();
}

function syncMobileControls() {
  const mobile = window.matchMedia("(max-width: 900px)").matches;
  const open = document.body.classList.contains("settings-open") && activeView === "backtest";
  $("#drawer-backdrop").hidden = !mobile || !open;
  $("#mobile-run").hidden = !mobile || activeView !== "backtest" || open;
  $("#mobile-run").disabled = $("#run").disabled;
  $("#sidebar").setAttribute("role", mobile ? "dialog" : "complementary");
  if (mobile) $("#sidebar").setAttribute("aria-modal", "true"); else $("#sidebar").removeAttribute("aria-modal");
}

function closeSettings() {
  document.body.classList.remove("settings-open");
  $("#settings-toggle").setAttribute("aria-expanded", "false");
  syncMobileControls();
  $("#settings-toggle").focus();
}

function setPeriod(kind) {
  const last = new Date(meta.last_week + "T00:00:00");
  const iso = (d) => d.toISOString().slice(0, 10);
  const yearsBack = (n) => { const d = new Date(last); d.setFullYear(d.getFullYear() - n); return iso(d); };
  const map = {
    full: [meta.first_week, meta.last_week],
    "5y": [yearsBack(5), meta.last_week],
    "3y": [yearsBack(3), meta.last_week],
    "2017-2021": ["2017-01-01", "2021-12-31"],
    "2022-now": ["2022-01-01", meta.last_week],
  }[kind];
  $("#start").value = map[0];
  $("#end").value = map[1];
  validateLive();
}

// ---------------------------------------------------------------------------------------------
// Momentum Scores page (TODO.md 3.9.16) -- live/current-state snapshot, own render path (not
// render()/renderSignal() etc, which are all shaped around a backtest Result). Shares the
// sortable table renderer with the backtest views, with stock-specific filters and details.
// ---------------------------------------------------------------------------------------------
const LOOKBACK_LABELS = { 4: "4W", 13: "13W", 26: "26W" };
function lookbackLabel(k) {
  return LOOKBACK_LABELS[k] || `${k}w`;
}
function msBand(score) {
  if (score == null || Number.isNaN(score)) return "";
  return score <= 40 ? "band-red" : score <= 60 ? "band-yellow" : "band-green";
}
function msScoreCell(v) {
  if (v == null || Number.isNaN(v)) return "–";
  return `<span class="ms-score ${msBand(v)}">${Math.round(v)}</span>`;
}
function withScoreColumns(lookbacks) {
  return lookbacks.map((k) => ({
    key: `score_${k}`, label: `${lookbackLabel(k)} Score`, num: true, fmt: (v) => msScoreCell(v),
  }));
}

async function loadMomentumScores() {
  if (momentumScoresData) {
    renderMomentumScores(momentumScoresData);
    return;
  }
  $("#ms-status").hidden = false;
  $("#ms-status").classList.remove("error");
  $("#ms-status").textContent = "Loading momentum scores…";
  $("#ms-content").hidden = true;
  try {
    const res = await fetch("/api/momentum-scores");
    const body = await res.json();
    if (!res.ok) throw new Error(body.detail || res.statusText);
    momentumScoresData = body;
    renderMomentumScores(body);
  } catch (err) {
    $("#ms-status").textContent = `Couldn't load momentum scores: ${err.message}`;
    $("#ms-status").classList.add("error");
  }
}

function renderMomentumScores(data) {
  $("#ms-status").hidden = true;
  $("#ms-content").hidden = false;
  $("#ms-asof").textContent = data.as_of
    ? `as of ${fmtDate(data.as_of)} · ${data.universe_size} stocks in the universe`
    : "";
  const caveats = membershipCaveats(data.membership_quality, true);
  if (data.missing_symbols?.length) caveats.push(`${data.missing_symbols.length} universe symbol(s) have no usable price history and are excluded from these scores.`);
  $("#ms-data-notes").hidden = !caveats.length;
  $("#ms-data-notes").innerHTML = caveats.map((note) => `<p>${esc(note)}</p>`).join("");
  renderMomentumStocks(data);
  renderMomentumSectors(data);
}

function renderMomentumStocks(data) {
  const lookbacks = data.lookbacks;
  const columns = [
    {
      key: "symbol", label: "Symbol",
      fmt: (v, row) => `<span class="ms-symbol">${esc(v)}</span><span class="ms-company">${esc(row.company_name)}</span>`,
    },
    { key: "subgroup", label: "Sector" },
    { key: "last_price", label: "Last Price", num: true, fmt: (v) => rupees(v) },
    { key: "change_1w_pct", label: "1W Chg", num: true, fmt: pctCell(2, true) },
    ...withScoreColumns(lookbacks),
  ];
  const rows = data.stocks.map((s) => {
    const scores = Object.fromEntries(lookbacks.map((k) => [`score_${k}`, s.scores[String(k)]]));
    return { ...s, ...scores };
  });
  renderTable($('[data-ms-panel="stocks"]'), columns, rows, {
    sortKey: `score_${lookbacks[lookbacks.length - 1]}`, sortDir: -1,
    search: "Filter by symbol, company or sector…", csv: "momentum-scores-stocks.csv",
    scoreFilter: { key: `score_${lookbacks[lookbacks.length - 1]}`, sectors: [...new Set(rows.map((row) => row.subgroup).filter(Boolean))].sort() },
    onOpen: (row, button) => showStockDetail(row, lookbacks, button),
  });
}

function showStockDetail(row, lookbacks, button) {
  scoreDetailTrigger = button;
  $("#score-detail-content").innerHTML = `<p class="eyebrow">Stock detail</p><h3>${esc(row.symbol)} · ${esc(row.company_name)}</h3>
    <p>${esc(row.parent_group)} · ${esc(row.subgroup)}</p>
    <div class="stock-detail-summary"><div><span>Last close</span><strong>${rupees(row.last_price)}</strong></div><div><span>1W change</span><strong>${pct(row.change_1w_pct, 2, true)}</strong></div></div>
    <h4>Momentum windows</h4><div class="stock-window-metrics">${lookbacks.map((k) => `<div><b>${lookbackLabel(k)} <small>(${Math.round(k / 4.33)} mo approx.)</small></b><span>Return ${pct(row.returns[String(k)], 1, true)}</span><span>Relative score ${msScoreCell(row.scores[String(k)])}</span></div>`).join("")}</div>`;
  $("#score-detail-panel").hidden = false;
  $("#score-detail-close").focus();
}

function closeStockDetail() {
  $("#score-detail-panel").hidden = true;
  if (scoreDetailTrigger?.isConnected) scoreDetailTrigger.focus();
}

// Sector-row accordion (TODO.md 3.9.17): the member stocks behind one sector's rolled-up score,
// shown inline rather than only ever seeing the aggregate. No new backend computation - every
// stock already carries its own parent_group/subgroup (see api._momentum_scores_payload), so
// this is a client-side filter of the SAME `data.stocks` array renderMomentumStocks already has,
// not a second fetch. A small static table (not a nested renderTable - sort/search/CSV on a
// handful of rows would be noise, and renderTable itself expects to own a container element, not
// return an HTML string to embed inside another row).
function sectorMemberStocksTable(data, sectorRow) {
  const lookbacks = data.lookbacks;
  const members = data.stocks.filter(
    (s) => s.parent_group === sectorRow.parent_group && s.subgroup === sectorRow.subgroup
  );
  if (!members.length) return `<p class="ms-note">No qualifying members right now.</p>`;
  const head = `<tr><th>Symbol</th><th class="num">Last Price</th><th class="num">1W Chg</th>${lookbacks
    .map((k) => `<th class="num">${lookbackLabel(k)} Score</th>`).join("")}</tr>`;
  const body = members
    .map((s) => `<tr><td><span class="ms-symbol">${esc(s.symbol)}</span><span class="ms-company">${esc(s.company_name)}</span></td>` +
      `<td class="num">${rupees(s.last_price)}</td><td class="num">${pctCell(2, true)(s.change_1w_pct)}</td>` +
      lookbacks.map((k) => `<td class="num">${msScoreCell(s.scores[String(k)])}</td>`).join("") + `</tr>`)
    .join("");
  return `<table class="data ms-nested"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function renderMomentumSectors(data) {
  const lookbacks = data.lookbacks;
  const columns = [
    {
      key: "subgroup", label: "Sector",
      fmt: (v, row) => `<span class="ms-symbol">${esc(v)}</span><span class="ms-company">${esc(row.parent_group)}</span>`,
    },
    {
      key: "qualifying_count", label: "Members", num: true,
      fmt: (v, row) => `${v} / ${row.member_count}`,
    },
    ...withScoreColumns(lookbacks),
  ];
  const rows = data.sectors.map((s) => {
    const scores = Object.fromEntries(lookbacks.map((k) => [`score_${k}`, s.scores[String(k)]]));
    return { ...s, ...scores };
  });
  renderTable($('[data-ms-panel="sectors"]'), columns, rows, {
    expand: { rowId: (row) => row.cid, render: (row) => sectorMemberStocksTable(data, row) },
    sortKey: `score_${lookbacks[lookbacks.length - 1]}`, sortDir: -1,
    search: "Filter by sector…", csv: "momentum-scores-sectors.csv",
  });
}

function showMsTab(name) {
  $$("#ms-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.msTab === name));
  $$("#momentum-scores-view .tab").forEach((p) => (p.hidden = p.dataset.msPanel !== name));
}

function bindEvents() {
  $("#settings-toggle").addEventListener("click", () => {
    const open = document.body.classList.toggle("settings-open");
    $("#settings-toggle").setAttribute("aria-expanded", String(open));
    syncMobileControls();
  });
  $("#drawer-close").addEventListener("click", closeSettings);
  $("#drawer-backdrop").addEventListener("click", closeSettings);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("#score-detail-panel").hidden) { closeStockDetail(); return; }
    if (event.key === "Escape" && document.body.classList.contains("settings-open") && window.matchMedia("(max-width: 900px)").matches) closeSettings();
  });
  window.addEventListener("resize", syncMobileControls);
  $$("#app-tabs button").forEach((b) => b.addEventListener("click", () => showAppView(b.dataset.view)));
  $("#strategy-select").addEventListener("change", (e) => switchDataset(e.target.value));
  $$("#ms-tabs button").forEach((b) => b.addEventListener("click", () => showMsTab(b.dataset.msTab)));
  $$("#period-presets [data-period]").forEach((b) => b.addEventListener("click", () => setPeriod(b.dataset.period)));
  $$(".chips [data-lb]").forEach((b) => b.addEventListener("click", () => { setLookbacks(LOOKBACK_PRESETS[b.dataset.lb]); validateLive(); }));
  $("#add-lookback").addEventListener("click", () => { addLookbackRow(); validateLive(); });
  $("#sidebar").addEventListener("input", validateLive);
  $("#sidebar").addEventListener("change", validateLive);
  $("#universe-search").addEventListener("input", filterUniverse);
  $("#metric-toggle").addEventListener("click", () => {
    const expanded = $("#kpis").classList.toggle("show-details");
    $("#metric-toggle").textContent = expanded ? "Show key metrics" : "Show all metrics";
    $("#metric-toggle").setAttribute("aria-expanded", String(expanded));
  });
  $("#run").addEventListener("click", runBacktest);
  $("#empty-run").addEventListener("click", runBacktest);
  $("#mobile-run").addEventListener("click", runBacktest);
  $("#score-detail-close").addEventListener("click", closeStockDetail);
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !$("#run").disabled) runBacktest();
  });
  $("#log-scale").addEventListener("change", () => {
    if (lastResult) Plotly.relayout("main-chart", { "yaxis.type": $("#log-scale").checked ? "log" : "linear" });
  });
  $("#hover-stock-detail").checked = showStockHover;
  $("#hover-stock-detail").addEventListener("change", () => {
    showStockHover = $("#hover-stock-detail").checked;
    try { localStorage.setItem("mbt.showStockHover", JSON.stringify(showStockHover)); } catch { /* storage full/blocked: keep in memory for this session */ }
    // Hover text is precomputed per point (`rots.map(rotationHover)`, see renderMainChart) rather
    // than built lazily on hover, so the toggle needs a redraw to take effect - a relayout alone
    // (as log-scale does) wouldn't touch the `text` arrays already baked into the trace.
    if (lastResult) renderMainChart(lastResult);
  });
  $$("#tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
}

function showTab(name) {
  activeResultTab = name;
  const groups = {
    overview: ["overview", "yearly"],
    holdings: ["signal", "categories", "timeline", "etfs"],
    trades: ["trades"],
    split: ["split"],
    risk: ["crashes"],
    compare: ["runs"],
  };
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$("#results .tab").forEach((p) => {
    p.hidden = !groups[name].includes(p.dataset.panel) || (p.dataset.panel === "categories" && !(lastResult?.held_categories || []).length);
  });
  if (name === "overview") {
    Plotly.Plots.resize("main-chart");
    Plotly.Plots.resize("yearly-chart");
  }
  if (name === "holdings") Plotly.Plots.resize("timeline-chart");
}

// ---------------------------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------------------------
function setStatus(text, isError = false) {
  const el = $("#status");
  el.textContent = text;
  el.classList.toggle("error", isError);
  el.hidden = !text;
}

function loadRunsFor(dataset) {
  try { return JSON.parse(localStorage.getItem(`mbt.runs.${dataset}`) || "[]"); } catch { return []; }
}
function saveRuns() {
  try { localStorage.setItem(`mbt.runs.${activeDataset}`, JSON.stringify(runs)); } catch { /* storage full: keep in memory */ }
}

async function runBacktest() {
  if ($("#run").disabled) return;
  const cfg = readConfig();
  const problem = validate(cfg);
  if (problem) { validateLive(true); return; }
  const button = $("#run");
  button.disabled = true;
  syncMobileControls();
  button.textContent = "Running…";
  setStatus(cfg.dataset === "custom_index"
    ? "Running backtest… (first run this session builds ~62 category rotations - can take about a minute; later runs with the same inner settings are fast)"
    : cfg.dataset === "broad"
    ? "Running backtest… (first run this session ranks the ~755-name universe - can take ~20-30s; later runs with the same pool settings are fast)"
    : "Running backtest…");
  try {
    const res = await fetch("/api/backtest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg),
    });
    const body = await res.json();
    if (!res.ok) {
      const detail = Array.isArray(body.detail) ? body.detail.map((d) => d.msg).join("; ") : body.detail;
      throw new Error(detail || res.statusText);
    }
    lastResult = body;
    lastConfig = cfg;
    lastResultByDataset[cfg.dataset] = { result: body, config: cfg };
    localStorage.setItem(`mbt.config.${cfg.dataset}`, JSON.stringify(cfg));
    history.replaceState(null, "", "#" + encodeHash(cfg));
    addRun(cfg, body);
    setStatus("");
    $("#results").hidden = false;
    render(body, cfg);
    updateRunState();
    if (window.matchMedia("(max-width: 900px)").matches) {
      closeSettings();
    }
  } catch (err) {
    setStatus(`Backtest failed: ${err.message}`, true);
  } finally {
    button.textContent = "Run backtest";
    button.innerHTML = 'Run backtest <kbd>Ctrl ↵</kbd>';
    validateLive();
    syncMobileControls();
  }
}

function describe(cfg) {
  if (cfg.dataset === "broad") {
    const rule = cfg.portfolio === "buffer"
      ? `Buffer (${cfg.entry === "wait" ? "wait for a sale" : "make room"}${cfg.max_position ? `, max ${Math.round(cfg.max_position * 100)}%/stock` : ", no stock cap"}` +
        `${cfg.max_category && cfg.broad_category_mode === "on" ? `, ${Math.round(cfg.max_category * 100)}%/category` : ""})`
      : "Fixed slots";
    const priceText = cfg.max_stock_price ? ` · shares ≤ ₹${cfg.max_stock_price.toLocaleString("en-IN")}` : "";
    const allOne = cfg.weights.every((w) => w === 1);
    const lbs = cfg.lookbacks.map((w, i) => (allOne ? `${w}` : `${w}×${cfg.weights[i]}`)).join("/");
    const scoreText = cfg.score && cfg.score !== "ranksum" ? ` · score ${cfg.score}` : "";
    const rebalanceText = cfg.rebalance === "monthly" ? " · monthly rebalance" : "";
    const costText = cfg.cost_model === "itemised" ? " · itemised costs" : ` · cost ${cfg.cost_pct}%`;
    const sizingText = cfg.momentum_sizing
      ? ` · win-rate sizing (${cfg.momentum_sizing_window ?? 10}-trade window` +
        `${cfg.momentum_sizing_floor ? `, ${Math.round(cfg.momentum_sizing_floor * 100)}% floor` : ""})`
      : "";
    const modeText = cfg.broad_category_mode === "on"
      ? `category mode ON · pool top ${cfg.broad_pool_top_n}/exit ${cfg.broad_pool_exit_rank} · ` +
        `coverage floor ${Math.round(cfg.broad_coverage_floor * 100)}% · categories ${cfg.broad_category_top_n}/` +
        `${cfg.broad_category_exit_rank} · ${cfg.broad_picks_per_category} stock(s)/category`
      : `category mode OFF · pool top ${cfg.broad_pool_top_n}/exit ${cfg.broad_pool_exit_rank} · ` +
        `stocks ${cfg.broad_off_top_n}/${cfg.broad_off_exit_rank}`;
    return `Broad Momentum · ${modeText} · ${rule}${priceText} · lookbacks ${lbs}w${scoreText}${rebalanceText}${costText}${sizingText}${cfg.signal_delay ? ` · ${cfg.signal_delay}w delay` : ""}`;
  }
  const unit = cfg.dataset === "stock" ? "stock" : cfg.dataset === "custom_index" ? "category" : "ETF";
  const capText = cfg.max_position ? `, max ${Math.round(cfg.max_position * 100)}%/${unit}` : ", no cap";
  const rule = cfg.portfolio === "buffer"
    ? `Buffer (${cfg.entry === "wait" ? "wait for a sale" : "make room"}${capText})`
    : "Fixed slots";
  const allOne = cfg.weights.every((w) => w === 1);
  const lbs = cfg.lookbacks.map((w, i) => (allOne ? `${w}` : `${w}×${cfg.weights[i]}`)).join("/");
  const guard = { off: "always invested", ranked: "debt in ranking", filter: `cash filter ${cfg.filter_lookback}w` }[cfg.defensive];
  const scoreText = cfg.score && cfg.score !== "ranksum" ? ` · score ${cfg.score}` : "";
  const rebalanceText = cfg.rebalance === "monthly" ? " · monthly rebalance" : "";
  const costText = cfg.cost_model === "itemised" ? " · itemised costs" : ` · cost ${cfg.cost_pct}%`;
  const fillsText = cfg.dataset !== "etf" ? "" :
    ` · P&L on ${cfg.track === "etf" ? "ETFs" : "index"}` +
    `${{ fri_close: "", mon_open: ", fill Mon open", mon_10am: ", fill Mon 10:00" }[cfg.execution || "fri_close"]}`;
  const copiesText = (cfg.commodity_copies > 1 || cfg.debt_copies > 1)
    ? ` · up to ${cfg.commodity_copies}x gold/silver, ${cfg.debt_copies}x cash/gilt slots`
    : "";
  const innerText = cfg.dataset === "custom_index"
    ? ` · inner: top ${cfg.inner_top_n} stocks/category, sell rank > ${cfg.inner_exit_rank}${copiesText}`
    : "";
  const sizingText = cfg.momentum_sizing
    ? ` · win-rate sizing (${cfg.momentum_sizing_window ?? 10}-trade window` +
      `${cfg.momentum_sizing_floor ? `, ${Math.round(cfg.momentum_sizing_floor * 100)}% floor` : ""})`
    : "";
  const label = { stock: "Nifty 50 stocks", custom_index: "Custom Index categories" }[cfg.dataset] || "ETFs";
  return `${label} · ${rule} · top ${cfg.top_n}, sell when rank > ${cfg.exit_rank} · lookbacks ${lbs}w · ${guard} · ` +
    `${cfg.universe.length} instruments${innerText}${sizingText}${scoreText}${rebalanceText}${costText}${cfg.signal_delay ? ` · ${cfg.signal_delay}w delay` : ""}${fillsText} · ` +
    (cfg.tax ? `after tax (${Math.round(cfg.slab_rate * 100)}% slab)` : "pre-tax");
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------
function render(r, cfg) {
  const s = r.series;
  const strategyName = { etf: "ETF rotation", stock: "Nifty 50 stocks", custom_index: "Custom Index", broad: "Broad Momentum" }[cfg.dataset] || datasetLabel(cfg.dataset);
  $("#run-title").textContent = `${runs[0]?.name || strategyName} · ${fmtDate(s.dates[0])} → ${fmtDate(s.dates[s.dates.length - 1])}`;
  const assumptions = [cfg.rebalance === "monthly" ? "Monthly rebalance" : "Weekly rebalance",
    cfg.portfolio === "buffer" ? "Buffer rule" : "Fixed slots",
    cfg.cost_model === "itemised" ? "Itemised costs" : `${cfg.cost_pct}% cost per side`,
    cfg.dataset === "etf" ? (cfg.track === "etf" ? "ETF prices" : "Index prices") : null,
    cfg.dataset === "etf" ? ({ fri_close: "Friday close", mon_open: "Monday open", mon_10am: "Monday 10:00" })[cfg.execution] : null,
    cfg.tax ? "After tax" : "Pre-tax"].filter(Boolean);
  $("#assumptions").innerHTML = assumptions.map((item) => `<span>${esc(item)}</span>`).join("") +
    `<details><summary>Full settings</summary><p>${esc(describe(cfg))}</p></details>`;
  const notes = [];
  if (cfg.dataset === "broad") notes.push(...membershipCaveats(meta.membership_quality));
  if (cfg.dataset === "etf") {
    const late = meta.instruments.filter((inst) => selectedUniverse().includes(inst.name) && inst.first_week > cfg.start);
    if (late.length) notes.push(`${late.length} selected instrument(s) start after the test period begins; each can enter the ranking only after enough price history accumulates.`);
  }
  if (r.fills?.proxy_trades) notes.push(`${r.fills.proxy_trades} trade(s) used an index price before the ETF existed.`);
  notes.push(...(r.fills?.warnings || []));
  if (r.skipped_categories?.length) notes.push(`${r.skipped_categories.length} category series were excluded from this run because their data was insufficient.`);
  if (r.missing_symbols?.length) notes.push(`${r.missing_symbols.length} universe symbol(s) lacked usable price history and were excluded.`);
  if (notes.length) $("#assumptions").insertAdjacentHTML("beforeend", `<details class="data-notes" open><summary>Data notes · ${notes.length}</summary>${notes.map((note) => `<p>${esc(note)}</p>`).join("")}</details>`);
  renderKpis(r, cfg);
  renderMainChart(r);
  renderSignal(r, cfg);
  renderHeldCategories(r);
  renderTrades(r);
  renderSplit(r);
  renderTimeline(r);
  renderEtfs(r);
  renderYearly(r);
  renderCrashes(r);
  renderRuns();
  showTab(activeResultTab);
}

// "Broad Momentum", category mode ON only (`r.held_categories`, see api._broad_backtest /
// categories/broad.py's current_holdings_detail): what's held as of the backtest's own last
// week, distinguishing freshly-selected categories/atomics (top `broad_category_top_n`) from
// ones lingering in the buffer - the Step 5 display TODO.md 3.9.13's plan asks for. Hidden
// entirely (tab + panel) for every other dataset, and for category mode OFF (`held_categories`
// is always present but empty in that case - see api.py's own docstring).
function renderHeldCategories(r) {
  const panel = $('[data-panel="categories"]');
  const held = r.held_categories || [];
  if (!held.length) {
    panel.innerHTML = "";
    return;
  }
  const rows = held
    .map((row) => {
      const picks = row.picks.length ? row.picks.map((p) => displayName(p)).join(", ") : "—";
      return `<tr class="${row.status === "fresh" ? "good" : ""}">
        <td>${row.position}</td>
        <td><span class="badge ${row.status === "fresh" ? "" : "warn"}">${esc(row.status)}</span></td>
        <td>${esc(row.category)}</td>
        <td>${esc(picks)}</td>
      </tr>`;
    })
    .join("");
  panel.innerHTML = `
    <h3>Held categories and standalone assets</h3><p class="hint">What the backtest holds as of its own last week - "fresh" entries
      are within the top N this period; "lingering" ones are held only because they haven't yet
      fallen past the exit rank (the holding buffer).</p>
    <table class="data">
      <thead><tr><th>#</th><th>Status</th><th>Category or asset</th><th>Picks</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function kpiCard(label, value, note = "", cls = "") {
  return `<div class="kpi"><div class="label">${label}</div><div class="value ${cls}">${value}</div><div class="note">${note}</div></div>`;
}

function renderKpis(r, cfg) {
  const k = r.kpis, b = esc(r.benchmark_name);
  const cards = [
    kpiCard("₹1 lakh became", rupeesShort(k.final_value), `${b}: ${rupeesShort(k.benchmark_final_value)}`),
    kpiCard("CAGR", pct(k.cagr), `${b} ${pct(k.benchmark_cagr)} · cash ${pct(k.cash_cagr)}`),
    kpiCard("Edge vs benchmark", `${k.excess_cagr > 0 ? "+" : ""}${num(k.excess_cagr * 100, 1)} pp`, `a year · beat it ${k.years_beating_benchmark} of ${k.years} yrs`, signClass(k.excess_cagr)),
    kpiCard("Max drawdown", pct(k.max_drawdown), `${b} ${pct(k.benchmark_max_drawdown)} · ${fmtDate(k.max_drawdown_trough)}`, "bad"),
    kpiCard("Sharpe / Sortino", `${num(k.sharpe, 2)} / ${num(k.sortino, 2)}`, `volatility ${pct(k.volatility)}`),
    kpiCard("Churn", pct(k.turnover_per_year, 0), "of portfolio sold per year"),
    kpiCard("Exits / year", num(k.exits_per_year), `${num(k.new_buys_per_year)} new buys · ${num(k.top_ups_per_year)} top-ups`),
    kpiCard("Avg holding", `${num(k.avg_weeks_held, 0)} wks`, `${num(k.avg_holdings)} positions held on average`),
    kpiCard("Win rate", pct(k.win_rate, 0), `avg win ${pct(k.avg_win, 1, true)} · avg loss ${pct(k.avg_loss)}`),
    kpiCard("Best / worst exit", `${pct(k.best_trade, 0, true)} / ${pct(k.worst_trade, 0)}`, "position return, entry to exit"),
    kpiCard("Largest position", pct(k.max_position_share, 0), "peak share of the portfolio"),
    kpiCard("Time in cash/debt", pct(k.time_in_cash, 0), `ahead over 52w ${pct(k.pct_rolling_52w_ahead, 0)} of the time`),
  ];
  if (cfg.tax) cards.push(kpiCard("Tax paid", rupeesShort(k.tax_paid), "on ₹1 lakh start, incl. final sale"));
  $("#kpis").innerHTML = cards.map((card, i) => `<div class="kpi-wrap ${[0, 1, 2, 3, 4].includes(i) ? "key" : "detail"}">${card}</div>`).join("");
}

// Custom Index only: what a category's OWN inner stock rotation did the same week it was
// bought/sold/trimmed at the outer (category-vs-category) level - e.g. "bought CDMO this week,
// and inside CDMO it happened to buy DIVISLAB and hold SYNGENE". `actions` narrows to the side of
// the inner rotation that corresponds to the outer event (a fresh outer BUY only cares what the
// inner rotation bought/topped up that week, not an unrelated inner SELL that happened to land on
// the same week for its own reasons, and vice versa for an outer SELL).
function innerEventLine(categoryName, week, actions) {
  const events = innerTradesOnWeek(categoryName, week).filter((t) => actions.includes(t.action));
  if (!events.length) return "";
  const text = events.map((t) => `${t.action} ${esc(displayName(t.asset))}`).join(", ");
  return `&nbsp;&nbsp;<i>inside ${esc(categoryName)}: ${text}</i>`;
}

// Custom Index only: what a category's inner rotation is holding as of a given week, reconstructed
// by replaying its own `trades` (BUY/SELL, chronological) up to and including that week - NOT a
// new backend computation, just a client-side fold over data `inner_categories` already ships.
// This exists because `innerEventLine` above only fires when an inner trade lands on the EXACT
// same week as the outer rotation event, and a live check of a real backtest found that's the
// minority case: the inner rotation runs continuously regardless of whether the outer level
// currently holds the category, so by the time the outer level buys/drops a category, its inner
// position is usually just sitting unchanged from a trade weeks or months earlier (measured ~66%
// coincidence on OUT, ~25% on IN across a real 2018-2026 run) - `innerEventLine` alone left most
// IN/OUT events with no stock name at all, which is the gap the user's complaint was pointing at.
function innerHoldingsAsOf(categoryName, week) {
  const inner = innerDetailFor(categoryName);
  if (!inner || !week) return [];
  const held = new Set();
  for (const t of [...inner.trades].sort((a, b) => (a.week < b.week ? -1 : a.week > b.week ? 1 : 0))) {
    if (t.week > week) break;
    // engine.py's buffer portfolio rule can also emit ADD/TRIM (a top-up / a partial reduction
    // to make room) - those change weight, not membership, so only BUY/SELL open or close a
    // position here.
    if (t.action === "BUY" || t.action === "ADD") held.add(t.asset);
    else if (t.action === "SELL") held.delete(t.asset);
  }
  return [...held];
}
function innerHoldingsLine(categoryName, week) {
  const held = innerHoldingsAsOf(categoryName, week);
  if (!held.length) return "";
  const text = held.map((a) => esc(displayName(a))).join(", ");
  return `&nbsp;&nbsp;<i>holding inside ${esc(categoryName)}: ${text}</i>`;
}
// Stock-level line for one outer IN/OUT event: prefer an exact same-week inner trade
// (innerEventLine - the more specific "this is what just happened" signal); when there isn't
// one, fall back to what the inner rotation is holding as of this week (innerHoldingsLine) so
// the tooltip still names a stock rather than going silent, which is what the majority case
// above requires. Gated on `showStockHover` by the one caller (rotationHover) so turning the
// toggle off skips computing either.
function innerDetailLine(categoryName, week, actions) {
  return innerEventLine(categoryName, week, actions) || innerHoldingsLine(categoryName, week);
}

// One rotation week's trades as HTML lines. `withHeading` adds the "date · value" title line; the
// chart's detail panel already shows both in its own header, so it passes false.
function rotationHover(rot, withHeading = true) {
  const lines = withHeading ? [`<b>${fmtDate(rot.week)} · ${rupees(rot.value)}</b>`] : [];
  for (const o of rot.outs) {
    lines.push(`<span style="color:${cssVar("--bad")}">OUT</span> ${esc(displayName(o.asset))} — held ${num(o.weeks_held, 0)}w, ` +
      `${pct(o.return, 1, true)} (${esc(o.reason)})`);
    if (showStockHover) {
      const inside = innerDetailLine(o.asset, rot.week, ["SELL"]);
      if (inside) lines.push(inside);
    }
  }
  for (const i of rot.ins) {
    lines.push(`<span style="color:${cssVar("--good")}">${i.top_up ? "ADD" : "IN"}</span> ${esc(displayName(i.asset))} (rank ${num(i.rank, 0)})`);
    if (showStockHover) {
      const inside = innerDetailLine(i.asset, rot.week, ["BUY", "ADD"]);
      if (inside) lines.push(inside);
    }
  }
  for (const t of rot.trims) {
    lines.push(`<span style="color:${cssVar("--warn")}">TRIM</span> ${esc(displayName(t.asset))} (${esc(t.reason)})`);
  }
  if (rot.parked) lines.push("PARK — nothing qualified, money to cash");
  if (rot.holdings.length) {
    const top = rot.holdings.slice(0, 9).map((h) => `${esc(displayName(h.asset))} ${pct(h.share, 0)}`).join(", ");
    lines.push(`<i>Holding ${rot.holdings.length}: ${top}${rot.holdings.length > 9 ? ", …" : ""}</i>`);
  }
  return lines.join("<br>");
}

function renderMainChart(r) {
  const s = r.series;
  // The stock-level hover toggle only means anything on Custom Index runs that actually shipped
  // `inner_categories` (see `_inner_category_detail` - never present for etf/stock, and can be
  // absent even on custom_index if nothing was ever held) - hide it otherwise, same pattern the
  // Trades tab's "Bought inside"/"Sold inside" columns already use (`hasInner` in renderTrades).
  const hoverToggle = $("#hover-detail-wrap");
  if (hoverToggle) hoverToggle.hidden = !r.inner_categories;
  const lakh = (arr) => arr.map((v) => (v == null ? null : v / 1e5));  // plotted in rupees lakh
  const text = (arr, fmt) => arr.map(fmt);
  const good = cssVar("--good"), bad = cssVar("--bad"), accent = cssVar("--strategy");
  const traces = [
    {
      x: s.dates, y: lakh(s.strategy), name: runs.length ? `Strategy (run ${runs[0].n})` : "Strategy",
      type: "scatter", mode: "lines",
      line: { color: accent, width: 2.2 },
      hoverinfo: "none",
    },
    {
      x: s.dates, y: lakh(s.benchmark), name: r.benchmark_name, type: "scatter", mode: "lines",
      line: { color: cssVar("--benchmark"), width: 1.6 },
      hoverinfo: "none",
    },
    {
      x: s.dates, y: lakh(s.cash), name: "Liquid fund", type: "scatter", mode: "lines",
      line: { color: cssVar("--cash"), width: 1, dash: "dot" },
      hoverinfo: "none",
    },
  ];
  runs.filter((run) => run.overlay && run.id !== runs[0]?.id).forEach((run) => {
    traces.push({
      x: run.dates, y: lakh(run.strategy), name: `Run ${run.n}`, type: "scatter", mode: "lines",
      line: { color: run.color, width: 1.4, dash: "dash" },
      hoverinfo: "none",
    });
  });
  const rots = r.rotations;
  traces.push({
    x: rots.map((x) => x.week), y: rots.map((x) => (x.value == null ? null : x.value / 1e5)), name: "Rotations", type: "scatter", mode: "markers",
    marker: {
      size: 7, line: { width: 1, color: cssVar("--panel") },
      color: rots.map((x) => {
        if (!x.outs.length) return accent;
        const avg = x.outs.reduce((a, o) => a + (o.return ?? 0), 0) / x.outs.length;
        return avg >= 0 ? good : bad;
      }),
    },
    hoverinfo: "none",
  });
  traces.push(
    {
      x: s.dates, y: s.drawdown_strategy, name: "Strategy drawdown", xaxis: "x", yaxis: "y2", type: "scatter",
      mode: "lines", fill: "tozeroy", line: { color: accent, width: 1 }, showlegend: false,
      hoverinfo: "none",
    },
    {
      x: s.dates, y: s.drawdown_benchmark, name: `${r.benchmark_name} drawdown`, xaxis: "x", yaxis: "y2",
      type: "scatter", mode: "lines", line: { color: cssVar("--benchmark"), width: 1 }, showlegend: false,
      hoverinfo: "none",
    },
    {
      x: s.dates, y: s.rolling_52w_excess, name: "52-week edge", xaxis: "x", yaxis: "y3", type: "bar",
      marker: { color: s.rolling_52w_excess.map((v) => (v == null ? "rgba(0,0,0,0)" : v >= 0 ? good : bad)) },
      showlegend: false, hoverinfo: "none",
    },
  );
  const grid = cssVar("--border"), fg = cssVar("--text"), muted = cssVar("--muted");
  const layout = {
    height: Math.max(380, Math.min(window.innerHeight * 0.62, 560)), margin: { l: 70, r: 20, t: 10, b: 30 },
    paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)", font: { color: fg, size: 12 },
    // No floating label: it covered the chart. hoverinfo "none" on every trace still fires
    // plotly_hover, which fills the panel under the chart (see showChartDetail).
    hovermode: "x unified",
    legend: { orientation: "h", y: 1.04, x: 0 },
    xaxis: { gridcolor: grid, anchor: "y3", showspikes: true, spikemode: "across", spikethickness: 1, spikecolor: muted },
    yaxis: { domain: [0.45, 1], gridcolor: grid, tickprefix: "₹", ticksuffix: " L", type: $("#log-scale").checked ? "log" : "linear",
      title: { text: "Value of ₹1 lakh invested", font: { size: 11, color: muted } } },
    yaxis2: { domain: [0.23, 0.41], gridcolor: grid, tickformat: ".0%", title: { text: "Drawdown", font: { size: 11, color: muted } } },
    yaxis3: { domain: [0, 0.19], gridcolor: grid, tickformat: "+.0%", title: { text: "52w edge", font: { size: 11, color: muted } } },
  };
  Plotly.react("main-chart", traces, layout, { responsive: true, displaylogo: false });
  bindChartDetail(r);
}

// Hover details for the main chart live in a panel under it (full chart width) instead of a
// floating tooltip on top of the lines. Everything is computed from the payload on hover, not
// baked into the traces, so a redraw stays cheap.
const CHART_DETAIL_HINT = "Hover the chart to see that week's values and trades here.";
function bindChartDetail(r) {
  const chart = $("#main-chart"), panel = $("#chart-detail");
  panel.innerHTML = `<span class="muted">${CHART_DETAIL_HINT}</span>`;
  // Plotly.react keeps the same element, so drop the previous run's listener before adding ours.
  chart.removeAllListeners?.("plotly_hover");
  chart.on?.("plotly_hover", (ev) => {
    const x = ev.points?.[0]?.x;
    if (x != null) showChartDetail(r, String(x).slice(0, 10));
  });
}
function showChartDetail(r, date) {
  const s = r.series;
  const i = s.dates.findIndex((d) => String(d).slice(0, 10) === date);
  if (i < 0) return;
  const idle = s.idle_share[i] ?? 0;
  const metrics = [
    `<b>${fmtDate(date)}</b>`,
    `Strategy <b>${rupees(s.strategy[i])}</b> · ${s.holdings_count[i] ?? "–"} held${idle > 0.001 ? ` · ${pct(idle, 0)} cash` : ""}`,
    `${esc(r.benchmark_name)} ${rupees(s.benchmark[i])}`,
    `Liquid fund ${rupees(s.cash[i])}`,
    `Drawdown <span class="bad">${pct(s.drawdown_strategy[i], 1)}</span> (${esc(r.benchmark_name)} ${pct(s.drawdown_benchmark[i], 1)})`,
    `52w edge <span class="${signClass(s.rolling_52w_excess[i])}">${pct(s.rolling_52w_excess[i], 1, true)}</span>`,
  ];
  for (const run of runs.filter((x) => x.overlay && x.id !== runs[0]?.id)) {
    const j = run.dates.findIndex((d) => String(d).slice(0, 10) === date);
    if (j >= 0) metrics.push(`Run ${run.n} ${rupees(run.strategy[j])}`);
  }
  const rot = r.rotations.find((x) => String(x.week).slice(0, 10) === date);
  const trades = rot ? rotationHover(rot, false) : `<span class="muted">No trades this week.</span>`;
  $("#chart-detail").innerHTML =
    `<div class="cd-metrics">${metrics.map((m) => `<span>${m}</span>`).join("")}</div>` +
    `<div class="cd-trades">${trades}</div>`;
}

// --- generic sortable table -------------------------------------------------------------------
function renderTable(container, columns, rows, opts = {}) {
  let sortKey = opts.sortKey ?? null;
  let sortDir = opts.sortDir ?? -1;
  let query = "";
  let minimumScore = 0;
  let selectedSector = "";
  // Expandable rows (TODO.md 3.9.17): opt-in via opts.expand = { rowId(row), render(row) } -
  // render() returns the inner HTML of a nested detail <tr> inserted right after the clicked
  // row. `expanded` is a plain Set of rowId()s kept in this closure, so it (and the DOM it
  // produces) survives sort/search re-draws instead of being wiped by tbody.innerHTML like a
  // one-off DOM mutation would be - draw() itself re-renders expanded rows every time.
  const expanded = new Set();
  const tools = opts.search || opts.csv || opts.scoreFilter
    ? `<div class="table-tools">${opts.search ? `<input type="search" placeholder="${esc(opts.search)}">` : ""}
       ${opts.scoreFilter ? `<label>Sector <select class="sector-filter"><option value="">All sectors</option>${opts.scoreFilter.sectors.map((sector) => `<option value="${esc(sector)}">${esc(sector)}</option>`).join("")}</select></label>
       <label>${esc(columns.find((col) => col.key === opts.scoreFilter.key)?.label || "Score")} <select class="score-filter"><option value="0">Any score</option><option value="60">60+</option><option value="80">80+</option><option value="90">90+</option></select></label>` : ""}
       ${opts.csv ? `<button type="button" class="csv">Download CSV</button>` : ""}
       <span class="muted count-note"></span></div>` : "";
  container.innerHTML = `${opts.before || ""}${tools}<table class="data"><thead><tr>${columns
    .map((c) => `<th class="${c.num ? "num" : ""} ${opts.sortable === false ? "" : "sortable"}" data-key="${c.key}">${opts.sortable === false ? c.label : `<button type="button" class="sort-button">${c.label}</button>`}</th>`)
    .join("")}</tr></thead><tbody></tbody></table>`;
  const tbody = $("tbody", container);

  function value(row, col) {
    return col.sortValue ? col.sortValue(row) : row[col.key];
  }
  function draw() {
    let view = rows;
    if (opts.scoreFilter) view = view.filter((row) => (!selectedSector || row.subgroup === selectedSector) && Number(row[opts.scoreFilter.key]) >= minimumScore);
    if (query) {
      const q = query.toLowerCase();
      view = view.filter((row) => columns.some((c) => String(row[c.key] ?? "").toLowerCase().includes(q)));
    }
    if (sortKey) {
      const col = columns.find((c) => c.key === sortKey);
      view = [...view].sort((a, b) => {
        const va = value(a, col), vb = value(b, col);
        if (va == null) return 1;
        if (vb == null) return -1;
        return (va > vb ? 1 : va < vb ? -1 : 0) * sortDir;
      });
    }
    tbody.innerHTML = view.map((row, rowIndex) => {
      const id = opts.expand ? opts.expand.rowId(row) : null;
      const isOpen = id != null && expanded.has(id);
      const chevron = opts.expand ? `<button type="button" class="row-expand" aria-expanded="${isOpen}" aria-label="${isOpen ? "Hide" : "Show"} details for ${esc(row[columns[0].key])}"><span class="row-chevron ${isOpen ? "open" : ""}">▸</span></button>` : "";
      const mainRow = `<tr class="${opts.rowClass ? opts.rowClass(row) : ""} ${opts.expand ? "expandable-row" : ""}" ${id != null ? `data-row-id="${esc(id)}"` : ""}>${columns
        .map((c, i) => `<td class="${c.num ? "num" : ""} ${c.cls ? c.cls(row) : ""}">${i === 0 ? chevron + (opts.onOpen ? `<button type="button" class="detail-open" data-detail-index="${rowIndex}" aria-label="View details for ${esc(row[columns[0].key])}">Details</button>` : "") : ""}${c.fmt ? c.fmt(row[c.key], row) : esc(row[c.key])}</td>`)
        .join("")}</tr>`;
      const detailRow = isOpen
        ? `<tr class="expanded-detail"><td colspan="${columns.length}">${opts.expand.render(row)}</td></tr>`
        : "";
      return mainRow + detailRow;
    }).join("");
    if (opts.expand) {
      $$("tr.expandable-row", tbody).forEach((tr) => tr.addEventListener("click", () => {
        const id = tr.dataset.rowId;
        if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
        draw();
      }));
    }
    if (opts.onOpen) $$("[data-detail-index]", tbody).forEach((button) => button.addEventListener("click", () => opts.onOpen(view[Number(button.dataset.detailIndex)], button)));
    $$("th", container).forEach((th) => {
      th.classList.toggle("sorted-asc", th.dataset.key === sortKey && sortDir === 1);
      th.classList.toggle("sorted-desc", th.dataset.key === sortKey && sortDir === -1);
      th.setAttribute("aria-sort", th.dataset.key === sortKey ? sortDir === 1 ? "ascending" : "descending" : "none");
    });
    const note = $(".count-note", container);
    if (note) note.textContent = `${view.length} of ${rows.length}`;
  }
  if (opts.sortable !== false) {
    $$("th .sort-button", container).forEach((button) => button.addEventListener("click", () => {
      const th = button.closest("th");
      if (sortKey === th.dataset.key) sortDir = -sortDir; else { sortKey = th.dataset.key; sortDir = -1; }
      draw();
    }));
  }
  const search = $("input[type=search]", container);
  if (search) search.addEventListener("input", () => { query = search.value; draw(); });
  $(".sector-filter", container)?.addEventListener("change", (event) => { selectedSector = event.target.value; draw(); });
  $(".score-filter", container)?.addEventListener("change", (event) => { minimumScore = Number(event.target.value); draw(); });
  const csv = $(".csv", container);
  if (csv) csv.addEventListener("click", () => downloadCsv(opts.csv, columns, rows));
  draw();
}

function downloadCsv(filename, columns, rows) {
  const cell = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map((c) => cell(c.label)).join(",")]
    .concat(rows.map((row) => columns.map((c) => cell(row[c.key])).join(",")));
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

const pctCell = (digits = 1, sign = true) => (v) => `<span class="${signClass(v)}">${pct(v, digits, sign)}</span>`;
const assetCell = (v) => esc(displayName(v));

// --- tabs --------------------------------------------------------------------------------------
// Custom Index only: under a currently-held category's name, show which stock(s) its own inner
// rotation actually holds right now (e.g. "holding: DIVISLAB 55%, SYNGENE 45%") - otherwise the
// "This week" panel only ever shows the category-level ● and gives no way to see what's really
// been bought inside it. Non-held rows, and every other dataset (no `inner_categories` on the
// payload at all), fall back to the plain asset cell unchanged.
function signalAssetCell(name, row) {
  const label = esc(displayName(name));
  if (!row.held) return label;
  const holdings = innerHoldingsText(name);
  return holdings ? `${label}<div class="inner-detail">holding: ${esc(holdings)}</div>` : label;
}

function membershipCaveats(quality, currentSnapshot = false) {
  const years = quality?.constant_current_years || [];
  if (!years.length) return [];
  const range = years.length === 1 ? String(years[0]) : `${years[0]}–${years[years.length - 1]}`;
  return [`Total Market membership for ${range} uses the current constituent list in place of historical snapshots. ${currentSnapshot ? "Current scores use the latest list; historical comparisons may have survivorship bias." : "Older backtest results may have survivorship bias."}`];
}

function signalReason(row, cfg) {
  const action = row.action || "";
  const rank = Number(row.rank);
  const top = cfg.dataset === "broad"
    ? (cfg.broad_category_mode === "on" ? cfg.broad_category_top_n : cfg.broad_off_top_n)
    : cfg.top_n;
  const exit = cfg.dataset === "broad"
    ? (cfg.broad_category_mode === "on" ? cfg.broad_category_exit_rank : cfg.broad_off_exit_rank)
    : cfg.exit_rank;
  if (action === "NOT A MEMBER") return "Outside this week's eligible universe.";
  if (action.startsWith("BUY")) return action.includes("make room")
    ? `Rank ${rank} is within the top ${top}; existing holdings are trimmed to fund it.`
    : `New position; rank ${rank} is within the top ${top}.`;
  if (action === "ADD") return "Existing position received more capital under the portfolio rule.";
  if (action === "WAIT") return `Ranked in the top ${top}; entry waits for cash or a sale.`;
  if (action === "AT CAP") return "Position is at its configured size limit.";
  if (action.startsWith("TRIM")) return "Position exceeded its configured size limit.";
  if (action === "SELL") return rank > exit
    ? `Rank ${rank} fell past the exit rank ${exit}.`
    : "Exit triggered by the portfolio or protection rule.";
  if (action === "HOLD") return rank > top && rank <= exit
    ? `Held in the rank buffer (${top + 1}–${exit}).`
    : "Position remains open under the portfolio rule.";
  return row.held ? "Position remains open." : "Not selected for a position this week.";
}

function renderSignal(r, cfg) {
  const latest = r.latest;
  const lookbacks = latest.rows.length ? Object.keys(latest.rows[0].returns) : [];
  const columns = [
    { key: "rank", label: "Rank", num: true, fmt: (v) => num(v, 0) },
    { key: "asset", label: ({ etf: "ETF", stock: "Stock", custom_index: "Category", broad: "Asset" })[cfg.dataset] || "Asset", fmt: r.inner_categories ? signalAssetCell : assetCell },
    { key: "action", label: "Action", fmt: (v) => (v ? `<span class="action ${esc(v.split(" ")[0])}">${esc(v)}</span>` : "") },
    { key: "reason", label: "Why", fmt: (v) => `<span class="signal-reason">${esc(v)}</span>` },
    { key: "score", label: "Score", num: true, fmt: (v) => num(v, 2) },
    ...lookbacks.map((k) => ({
      key: `r${k}`, label: `${k}w`, num: true, fmt: pctCell(1, true), sortValue: (row) => row[`r${k}`],
    })),
    { key: "held", label: "Held", fmt: (v) => (v ? "●" : "") },
  ];
  const rows = latest.rows.map((row) => ({ ...row, reason: signalReason(row, cfg), ...Object.fromEntries(lookbacks.map((k) => [`r${k}`, row.returns[k]])) }));
  const panel = $('[data-panel="signal"]');
  const openRows = r.open_positions;
  const openTable = openRows.length
    ? `<h2 style="margin-top:18px">Open positions</h2><div id="open-positions"></div>` : "";
  renderTable(panel, columns, rows, {
    sortKey: "rank", sortDir: 1, sortable: true,
    before: `<h3>Signals as of ${fmtDate(latest.week)}</h3><p class="explain">${esc(latest.explain)}</p>`,
    rowClass: (row) => (row.held ? "held" : ""),
  });
  panel.insertAdjacentHTML("beforeend", openTable);
  if (openRows.length) {
    renderTable($("#open-positions"), [
      { key: "asset", label: ({ etf: "ETF", stock: "Stock", custom_index: "Category", broad: "Asset" })[cfg.dataset] || "Asset", fmt: assetCell },
      { key: "entry_week", label: "Since", fmt: fmtDate },
      { key: "weeks_held", label: "Weeks", num: true, fmt: (v) => num(v, 0) },
      { key: "rank", label: "Rank now", num: true, fmt: (v) => num(v, 0) },
      { key: "position_return", label: "Return", num: true, fmt: pctCell() },
      { key: "value", label: "Value (₹1L start)", num: true, fmt: rupees },
      { key: "pnl", label: "P&L", num: true, fmt: (v) => `<span class="${signClass(v)}">${rupees(v)}</span>` },
    ], openRows, { sortKey: "value", sortDir: -1 });
  }
}

// Custom Index only: what a category's own inner rotation bought/sold the same week the OUTER
// (closed) trade's entry/exit happened - plain "ACTION ticker" text (sortable/searchable/CSV-
// exportable like every other trades-table column, unlike a hover-only tooltip) so a user can
// see, for e.g. a CDMO position entered 2024-03-01 and exited 2024-06-14, that entry bought
// DIVISLAB and SYNGENE and that exit sold them both - without needing the main chart open.
function innerTradesText(categoryName, week, actions) {
  return innerTradesOnWeek(categoryName, week)
    .filter((t) => actions.includes(t.action))
    .map((t) => `${t.action} ${displayName(t.asset)}`)
    .join(", ");
}

function renderTrades(r) {
  const hasInner = !!r.inner_categories;
  const rows = hasInner
    ? r.trades.map((t) => ({
        ...t,
        inner_entry: innerTradesText(t.asset, t.entry_week, ["BUY", "ADD"]),
        inner_exit: innerTradesText(t.asset, t.exit_week, ["SELL"]),
      }))
    : r.trades;
  const columns = [
    { key: "asset", label: hasInner ? "Category" : "ETF", fmt: assetCell },
    { key: "entry_week", label: "Entry", fmt: fmtDate },
    ...(hasInner ? [{ key: "inner_entry", label: "Bought inside" }] : []),
    { key: "exit_week", label: "Exit", fmt: fmtDate },
    ...(hasInner ? [{ key: "inner_exit", label: "Sold inside" }] : []),
    { key: "weeks_held", label: "Weeks", num: true, fmt: (v) => num(v, 0) },
    { key: "entry_rank", label: "Entry rank", num: true, fmt: (v) => num(v, 0) },
    { key: "exit_rank", label: "Exit rank", num: true, fmt: (v) => num(v, 0) },
    { key: "position_return", label: "Return", num: true, fmt: pctCell() },
    { key: "pnl", label: "P&L (₹1L start)", num: true, fmt: (v) => `<span class="${signClass(v)}">${rupees(v)}</span>` },
    { key: "reason", label: "Why sold" },
    { key: "tax", label: "Tax", num: true, fmt: (v) => (v ? rupees(v * 100000) : "–") },
    { key: "proxy", label: "Priced on", fmt: (v) => (v ? `<span class="badge warn" title="The ETF hadn't listed yet, so its index (less the expense ratio) stood in">index proxy</span>` : "") },
  ];
  renderTable($('[data-panel="trades"]'), columns, rows, {
    sortKey: "exit_week", sortDir: -1, search: hasInner ? "Filter by category, stock, reason…" : "Filter by ETF, reason…", csv: "momentum-trades.csv",
    before: `<p class="explain">Every position fully sold. Return and P&L count all purchases of the position, including top-ups.${fillsNote(r.fills)}</p>`,
  });
}

// "Trade split": what to actually buy. Takes the portfolio the backtest ends the latest week
// holding, scales it to a rupee amount typed here, and - only where the payload carries a share
// price (Broad Momentum's stocks, priced at the raw traded close) - turns each amount into whole
// shares plus the rounding leftover. Everything after the fetch is client-side, so changing the
// amount never re-runs the backtest.
function renderSplit(r) {
  const panel = $('[data-panel="split"]');
  const strategy = r.series.strategy;
  const total = strategy[strategy.length - 1];
  const open = (r.open_positions || []).filter((p) => p.value > 0);
  if (!open.length || !(total > 0)) {
    panel.innerHTML = `<p class="explain">Nothing is held as of the latest week, so there is nothing to split.</p>`;
    return;
  }
  const hasPrice = open.some((p) => p.price != null);
  const categoryOf = {};
  for (const row of r.held_categories || []) for (const pick of row.picks) categoryOf[pick] = row.category;
  const hasCategory = Object.keys(categoryOf).length > 0;
  let capital = 1000000;
  try { const saved = Number(localStorage.getItem("mbt.splitCapital")); if (saved >= 1000) capital = saved; } catch { /* storage blocked: default */ }
  const rows = open.map((p) => ({ ...p, weight: p.value / total })).sort((a, b) => b.weight - a.weight);
  const idle = Math.max(1 - rows.reduce((t, p) => t + p.weight, 0), 0);
  const note = hasPrice
    ? "Whole shares at the latest weekly close; the leftover is what a whole-share buy can't use."
    : "This strategy ranks an index or a synthetic curve rather than a share you can buy, so only the rupee split is shown.";
  panel.innerHTML = `<h3>Trade split as of ${fmtDate(r.latest?.week)}</h3>
    <p class="explain">The portfolio the strategy holds at the latest week, scaled to the capital below. ${note}</p>
    <div class="row"><label>Capital to invest ₹ <input type="number" id="split-capital" min="1000" step="10000" value="${capital}"></label></div>
    <div id="split-summary" class="hint"></div><div id="split-table"></div>`;

  const draw = () => {
    const amount = Number($("#split-capital").value) || 0;
    const lines = rows.map((p) => {
      const rupeesFor = p.weight * amount;
      const shares = hasPrice && p.price > 0 ? Math.floor(rupeesFor / p.price) : null;
      return { ...p, rupeesFor, shares, cost: shares == null ? null : shares * p.price };
    });
    const byCategory = {};
    for (const l of lines) if (categoryOf[l.asset]) byCategory[categoryOf[l.asset]] = (byCategory[categoryOf[l.asset]] || 0) + l.weight;
    $("#split-summary").innerHTML = hasCategory
      ? `By category: ${Object.entries(byCategory).sort((a, b) => b[1] - a[1]).map(([c, w]) => `${esc(c.split(" :: ").pop())} ${pct(w, 0)}`).join(" · ")}`
      : "";
    const head = ["Position", ...(hasCategory ? ["Category"] : []), "Weight", "Amount", ...(hasPrice ? ["Price", "Shares", "Cost"] : []), ""];
    const numeric = new Set(["Weight", "Amount", "Price", "Shares", "Cost"]);
    const cell = (v, label) => `<td${numeric.has(label) ? ' class="num"' : ""}>${v}</td>`;
    const body = lines.map((l) => {
      const flag = l.shares === 0 ? `<span class="badge warn" title="One share costs more than this position's amount">1 share &gt; amount</span>` : "";
      return `<tr>${[
        [esc(displayName(l.asset)), "Position"],
        ...(hasCategory ? [[esc((categoryOf[l.asset] || "—").split(" :: ").pop()), "Category"]] : []),
        [pct(l.weight, 1), "Weight"], [rupees(l.rupeesFor), "Amount"],
        ...(hasPrice ? [[l.price == null ? "–" : rupees(l.price), "Price"], [l.shares == null ? "–" : inr.format(l.shares), "Shares"], [l.cost == null ? "–" : rupees(l.cost), "Cost"]] : []),
        [flag, ""],
      ].map(([v, label]) => cell(v, label)).join("")}</tr>`;
    }).join("");
    const spent = lines.reduce((t, l) => t + (l.cost ?? l.rupeesFor), 0);
    const planned = lines.reduce((t, l) => t + l.rupeesFor, 0);
    const cash = idle * amount;
    const foot = [
      idle > 0.005 ? `<tr><td>Cash (parked)</td>${hasCategory ? "<td></td>" : ""}<td class="num">${pct(idle, 1)}</td><td class="num">${rupees(cash)}</td>${hasPrice ? "<td></td><td></td><td></td>" : ""}<td></td></tr>` : "",
      `<tr class="total"><td><b>Total</b></td>${hasCategory ? "<td></td>" : ""}<td class="num"><b>${pct(1, 0)}</b></td><td class="num"><b>${rupees(planned + cash)}</b></td>` +
        `${hasPrice ? `<td></td><td></td><td class="num"><b>${rupees(spent)}</b></td>` : ""}<td></td></tr>`,
      hasPrice ? `<tr><td colspan="${head.length}" class="muted">Left over from whole-share rounding: ${rupees(planned - spent)}</td></tr>` : "",
    ].join("");
    $("#split-table").innerHTML = `<table class="data"><thead><tr>${head.map((h) => `<th${numeric.has(h) ? ' class="num"' : ""}>${h}</th>`).join("")}</tr></thead><tbody>${body}${foot}</tbody></table>`;
  };
  $("#split-capital").addEventListener("input", () => {
    const value = Number($("#split-capital").value);
    if (value >= 1000) { try { localStorage.setItem("mbt.splitCapital", String(value)); } catch { /* not persisted */ } }
    draw();
  });
  draw();
}

function fillsNote(f) {
  if (!f) return "";
  let note = "";
  if (f.track === "etf") {
    note += ` P&L is on the ETFs; ${f.proxy_trades} trade${f.proxy_trades === 1 ? "" : "s"} fell in weeks before the ETF listed and use its index as a proxy.`;
  }
  for (const w of f.warnings || []) note += ` <span class="badge warn">${esc(w)}</span>`;
  return note;
}

function renderTimeline(r) {
  const segs = r.timeline;
  const assets = [...new Set(segs.map((s) => displayName(s.asset)))].sort();
  const good = cssVar("--good"), bad = cssVar("--bad");
  const day = 86400000;
  const trace = {
    type: "bar", orientation: "h",
    y: segs.map((s) => displayName(s.asset)),
    base: segs.map((s) => s.start),
    x: segs.map((s) => Math.max((new Date(s.end) - new Date(s.start)), 7 * day)),
    marker: { color: segs.map((s) => ((s.return ?? 0) >= 0 ? good : bad)), opacity: segs.map((s) => (s.open ? 0.95 : 0.7)) },
    text: segs.map((s) => `<b>${esc(displayName(s.asset))}</b><br>${fmtDate(s.start)} → ${s.open ? "now (held)" : fmtDate(s.end)}` +
      `<br>${num(s.weeks, 0)} weeks · ${pct(s.return, 1, true)}`),
    hovertemplate: "%{text}<extra></extra>", textposition: "none",
  };
  const grid = cssVar("--border");
  Plotly.react("timeline-chart", [trace], {
    height: Math.max(360, assets.length * 24 + 80), margin: { l: 170, r: 20, t: 10, b: 30 },
    paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)", font: { color: cssVar("--text"), size: 12 },
    xaxis: { type: "date", gridcolor: grid }, yaxis: { categoryorder: "array", categoryarray: assets.slice().reverse(), gridcolor: grid },
    barmode: "overlay", bargap: 0.35,
  }, { responsive: true, displaylogo: false });
}

function renderEtfs(r) {
  renderTable($('[data-panel="etfs"]'), [
    { key: "asset", label: "ETF", fmt: assetCell },
    { key: "group", label: "Group" },
    { key: "positions", label: "Positions", num: true },
    { key: "top_ups", label: "Top-ups", num: true },
    { key: "weeks_held", label: "Weeks held", num: true },
    { key: "avg_share", label: "Avg share", num: true, fmt: (v) => pct(v, 1) },
    { key: "win_rate", label: "Win rate", num: true, fmt: (v) => pct(v, 0) },
    { key: "avg_return", label: "Avg return", num: true, fmt: pctCell() },
    { key: "pnl", label: "P&L (₹1L start)", num: true, fmt: (v) => `<span class="${signClass(v)}">${rupees(v)}</span>` },
    { key: "pnl_share", label: "Share of P&L", num: true, fmt: (v) => pct(v, 1) },
    { key: "held_now", label: "Held now", fmt: (v) => (v ? "●" : "") },
  ], r.instruments, {
    sortKey: "pnl", sortDir: -1, csv: "momentum-etfs.csv",
    before: `<p class="explain">Attribution per ETF, closed and open positions together. Avg share is the ETF's average weight in the portfolio across all weeks.</p>`,
  });
}

function renderYearly(r) {
  const y = r.yearly;
  Plotly.react("yearly-chart", [
    { x: y.map((d) => String(d.year)), y: y.map((d) => d.strategy), name: "Strategy", type: "bar", marker: { color: cssVar("--strategy") },
      hovertemplate: "Strategy %{y:.1%}<extra></extra>" },
    { x: y.map((d) => String(d.year)), y: y.map((d) => d.benchmark), name: r.benchmark_name, type: "bar", marker: { color: cssVar("--benchmark") },
      hovertemplate: `${esc(r.benchmark_name)} %{y:.1%}<extra></extra>` },
  ], {
    height: 340, barmode: "group", margin: { l: 50, r: 20, t: 10, b: 30 },
    paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)", font: { color: cssVar("--text"), size: 12 },
    yaxis: { tickformat: ".0%", gridcolor: cssVar("--border") }, legend: { orientation: "h", y: 1.1 },
  }, { responsive: true, displaylogo: false });
  renderTable($("#yearly-table"), [
    { key: "year", label: "Year" },
    { key: "strategy", label: "Strategy", num: true, fmt: pctCell() },
    { key: "benchmark", label: esc(r.benchmark_name), num: true, fmt: pctCell() },
    { key: "cash", label: "Liquid fund", num: true, fmt: pctCell() },
    { key: "vs_benchmark", label: "Difference", num: true, fmt: pctCell() },
  ], y, { sortKey: "year", sortDir: 1 });
}

function renderCrashes(r) {
  const rows = r.crashes.map((c) => ({ ...c, diff: c.strategy - c.benchmark }));
  renderTable($('[data-panel="crashes"]'), [
    { key: "benchmark peak", label: "Benchmark peak", fmt: fmtDate },
    { key: "benchmark trough", label: "Trough", fmt: fmtDate },
    { key: "benchmark", label: `${esc(r.benchmark_name)} fall`, num: true, fmt: pctCell() },
    { key: "strategy", label: "Strategy over same dates", num: true, fmt: pctCell() },
    { key: "diff", label: "Difference", num: true, fmt: pctCell() },
  ], rows, {
    sortKey: "benchmark", sortDir: 1,
    before: `<p class="explain">The benchmark's three deepest peak-to-trough falls in this period, and what the strategy did over the same dates.</p>`,
  });
}

// --- run history ------------------------------------------------------------------------------
function addRun(cfg, r) {
  const n = (runs[0]?.n ?? 0) + 1;
  runs.unshift({
    id: `${Date.now()}`,
    n,
    color: RUN_COLORS[(n - 1) % RUN_COLORS.length],
    overlay: false,
    config: cfg,
    title: describe(cfg),
    kpis: { cagr: r.kpis.cagr, max_drawdown: r.kpis.max_drawdown, sharpe: r.kpis.sharpe, excess: r.kpis.excess_cagr,
      turnover: r.kpis.turnover_per_year, holdings: r.kpis.avg_holdings },
    dates: r.series.dates,
    strategy: r.series.strategy,
  });
  runs = runs.slice(0, MAX_RUNS);
  saveRuns();
}
function renderRuns(panel = $('[data-panel="runs"]')) {
  $("#runs-count").textContent = runs.length ? `(${runs.length})` : "";
  if (!runs.length) { panel.innerHTML = `<p class="explain">Runs you make appear here.</p>`; return; }
  const current = runs[0];
  const comparison = runs.find((run) => run.id === compareRunId && run.id !== current.id) || runs[1];
  const metrics = [
    ["CAGR", "cagr", (v) => pct(v)], ["Edge vs benchmark", "excess", (v) => `${v > 0 ? "+" : ""}${num(v * 100, 1)} pp`],
    ["Max drawdown", "max_drawdown", (v) => pct(v)], ["Sharpe", "sharpe", (v) => num(v, 2)],
    ["Annual turnover", "turnover", (v) => pct(v, 0)],
  ];
  const settings = [
    ["Universe", "universe", (v) => `${v?.length ?? 0} instruments${v?.length ? ` (${v.slice(0, 3).join(", ")}${v.length > 3 ? ", …" : ""})` : ""}`],
    ["Period", "start", (_, c) => `${c.start} → ${c.end}`],
    ["Rebalance", "rebalance", (v) => v], ["Portfolio", "portfolio", (v) => v],
    ["Top N / exit rank", "top_n", (_, c) => `${c.top_n} / ${c.exit_rank}`],
    ["Entry", "entry", (v) => v], ["Position cap", "max_position", (v) => v == null ? "None" : pct(v, 0)],
    ["Category cap", "max_category", (v, c) => c.dataset === "broad" ? (v == null ? "None" : pct(v, 0)) : "—"],
    ["Max share price", "max_stock_price", (v, c) => c.dataset === "broad" ? (v ? `₹${v.toLocaleString("en-IN")}` : "None") : "—"],
    ["Lookbacks", "lookbacks", (_, c) => `${c.lookbacks?.join("/")} weeks · weights ${c.weights?.join("/")}`],
    ["Crash protection", "defensive", (v, c) => v === "filter" ? `Cash filter, ${c.filter_lookback} weeks` : v],
    ["Cost model", "cost_model", (v, c) => v === "itemised" ? "Itemised" : `${c.cost_pct}% per side`],
    ["Ranking score", "score", (v) => v || "ranksum"],
    ["Price basis", "track", (v, c) => c.dataset === "etf" ? `${v} · ${c.execution}` : "Direct price"],
    ["Tax", "tax", (v, c) => v ? `After tax, ${Math.round(c.slab_rate * 100)}% slab` : "Pre-tax"],
    ["Category mode", "broad_category_mode", (v, c) => c.dataset === "broad" ? v : "—"],
    ["Broad pool", "broad_pool_top_n", (_, c) => c.dataset === "broad" ? `${c.broad_pool_top_n} / ${c.broad_pool_exit_rank}` : "—"],
    ["Broad category rule", "broad_category_top_n", (_, c) => c.dataset === "broad" ? `${c.broad_category_top_n} / ${c.broad_category_exit_rank} · ${c.broad_picks_per_category} stocks each` : "—"],
    ["Broad direct stocks", "broad_off_top_n", (_, c) => c.dataset === "broad" ? `${c.broad_off_top_n} / ${c.broad_off_exit_rank}` : "—"],
  ];
  const comparisonHtml = comparison ? `<div class="compare-controls"><label>Compare current run with
      <select id="compare-run">${runs.slice(1).map((run) => `<option value="${esc(run.id)}" ${run.id === comparison.id ? "selected" : ""}>${esc(run.name || `Run ${run.n}`)}</option>`).join("")}</select></label></div>
    <div class="compare-table-wrap"><table class="data compare-table"><thead><tr><th>Metric</th><th>${esc(current.name || `Run ${current.n}`)}</th><th>${esc(comparison.name || `Run ${comparison.n}`)}</th></tr></thead>
    <tbody>${metrics.map(([label, key, format]) => `<tr><th>${label}</th><td class="num">${format(current.kpis[key])}</td><td class="num">${format(comparison.kpis[key])}</td></tr>`).join("")}</tbody></table></div>
    <h3>Settings that differ</h3><div class="setting-diffs">${settings.filter(([, key, format]) => key === "universe" ? JSON.stringify(current.config.universe) !== JSON.stringify(comparison.config.universe) : format(current.config[key], current.config) !== format(comparison.config[key], comparison.config))
      .map(([label, key, format]) => `<p><b>${label}</b><span>${esc(format(current.config[key], current.config))} → ${esc(format(comparison.config[key], comparison.config))}</span></p>`).join("") || "<p>Key settings match.</p>"}</div>` : "<p class=\"explain\">Run another configuration to compare performance and settings.</p>";
  panel.innerHTML = `${comparisonHtml}<h3>Saved runs</h3><p class="explain">Name a run to find it later. Select Overlay to draw it on the Overview chart.</p>
    <div class="runs">${runs.map((run, i) => `
      <div class="run-row">
        <label class="overlay-control"><input type="checkbox" data-overlay="${run.id}" ${run.overlay ? "checked" : ""} ${i === 0 ? "disabled" : ""}> Overlay</label>
        <div><span class="swatch" style="background:${run.color}"></span><input class="run-name" type="text" aria-label="Name for run ${run.n}" data-name="${run.id}" value="${esc(run.name || `Run ${run.n}`)}" maxlength="64">${i === 0 ? " (current)" : ""}
          <div class="stats">${esc(run.title)}</div>
          <div class="stats">CAGR <b>${pct(run.kpis.cagr)}</b> · edge ${pct(run.kpis.excess, 1, true)} · max DD ${pct(run.kpis.max_drawdown)} ·
            Sharpe ${num(run.kpis.sharpe, 2)} · churn ${pct(run.kpis.turnover, 0)} · ${num(run.kpis.holdings)} held</div></div>
        <div><button type="button" class="ghost" data-load="${run.id}">Load settings</button>
          <button type="button" class="ghost" data-remove="${run.id}">Remove</button></div>
      </div>`).join("")}</div>`;
  $("#compare-run", panel)?.addEventListener("change", (e) => { compareRunId = e.target.value; renderRuns(panel); });
  $$("[data-name]", panel).forEach((input) => input.addEventListener("change", () => {
    const run = runs.find((item) => item.id === input.dataset.name);
    if (run) { run.name = input.value.trim() || `Run ${run.n}`; saveRuns(); renderRuns(panel); }
  }));
  $$("[data-overlay]", panel).forEach((c) => c.addEventListener("change", () => {
    const run = runs.find((x) => x.id === c.dataset.overlay);
    run.overlay = c.checked;
    saveRuns();
    if (lastResult) renderMainChart(lastResult);
  }));
  $$("[data-load]", panel).forEach((b) => b.addEventListener("click", () => {
    applyConfig({ ...defaultConfig(), ...runs.find((x) => x.id === b.dataset.load).config });
    showAppView("backtest");
    window.scrollTo({ top: 0 });
  }));
  $$("[data-remove]", panel).forEach((b) => b.addEventListener("click", () => {
    runs = runs.filter((x) => x.id !== b.dataset.remove);
    saveRuns();
    renderRuns(panel);
    if (lastResult) renderMainChart(lastResult);
  }));
}

init();
