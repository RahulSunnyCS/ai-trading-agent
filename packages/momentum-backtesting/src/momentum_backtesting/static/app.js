"use strict";

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------
const GROUP_ORDER = ["Broad", "Sector", "Thematic", "Commodity", "International", "Debt"];
const LOOKBACK_PRESETS = {
  equal: [[1, 1], [4, 1], [13, 1], [26, 1], [52, 1]],
  recency: [[1, 1.5], [4, 1.25], [13, 1], [26, 1], [52, 0.8]],
  long: [[4, 1], [13, 1], [26, 1], [52, 1]],
  short: [[1, 1], [4, 1], [13, 1]],
};
const RUN_COLORS = ["#8b5cf6", "#10b981", "#ef4444", "#0ea5e9", "#d946ef", "#84cc16", "#f97316", "#64748b"];
const MAX_RUNS = 12;

let meta = null;
let lastResult = null;
let lastConfig = null;
let runs = loadRuns();

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

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------
async function init() {
  try {
    const res = await fetch("/api/meta");
    const body = await res.json();
    if (!res.ok) throw new Error(body.detail || res.statusText);
    meta = body;
  } catch (err) {
    setStatus(`Couldn't load data: ${err.message}`, true);
    $("#data-range").textContent = "No data";
    return;
  }
  $("#data-range").textContent =
    `Data ${fmtDate(meta.first_week)} → ${fmtDate(meta.last_week)} · ${meta.instruments.length} instruments`;
  buildUniverse();
  buildBenchmarks();
  bindEvents();
  applyConfig(initialConfig());
  renderRuns();
  if (typeof Plotly === "undefined") {
    setStatus("The chart library didn't load (it's downloaded once from the internet). Check your connection and reload.", true);
  }
}

function defaultConfig() {
  const d = meta.defaults;
  return {
    universe: meta.instruments.filter((i) => i.include === "core" && i.has_data).map((i) => i.name),
    start: d.start,
    end: meta.last_week,
    lookbacks: d.lookbacks,
    weights: d.lookbacks.map(() => 1),
    top_n: d.top_n,
    exit_rank: d.exit_rank,
    portfolio: d.portfolio,
    entry: d.entry,
    max_position: d.max_position,
    cap_band: d.cap_band,
    defensive: d.defensive,
    filter_lookback: d.filter_lookback,
    cost_pct: d.cost_pct,
    signal_delay: d.signal_delay,
    track: d.track || "index",
    execution: d.execution || "fri_close",
    tax: false,
    slab_rate: 0.3,
    benchmark: d.benchmark,
  };
}

function initialConfig() {
  const fromHash = decodeHash();
  if (fromHash) return { ...defaultConfig(), ...fromHash };
  try {
    const saved = JSON.parse(localStorage.getItem("mbt.config") || "null");
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
function buildUniverse() {
  const root = $("#universe");
  root.innerHTML = "";
  const groups = GROUP_ORDER.filter((g) => meta.instruments.some((i) => i.group === g));
  for (const group of groups) {
    const items = meta.instruments.filter((i) => i.group === group);
    const box = document.createElement("div");
    box.className = "group";
    const note = group === "Debt"
      ? `<span class="group-note">— ranked only in "Debt in ranking" mode</span>` : "";
    box.innerHTML = `<label class="group-head"><input type="checkbox" data-group="${esc(group)}"> ${esc(group)} ${note}</label>`;
    for (const inst of items) {
      const year = inst.first_week ? Number(inst.first_week.slice(0, 4)) : null;
      const late = year && year > 2016 ? `<span class="badge warn" title="Price history starts ${fmtDate(inst.first_week)}">from ${year}</span>` : "";
      const optional = inst.include === "optional" ? `<span class="badge">optional</span>` : "";
      const turnover = inst.etf_turnover_cr_day != null ? `₹${num(inst.etf_turnover_cr_day, inst.etf_turnover_cr_day < 10 ? 1 : 0)} cr/d` : "";
      const row = document.createElement("label");
      row.className = "etf";
      row.title = inst.note || "";
      row.innerHTML = `<input type="checkbox" value="${esc(inst.name)}" data-member="${esc(group)}" ${inst.has_data ? "" : "disabled"}>
        <span>${esc(inst.name)} <small>${esc(inst.trade_etf)}</small>${late}${optional}</span>
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

function applyUniversePreset(name) {
  const pick = {
    core: (i) => i.include === "core",
    all: () => true,
    equity: (i) => ["Broad", "Sector", "Thematic"].includes(i.group),
    none: () => false,
  }[name];
  setUniverse(meta.instruments.filter(pick).map((i) => i.name));
}

function buildBenchmarks() {
  const sel = $("#benchmark");
  sel.innerHTML = meta.instruments
    .filter((i) => i.has_data)
    .map((i) => `<option value="${esc(i.name)}">${esc(i.name)}</option>`)
    .join("");
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
  return {
    universe: selectedUniverse(),
    start: $("#start").value,
    end: $("#end").value || null,
    lookbacks: lb.map((r) => r[0]),
    weights: lb.map((r) => r[1]),
    top_n: Number($("#top_n").value),
    exit_rank: Number($("#exit_rank").value),
    portfolio: radio("portfolio"),
    entry: radio("entry"),
    max_position: Number($("#max_position").value) > 0 ? Number($("#max_position").value) / 100 : null,
    cap_band: Number($("#cap_band").value) / 100,
    defensive: radio("defensive"),
    filter_lookback: Number($("#filter_lookback").value),
    cost_pct: Number($("#cost_pct").value),
    signal_delay: Number($("#signal_delay").value),
    track: $("#track").value,
    execution: $("#execution").value,
    tax: $("#tax").checked,
    slab_rate: Number($("#slab_rate").value),
    benchmark: $("#benchmark").value,
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
  $("#cap_band").value = Math.round((cfg.cap_band ?? 0.05) * 100);
  setRadio("defensive", cfg.defensive);
  $("#filter_lookback").value = cfg.filter_lookback;
  $("#cost_pct").value = cfg.cost_pct;
  $("#signal_delay").value = String(cfg.signal_delay);
  $("#track").value = cfg.track || "index";
  $("#execution").value = cfg.execution || "fri_close";
  $("#tax").checked = !!cfg.tax;
  $("#slab_rate").value = String(cfg.slab_rate);
  $("#benchmark").value = cfg.benchmark;
  syncDependentFields();
  validateLive();
}

function syncDependentFields() {
  const buffer = radio("portfolio") === "buffer";
  $("#entry-options").hidden = !buffer;
  $("#cap-options").style.display = buffer ? "" : "none";
  $("#cap_band").disabled = !(Number($("#max_position").value) > 0);
  $("#filter-weeks").style.display = radio("defensive") === "filter" ? "" : "none";
  $("#slab_rate").disabled = !$("#tax").checked;
  const top = Number($("#top_n").value), exit = Number($("#exit_rank").value);
  const cap = Number($("#max_position").value), band = Number($("#cap_band").value);
  let hint = buffer
    ? `Holds between ${top} and ${exit} ETFs: anything bought is kept until its rank passes ${exit}.`
    : `Always ${top} positions; ranks ${top + 1}–${exit} are kept but block a new buy until sold.`;
  if (buffer && cap > 0) {
    hint += ` No ETF is bought past ${cap}%; one that grows past ${cap + band}% is trimmed back to ${cap}%.`;
    if (top * cap < 100) hint += ` With top ${top} × ${cap}%, only ${top * cap}% can be invested — the rest waits in cash.`;
  }
  $("#rule-hint").textContent = hint;
  const maxLb = Math.max(...readLookbacks().map((r) => r[0]).filter((x) => x > 0), 0);
  $("#period-hint").textContent = maxLb
    ? `Ranking needs ${maxLb} weeks of history, so an ETF joins ${maxLb} weeks after its data starts.`
    : "";
}

function validate(cfg) {
  if (!cfg.lookbacks.length) return "Add at least one lookback.";
  if (cfg.lookbacks.some((w) => !Number.isInteger(w) || w < 1 || w > 260)) return "Lookbacks must be whole weeks between 1 and 260.";
  if (new Set(cfg.lookbacks).size !== cfg.lookbacks.length) return "Each lookback can appear only once.";
  if (cfg.weights.some((w) => Number.isNaN(w) || w < 0)) return "Weights can't be negative.";
  if (cfg.weights.every((w) => w === 0)) return "At least one weight must be above 0.";
  if (!(cfg.top_n >= 1)) return "Top N must be at least 1.";
  if (cfg.exit_rank < cfg.top_n) return `The sell rank must be at least top N (${cfg.top_n}), or new buys would be sold at once.`;
  const includeOf = Object.fromEntries(meta.instruments.map((i) => [i.name, i.include]));
  const ranked = cfg.universe.filter((n) => cfg.defensive === "ranked" || includeOf[n] !== "defensive");
  if (ranked.length < cfg.top_n) {
    return `Only ${ranked.length} ETF(s) will be ranked but top N is ${cfg.top_n}. Select more ETFs or lower top N.`;
  }
  if (cfg.start && cfg.end && cfg.start >= cfg.end) return "The start date must be before the end date.";
  if (cfg.cost_pct < 0) return "Cost can't be negative.";
  if (cfg.max_position != null && !(cfg.max_position > 0 && cfg.max_position <= 1)) return "Max per ETF must be between 1 and 100% (0 = no cap).";
  if (cfg.cap_band < 0) return "The trim band can't be negative.";
  return "";
}
function validateLive() {
  if (!meta) return;
  syncDependentFields();
  const problem = validate(readConfig());
  $("#form-error").textContent = problem;
  $("#run").disabled = !!problem;
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

function bindEvents() {
  $$(".chips [data-preset]").forEach((b) => b.addEventListener("click", () => applyUniversePreset(b.dataset.preset)));
  $$("#period-presets [data-period]").forEach((b) => b.addEventListener("click", () => setPeriod(b.dataset.period)));
  $$(".chips [data-lb]").forEach((b) => b.addEventListener("click", () => { setLookbacks(LOOKBACK_PRESETS[b.dataset.lb]); validateLive(); }));
  $("#add-lookback").addEventListener("click", () => { addLookbackRow(); validateLive(); });
  $("#sidebar").addEventListener("input", validateLive);
  $("#sidebar").addEventListener("change", validateLive);
  $("#run").addEventListener("click", runBacktest);
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !$("#run").disabled) runBacktest();
  });
  $("#log-scale").addEventListener("change", () => {
    if (lastResult) Plotly.relayout("main-chart", { "yaxis.type": $("#log-scale").checked ? "log" : "linear" });
  });
  $$("#tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
}

function showTab(name) {
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab").forEach((p) => (p.hidden = p.dataset.panel !== name));
  // Plotly charts drawn while hidden have zero width; resize once visible.
  if (name === "timeline") Plotly.Plots.resize("timeline-chart");
  if (name === "yearly") Plotly.Plots.resize("yearly-chart");
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

async function runBacktest() {
  const cfg = readConfig();
  const problem = validate(cfg);
  if (problem) { $("#form-error").textContent = problem; return; }
  const button = $("#run");
  button.disabled = true;
  button.textContent = "Running…";
  setStatus("Running backtest…");
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
    localStorage.setItem("mbt.config", JSON.stringify(cfg));
    history.replaceState(null, "", "#" + encodeHash(cfg));
    addRun(cfg, body);
    setStatus("");
    $("#results").hidden = false;
    render(body, cfg);
  } catch (err) {
    setStatus(`Backtest failed: ${err.message}`, true);
  } finally {
    button.textContent = "Run backtest";
    button.innerHTML = 'Run backtest <kbd>Ctrl ↵</kbd>';
    validateLive();
  }
}

function describe(cfg) {
  const capText = cfg.max_position ? `, max ${Math.round(cfg.max_position * 100)}%/ETF` : ", no cap";
  const rule = cfg.portfolio === "buffer"
    ? `Buffer (${cfg.entry === "wait" ? "wait for a sale" : "make room"}${capText})`
    : "Fixed slots";
  const allOne = cfg.weights.every((w) => w === 1);
  const lbs = cfg.lookbacks.map((w, i) => (allOne ? `${w}` : `${w}×${cfg.weights[i]}`)).join("/");
  const guard = { off: "always invested", ranked: "debt in ranking", filter: `cash filter ${cfg.filter_lookback}w` }[cfg.defensive];
  return `${rule} · top ${cfg.top_n}, sell when rank > ${cfg.exit_rank} · lookbacks ${lbs}w · ${guard} · ` +
    `${cfg.universe.length} ETFs · cost ${cfg.cost_pct}%${cfg.signal_delay ? ` · ${cfg.signal_delay}w delay` : ""} · ` +
    `P&L on ${cfg.track === "etf" ? "ETFs" : "index"}` +
    `${{ fri_close: "", mon_open: ", fill Mon open", mon_10am: ", fill Mon 10:00" }[cfg.execution || "fri_close"]} · ` +
    (cfg.tax ? `after tax (${Math.round(cfg.slab_rate * 100)}% slab)` : "pre-tax");
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------
function render(r, cfg) {
  const s = r.series;
  $("#run-title").textContent = `${describe(cfg)} · ${fmtDate(s.dates[0])} → ${fmtDate(s.dates[s.dates.length - 1])}`;
  renderKpis(r, cfg);
  renderMainChart(r);
  renderSignal(r);
  renderTrades(r);
  renderTimeline(r);
  renderEtfs(r);
  renderYearly(r);
  renderCrashes(r);
  renderRuns();
}

function kpiCard(label, value, note = "", cls = "") {
  return `<div class="kpi"><div class="label">${label}</div><div class="value ${cls}">${value}</div><div class="note">${note}</div></div>`;
}

function renderKpis(r, cfg) {
  const k = r.kpis, b = esc(r.benchmark_name);
  const cards = [
    kpiCard("₹1 lakh became", rupeesShort(k.final_value), `${b}: ${rupeesShort(k.benchmark_final_value)}`),
    kpiCard("CAGR", pct(k.cagr), `${b} ${pct(k.benchmark_cagr)} · cash ${pct(k.cash_cagr)}`),
    kpiCard("Edge vs benchmark", pct(k.excess_cagr, 1, true), `a year · beat it ${k.years_beating_benchmark} of ${k.years} yrs`, signClass(k.excess_cagr)),
    kpiCard("Max drawdown", pct(k.max_drawdown), `${b} ${pct(k.benchmark_max_drawdown)} · ${fmtDate(k.max_drawdown_trough)}`, "bad"),
    kpiCard("Sharpe / Sortino", `${num(k.sharpe, 2)} / ${num(k.sortino, 2)}`, `volatility ${pct(k.volatility)}`),
    kpiCard("Churn", pct(k.turnover_per_year, 0), "of portfolio sold per year"),
    kpiCard("Exits / year", num(k.exits_per_year), `${num(k.new_buys_per_year)} new buys · ${num(k.top_ups_per_year)} top-ups`),
    kpiCard("Avg holding", `${num(k.avg_weeks_held, 0)} wks`, `${num(k.avg_holdings)} ETFs held on average`),
    kpiCard("Win rate", pct(k.win_rate, 0), `avg win ${pct(k.avg_win, 1, true)} · avg loss ${pct(k.avg_loss)}`),
    kpiCard("Best / worst exit", `${pct(k.best_trade, 0, true)} / ${pct(k.worst_trade, 0)}`, "position return, entry to exit"),
    kpiCard("Largest position", pct(k.max_position_share, 0), "peak share of the portfolio"),
    kpiCard("Time in cash/debt", pct(k.time_in_cash, 0), `ahead over 52w ${pct(k.pct_rolling_52w_ahead, 0)} of the time`),
  ];
  if (cfg.tax) cards.push(kpiCard("Tax paid", rupeesShort(k.tax_paid), "on ₹1 lakh start, incl. final sale"));
  $("#kpis").innerHTML = cards.join("");
}

function rotationHover(rot) {
  const lines = [`<b>${fmtDate(rot.week)} · ${rupees(rot.value)}</b>`];
  for (const o of rot.outs) {
    lines.push(`<span style="color:${cssVar("--bad")}">OUT</span> ${esc(o.asset)} — held ${num(o.weeks_held, 0)}w, ` +
      `${pct(o.return, 1, true)} (${esc(o.reason)})`);
  }
  for (const i of rot.ins) {
    lines.push(`<span style="color:${cssVar("--good")}">${i.top_up ? "ADD" : "IN"}</span> ${esc(i.asset)} (rank ${num(i.rank, 0)})`);
  }
  for (const t of rot.trims) {
    lines.push(`<span style="color:${cssVar("--warn")}">TRIM</span> ${esc(t.asset)} (${esc(t.reason)})`);
  }
  if (rot.parked) lines.push("PARK — nothing qualified, money to cash");
  if (rot.holdings.length) {
    const top = rot.holdings.slice(0, 9).map((h) => `${esc(h.asset)} ${pct(h.share, 0)}`).join(", ");
    lines.push(`<i>Holding ${rot.holdings.length}: ${top}${rot.holdings.length > 9 ? ", …" : ""}</i>`);
  }
  return lines.join("<br>");
}

function renderMainChart(r) {
  const s = r.series;
  const lakh = (arr) => arr.map((v) => (v == null ? null : v / 1e5));  // plotted in rupees lakh
  const text = (arr, fmt) => arr.map(fmt);
  const good = cssVar("--good"), bad = cssVar("--bad"), accent = cssVar("--strategy");
  const traces = [
    {
      x: s.dates, y: lakh(s.strategy), name: runs.length ? `Strategy (run ${runs[0].n})` : "Strategy",
      type: "scatter", mode: "lines",
      line: { color: accent, width: 2.2 },
      text: s.strategy.map((v, i) => `${rupees(v)} · ${s.holdings_count[i] ?? "–"} held` +
        (s.idle_share[i] > 0.001 ? ` · ${pct(s.idle_share[i], 0)} cash` : "")),
      hovertemplate: "Strategy %{text}<extra></extra>",
    },
    {
      x: s.dates, y: lakh(s.benchmark), name: r.benchmark_name, type: "scatter", mode: "lines",
      line: { color: cssVar("--benchmark"), width: 1.6 },
      text: text(s.benchmark, rupees), hovertemplate: `${esc(r.benchmark_name)} %{text}<extra></extra>`,
    },
    {
      x: s.dates, y: lakh(s.cash), name: "Liquid fund", type: "scatter", mode: "lines",
      line: { color: cssVar("--cash"), width: 1, dash: "dot" },
      text: text(s.cash, rupees), hovertemplate: "Liquid fund %{text}<extra></extra>",
    },
  ];
  runs.filter((run) => run.overlay && run.id !== runs[0]?.id).forEach((run) => {
    traces.push({
      x: run.dates, y: lakh(run.strategy), name: `Run ${run.n}`, type: "scatter", mode: "lines",
      line: { color: run.color, width: 1.4, dash: "dash" },
      text: run.strategy.map(rupees), hovertemplate: `Run ${run.n} %{text}<extra></extra>`,
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
    text: rots.map(rotationHover), hovertemplate: "%{text}<extra></extra>",
  });
  traces.push(
    {
      x: s.dates, y: s.drawdown_strategy, name: "Strategy drawdown", xaxis: "x", yaxis: "y2", type: "scatter",
      mode: "lines", fill: "tozeroy", line: { color: accent, width: 1 }, showlegend: false,
      hovertemplate: "Strategy drawdown %{y:.1%}<extra></extra>",
    },
    {
      x: s.dates, y: s.drawdown_benchmark, name: `${r.benchmark_name} drawdown`, xaxis: "x", yaxis: "y2",
      type: "scatter", mode: "lines", line: { color: cssVar("--benchmark"), width: 1 }, showlegend: false,
      hovertemplate: `${esc(r.benchmark_name)} drawdown %{y:.1%}<extra></extra>`,
    },
    {
      x: s.dates, y: s.rolling_52w_excess, name: "52-week edge", xaxis: "x", yaxis: "y3", type: "bar",
      marker: { color: s.rolling_52w_excess.map((v) => (v == null ? "rgba(0,0,0,0)" : v >= 0 ? good : bad)) },
      showlegend: false, hovertemplate: "Trailing 52w vs benchmark %{y:+.1%}<extra></extra>",
    },
  );
  const grid = cssVar("--border"), fg = cssVar("--text"), muted = cssVar("--muted");
  const layout = {
    height: 720, margin: { l: 70, r: 20, t: 10, b: 30 },
    paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)", font: { color: fg, size: 12 },
    hovermode: "x unified", hoverlabel: { align: "left" },
    legend: { orientation: "h", y: 1.04, x: 0 },
    xaxis: { gridcolor: grid, anchor: "y3", showspikes: true, spikemode: "across", spikethickness: 1, spikecolor: muted },
    yaxis: { domain: [0.45, 1], gridcolor: grid, tickprefix: "₹", ticksuffix: " L", type: $("#log-scale").checked ? "log" : "linear",
      title: { text: "Value of ₹1 lakh invested", font: { size: 11, color: muted } } },
    yaxis2: { domain: [0.23, 0.41], gridcolor: grid, tickformat: ".0%", title: { text: "Drawdown", font: { size: 11, color: muted } } },
    yaxis3: { domain: [0, 0.19], gridcolor: grid, tickformat: "+.0%", title: { text: "52w edge", font: { size: 11, color: muted } } },
  };
  Plotly.react("main-chart", traces, layout, { responsive: true, displaylogo: false });
}

// --- generic sortable table -------------------------------------------------------------------
function renderTable(container, columns, rows, opts = {}) {
  let sortKey = opts.sortKey ?? null;
  let sortDir = opts.sortDir ?? -1;
  let query = "";
  const tools = opts.search || opts.csv
    ? `<div class="table-tools">${opts.search ? `<input type="search" placeholder="${esc(opts.search)}">` : ""}
       ${opts.csv ? `<button type="button" class="csv">Download CSV</button>` : ""}
       <span class="muted count-note"></span></div>` : "";
  container.innerHTML = `${opts.before || ""}${tools}<table class="data"><thead><tr>${columns
    .map((c) => `<th class="${c.num ? "num" : ""} ${opts.sortable === false ? "" : "sortable"}" data-key="${c.key}">${c.label}</th>`)
    .join("")}</tr></thead><tbody></tbody></table>`;
  const tbody = $("tbody", container);

  function value(row, col) {
    return col.sortValue ? col.sortValue(row) : row[col.key];
  }
  function draw() {
    let view = rows;
    if (query) {
      const q = query.toLowerCase();
      view = rows.filter((row) => columns.some((c) => String(row[c.key] ?? "").toLowerCase().includes(q)));
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
    tbody.innerHTML = view.map((row) => `<tr class="${opts.rowClass ? opts.rowClass(row) : ""}">${columns
      .map((c) => `<td class="${c.num ? "num" : ""} ${c.cls ? c.cls(row) : ""}">${c.fmt ? c.fmt(row[c.key], row) : esc(row[c.key])}</td>`)
      .join("")}</tr>`).join("");
    $$("th", container).forEach((th) => {
      th.classList.toggle("sorted-asc", th.dataset.key === sortKey && sortDir === 1);
      th.classList.toggle("sorted-desc", th.dataset.key === sortKey && sortDir === -1);
    });
    const note = $(".count-note", container);
    if (note) note.textContent = `${view.length} of ${rows.length}`;
  }
  if (opts.sortable !== false) {
    $$("th", container).forEach((th) => th.addEventListener("click", () => {
      if (sortKey === th.dataset.key) sortDir = -sortDir; else { sortKey = th.dataset.key; sortDir = -1; }
      draw();
    }));
  }
  const search = $("input[type=search]", container);
  if (search) search.addEventListener("input", () => { query = search.value; draw(); });
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

// --- tabs --------------------------------------------------------------------------------------
function renderSignal(r) {
  const latest = r.latest;
  const lookbacks = latest.rows.length ? Object.keys(latest.rows[0].returns) : [];
  const columns = [
    { key: "rank", label: "Rank", num: true, fmt: (v) => num(v, 0) },
    { key: "asset", label: "ETF" },
    { key: "action", label: "Action", fmt: (v) => (v ? `<span class="action ${esc(v.split(" ")[0])}">${esc(v)}</span>` : "") },
    { key: "score", label: "Score", num: true, fmt: (v) => num(v, 2) },
    ...lookbacks.map((k) => ({
      key: `r${k}`, label: `${k}w`, num: true, fmt: pctCell(1, true), sortValue: (row) => row[`r${k}`],
    })),
    { key: "held", label: "Held", fmt: (v) => (v ? "●" : "") },
  ];
  const rows = latest.rows.map((row) => ({ ...row, ...Object.fromEntries(lookbacks.map((k) => [`r${k}`, row.returns[k]])) }));
  const panel = $('[data-panel="signal"]');
  const openRows = r.open_positions;
  const openTable = openRows.length
    ? `<h2 style="margin-top:18px">Open positions</h2><div id="open-positions"></div>` : "";
  renderTable(panel, columns, rows, {
    sortKey: "rank", sortDir: 1, sortable: true,
    before: `<p class="explain"><b>As of ${fmtDate(latest.week)}.</b> ${esc(latest.explain)}</p>`,
    rowClass: (row) => (row.held ? "held" : ""),
  });
  panel.insertAdjacentHTML("beforeend", openTable);
  if (openRows.length) {
    renderTable($("#open-positions"), [
      { key: "asset", label: "ETF" },
      { key: "entry_week", label: "Since", fmt: fmtDate },
      { key: "weeks_held", label: "Weeks", num: true, fmt: (v) => num(v, 0) },
      { key: "rank", label: "Rank now", num: true, fmt: (v) => num(v, 0) },
      { key: "position_return", label: "Return", num: true, fmt: pctCell() },
      { key: "value", label: "Value (₹1L start)", num: true, fmt: rupees },
      { key: "pnl", label: "P&L", num: true, fmt: (v) => `<span class="${signClass(v)}">${rupees(v)}</span>` },
    ], openRows, { sortKey: "value", sortDir: -1 });
  }
}

function renderTrades(r) {
  renderTable($('[data-panel="trades"]'), [
    { key: "asset", label: "ETF" },
    { key: "entry_week", label: "Entry", fmt: fmtDate },
    { key: "exit_week", label: "Exit", fmt: fmtDate },
    { key: "weeks_held", label: "Weeks", num: true, fmt: (v) => num(v, 0) },
    { key: "entry_rank", label: "Entry rank", num: true, fmt: (v) => num(v, 0) },
    { key: "exit_rank", label: "Exit rank", num: true, fmt: (v) => num(v, 0) },
    { key: "position_return", label: "Return", num: true, fmt: pctCell() },
    { key: "pnl", label: "P&L (₹1L start)", num: true, fmt: (v) => `<span class="${signClass(v)}">${rupees(v)}</span>` },
    { key: "reason", label: "Why sold" },
    { key: "tax", label: "Tax", num: true, fmt: (v) => (v ? rupees(v * 100000) : "–") },
    { key: "proxy", label: "Priced on", fmt: (v) => (v ? `<span class="badge warn" title="The ETF hadn't listed yet, so its index (less the expense ratio) stood in">index proxy</span>` : "") },
  ], r.trades, {
    sortKey: "exit_week", sortDir: -1, search: "Filter by ETF, reason…", csv: "momentum-trades.csv",
    before: `<p class="explain">Every position fully sold. Return and P&L count all purchases of the position, including top-ups.${fillsNote(r.fills)}</p>`,
  });
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
  const assets = [...new Set(segs.map((s) => s.asset))].sort();
  const good = cssVar("--good"), bad = cssVar("--bad");
  const day = 86400000;
  const trace = {
    type: "bar", orientation: "h",
    y: segs.map((s) => s.asset),
    base: segs.map((s) => s.start),
    x: segs.map((s) => Math.max((new Date(s.end) - new Date(s.start)), 7 * day)),
    marker: { color: segs.map((s) => ((s.return ?? 0) >= 0 ? good : bad)), opacity: segs.map((s) => (s.open ? 0.95 : 0.7)) },
    text: segs.map((s) => `<b>${esc(s.asset)}</b><br>${fmtDate(s.start)} → ${s.open ? "now (held)" : fmtDate(s.end)}` +
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
    { key: "asset", label: "ETF" },
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
function loadRuns() {
  try { return JSON.parse(localStorage.getItem("mbt.runs") || "[]"); } catch { return []; }
}
function saveRuns() {
  try { localStorage.setItem("mbt.runs", JSON.stringify(runs)); } catch { /* storage full: keep in memory */ }
}
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
function renderRuns() {
  $("#runs-count").textContent = runs.length ? `(${runs.length})` : "";
  const panel = $('[data-panel="runs"]');
  if (!runs.length) { panel.innerHTML = `<p class="explain">Runs you make appear here.</p>`; return; }
  panel.innerHTML = `<p class="explain">Tick <b>Overlay</b> to draw an earlier run on the main chart (dashed). The newest run is always drawn.</p>
    <div class="runs">${runs.map((run, i) => `
      <div class="run-row">
        <input type="checkbox" data-overlay="${run.id}" ${run.overlay ? "checked" : ""} ${i === 0 ? "disabled title=\"The current run\"" : "title=\"Overlay\""}>
        <div><span class="swatch" style="background:${run.color}"></span><b>Run ${run.n}</b>${i === 0 ? " (current)" : ""}
          <div class="stats">${esc(run.title)}</div>
          <div class="stats">CAGR <b>${pct(run.kpis.cagr)}</b> · edge ${pct(run.kpis.excess, 1, true)} · max DD ${pct(run.kpis.max_drawdown)} ·
            Sharpe ${num(run.kpis.sharpe, 2)} · churn ${pct(run.kpis.turnover, 0)} · ${num(run.kpis.holdings)} held</div></div>
        <div><button type="button" class="ghost" data-load="${run.id}">Load settings</button>
          <button type="button" class="ghost" data-remove="${run.id}">Remove</button></div>
      </div>`).join("")}</div>`;
  $$("[data-overlay]", panel).forEach((c) => c.addEventListener("change", () => {
    const run = runs.find((x) => x.id === c.dataset.overlay);
    run.overlay = c.checked;
    saveRuns();
    if (lastResult) renderMainChart(lastResult);
  }));
  $$("[data-load]", panel).forEach((b) => b.addEventListener("click", () => {
    applyConfig({ ...defaultConfig(), ...runs.find((x) => x.id === b.dataset.load).config });
    window.scrollTo({ top: 0 });
  }));
  $$("[data-remove]", panel).forEach((b) => b.addEventListener("click", () => {
    runs = runs.filter((x) => x.id !== b.dataset.remove);
    saveRuns();
    renderRuns();
    if (lastResult) renderMainChart(lastResult);
  }));
}

init();
