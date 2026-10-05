# Dashboard UI review — design system, shell and every tab (2026-10-04)

Reference only. Nothing here is committed work: when a direction is chosen, the phases below
become a backlog item (`backlog/BL-NNN`) and its rows move to `TODO.md`.

The interactive version of this review, with three switchable design directions mocked on the
Momentum result and the Options Lab builder, is published as a private Claude artifact:
<https://claude.ai/artifact/DPikKe4kJKEtF2HoWHnGwg>. This file is the durable text copy.

Method: every view, hook and primitive under `apps/dashboard/src` was read, the dashboard was
run against a mock `:3000` backend and screenshotted at 1440 px and 390 px in both themes, and
the four "classes never compile" claims below were verified against the built stylesheet.

Overlaps with existing backlog items are noted inline: BL-003 (Momentum loading states),
BL-006 (Scores table responsiveness), BL-007 (Momentum UI polish).

---

## 1. Verdict

The console "feels AI-made" for a specific, fixable reason: the token set in `index.css` is the
most common generated-UI look of 2025–26 (warm ivory ground, serif wordmark, terracotta accent,
12 px radius on everything, system sans). It is pleasant and it signals "template". For a tool
whose users compare it with AlgoTest, Quantiply, Sensibull and TradingView, trust comes from
density, numerals and visible state, not warmth. The warm accent also competes with the only
colours that carry meaning on these screens: red and green P&L.

The foundation is strong: semantic HSL tokens, class-based dark mode, shared primitives
(`Card`, `Badge`, `StatCard`, `Table`, `InfoTooltip`, `Accordion`, `RadioCards`), URL-driven
navigation, almost no hardcoded colours. A re-skin is a token swap plus a few primitive
upgrades. The deeper work is information architecture and per-tab UX.

Five things matter most:

1. **The visual identity is the generic one.** Swap to a graphite system with a cool accent,
   mono numerals and tighter radii (Direction B below).
2. **Two unrelated "Backtest" surfaces for options** (`/backtest` YAML engine vs Options Lab
   builder) with incompatible metrics (total ₹ vs ₹/lot vs ₹/lot-day) and three regime
   vocabularies. Merge under Options Lab.
3. **Results land far from the controls that produced them** (Momentum run, builder result,
   day forensics). Move to form + sticky results rail.
4. **No "today" surface.** Nothing answers: is the feed live, is the token valid, what did the
   weekly signal say, how many credits are left.
5. **Settings is only tab visibility; login is the browser's Basic-Auth prompt.**

## 2. Confirmed bugs (fix first, each is a one-liner)

| Where | Bug | Verified how |
|---|---|---|
| `ui/Badge.tsx`, `shell/Sidebar.tsx:56`, `SettingsView.tsx:95`, `momentum/MomentumMonthlyHeatmap.tsx:48`, `momentum/MomentumCompare.tsx:97` | `bg-*/12`, `/14`, `/8` are not in Tailwind 3.4's opacity scale, so eleven classes emit no CSS. Every tinted Badge has no background; the active sidebar item is colour-only text; heatmap mid-band fills are missing. | zero matches in `.next/static/css/app/layout.css`; `/10` and `/15` are present |
| `EditPersonalityDialog.tsx:93` | `bg-surface-1` is not a token (only `surface`, `surface-2`), so the dialog body is transparent over the overlay. Also `shadow-2xl` instead of `shadow-elevated`. | class absent from built CSS |
| `momentum/MomentumWeeklyView.tsx:404` | `text-danger` is not a token; the stock-action error renders in the default colour. | class absent from built CSS |
| `ReplayView.tsx:24` | Filters coverage on `complete` / `gapped`; the API returns `completed` / `in_progress` / `failed` (`types/trading.ts:223`). The list is permanently empty. | source |
| `momentum/MomentumResultDetails.tsx:96` | `cash` missing from `PERCENT_KEYS`, so the yearly table's Liquid fund column prints `0.07` not `7.0%`. | source |
| `optionslab/StrategyBuilder.tsx:460,473` | Result table says ₹ per lot but `Net` and `Worst MTM` render raw totals beside per-lot "Saved" and "Δ / lot" columns. | source |
| `MomentumBacktestingView.tsx:787` | "Refresh data" calls `loadMeta` with no seed and silently resets every edited setting to defaults. | source |
| `MomentumBacktestingView.tsx:822`, `MomentumRebalanceView.tsx:242` | The "What this run tests" summary prints top N / exit rank for Broad (which ignores them) and says "weekly" for every-2/4-week cadences. | source |
| `apps/server/src/server/index.ts:291`, `PnlView.tsx`, `lib/pnl.ts:360` | P&L is computed from the newest 100 trades but labelled all-time; a DB failure returns `[]` and reads as "No paper trades yet"; the cumulative series emits one point per trade keyed by day, which Lightweight Charts rejects as unordered when two trades close on the same day. | source |

Add a Vitest that compiles Tailwind against `src/**` and fails on unknown utilities so the
first class of bug cannot recur.

## 3. Design system

### 3.1 What is wrong beyond the look

- `--faint` is ~2.8:1 on the light background and ~4:1 on dark, below AA, and is used for every
  table header, StatCard label and timestamp.
- Formatting is re-implemented in 15+ places: money with and without ₹, en-IN vs en-US
  grouping, 0/1/2-decimal percentages, four local IST date formatters, "—" vs "––", excess
  CAGR written six ways, turnover with three names. `lib/format.ts` owns none of it.
- Six hand-rolled segmented controls, two copies of underline tabs, two metric tiles, five input
  class strings. `@radix-ui/react-tabs` is a dependency and unused.
- `optionslab/shared.tsx:17` `SERIES_COLORS` are Tailwind default hexes; series 3 and 4 read as
  profit and loss. Momentum overlays alternate positive/negative; the holdings donut palette is
  primary / positive / negative / text / border.
- `Button` has no `loading`, `icon` size or `asChild`; `StatCard` has no hint / delta / loading;
  `StatusDot`, `Skeleton`, `StateMessage` have no ARIA role; `Table`'s sticky header cannot stick
  inside an `overflow-x-auto` wrapper; every `InfoTooltip` has the same aria-label.

### 3.2 Three directions (full tokens and live mock in the artifact)

| | A · Terminal | B · Quant Studio (recommended) | C · Ledger |
|---|---|---|---|
| Character | Near-black blue-tinted graphite, 12.5 px base, 4 px radii, JetBrains Mono numerals, electric-blue accent. Quantiply / Bloomberg register. | Neutral graphite, 13 px base, 8 px radii, IBM Plex Sans + Plex Mono, restrained indigo accent. Linear / Vercel register, dark default, light equally designed. | Today's warm neutrals minus serif and terracotta; teal "ink" accent, Manrope + DM Mono, 6 px radii. |
| Best for | Daily operators watching live MTM and many rows. | A research console used for hours: forms, charts and tables in equal measure. | Brand continuity with the current look. |
| Costs | Light mode second-class; 12.5 px fails some readers; density needs discipline. | Less terminal drama; accent must stay rare. | Smallest distance from the generated look; warm greys fight red/green. |
| Effort | Medium: tokens + density pass on Table / StatCard / Card. | Low: tokens, two fonts via `next/font`, radius var, mono numerals via `.metric`. | Lowest: accent + fonts. |

Direction B dark tokens (for `.dark`): background `#121417`, surface `#191c21`, surface-2
`#20242b`, border `#2a2f38`, border-strong `#3a414d`, foreground `#e8eaee`, muted `#9aa1ac`,
faint `#6c7480`, primary `#7f9cff` on `#0d1020`, positive `#4cc072`, negative `#f07079`,
warning `#e0a24a`, info `#6cb6ff`. Light (`:root`): `#f6f7f9` / `#ffffff` / `#eef0f3` /
`#dfe3e8` / `#c6ccd5` / `#16181d` / `#5f6673` / `#8e95a1` / primary `#3b5bdb` on white /
`#1d8a4a` / `#c7414a` / `#b9771d` / `#2563eb`. Radius 8 px. Series palette (validated for CVD
separation and contrast in both modes): light `#2a78d6 #eb6834 #1baf7a #eda100`, dark
`#3987e5 #d95926 #199e70 #c98500`. Adopt Direction A's table and KPI density as a "Compact"
toggle in Settings rather than as the default.

### 3.3 Primitives to add or extend

`SegmentedControl` (radiogroup, arrow keys), `Tabs` (Radix), `Input` / `Select` /
`NumberField` with string drafts so fields can be cleared, `Toolbar`, `Toast`,
`RefreshButton`, `CopyButton`; `Button` gains `loading`, `size="icon"`, `asChild`;
`StatCard` gains `hint`, `delta`, `loading`; `Badge` gains semantic aliases so "Open",
"Connected", "Completed" and profit stop sharing one green; `lib/format.ts` gains `formatInr`,
`formatPct(n, dp)`, `formatPp`, `formatIstDate`, `formatIstTime`, `formatRelative`, `EMPTY`;
`chartTheme.ts` gains `getSeriesPalette()` from `--series-1..4` tokens.

## 4. Shell, navigation, settings, login

- **Regroup by product.** Overview · Live (Live, Trades, P&L, Personalities) · Options Lab
  (Strategies, Builder, Runs, Daily results, Regimes) · Momentum (Backtest, Scores, Weekly
  signal, Rebalance) · Data (Backfill + Replay as "Coverage") · Account (Brokers, Billing,
  Settings). The YAML Backtest tab and the market-wide Regimes tab fold into Options Lab; Saved
  runs becomes a table inside Momentum › Backtest.
- **Overview home**: market session + IST clock, feed health with last-tick age, token
  countdown, open paper trades + today's P&L, latest weekly signal + next run, credits, evening
  job status. Today the landing tab is Live, which after hours says "Waiting for first tick…".
- **Always-on status cluster** replacing `SystemStatus` (which renders nothing until
  `/api/meta` answers and nothing when it fails): API reachable, Market Open / Pre-open /
  Closed, token as a clickable badge that calls `startFyersLogin()`, credits; dots on mobile.
- **Global token-expiry banner** from two hours before expiry with an inline Login button; the
  server flags near-expiry (`degraded && !needsReauth`) but the card shows plain "Connected".
- **⌘K palette** over tabs, saved strategies and saved runs; ⌘1…6 for sections.
- **Settings**: Appearance (Light / Dark / System, Compact density), Navigation (existing UI
  minus the "N pending items" roadmap leak), Defaults (landing tab, dataset, date range),
  Notifications (Telegram), Account (session, logout), About (version, API URL, simulate /
  broker). Drop the duplicate footer card.
- **Login**: replace HTTP Basic (ignored username, no wrong-password feedback, bare text on
  cancel, 503 bodies naming env vars) with `/login` issuing an HMAC-signed `HttpOnly` cookie from
  the edge middleware, per-IP backoff, a Logout item; keep Basic for `/api` and curl.
- **Roadmap out of the UI**: gate `PendingInfo` behind a dev flag; several entries are stale
  (backfill trigger and suggestion approval already exist).
- **Mobile**: bottom tab bar for the five sections instead of the hamburger drawer; sticky
  first column or card layout for every data table; Momentum settings grids are hard
  `grid-cols-2` at 360 px.
- `document.title` per tab; `aria-label` on `<nav>`; skip link.

## 5. Tab by tab

Severity: P0 blocks trust or correctness, P1 costs time on every visit, P2 polish.

### Momentum › Backtest
- P0 "Refresh data" resets settings; summary wrong for Broad and every-N cadences (§2).
- P1 Run button at the bottom of a form several screens tall; re-run-fresh is an unlabelled
  7 px icon; "Copy shareable link" has equal weight to Run.
- P1 Results a full page below controls; a new run replaces the previous result with a
  skeleton (`hasPreviousResult` hard-coded false).
- P1 Equity chart's hover panel is absolutely positioned over the drawdown and 52-week-edge
  sub-panels; all traces `hoverinfo: 'none'`, so touch has no readout.
- P1 Benchmark inside the collapsed "Costs, timing & tax"; Broad's top N / exit rank in the
  universe group while Portfolio rule says "see above".
- P1 Overlays positive/negative; donut palette semantic; Liquid fund and benchmark in the
  border colour; Max DD always red; detail tiles muted so values look disabled.
- P1 `NumberField` commits `Number(value)` per keystroke (clearing snaps to 0);
  `PercentField` rounds while typing; every settings grid `grid-cols-2` on phones.
- P2 Run tabs "Run 3 · ETF · 12s" with no metric or diff; in-session "Run N" is a different
  sequence from auto-saved "Run N"; "Trade split" Gantt unreadable for Broad; Compare tab
  renders every saved run as a column with no period or benchmark row; tooltips are 75-word
  research write-ups; per-lookback returns that explain each rank are in the payload and never
  rendered.
- **Change**: two-pane at `xl` (settings left with a sticky bottom run bar; results right);
  settings summary chips above results generated by one `describeConfig(config, dataset)`
  shared with the collapsed summary, assumption chips and Rebalance; keep previous result faded
  while running with "vs previous" deltas; benchmark value under each KPI; dock the week detail
  below the plot, add 1Y/3Y/5Y/All with rebasing, series palette for overlays; Period &
  benchmark together; split the Broad universe accordion; `grid-cols-1 sm:grid-cols-2`;
  modified-dot per accordion; split Refresh into "Reload prices" and "Reset to defaults"
  (confirmed); rename Trade split to Timeline & holdings; heatmap benchmark row, total column,
  `%` suffix; Badge for signal actions.

### Momentum › Scores (see BL-006 for the performance side)
- P1 ~750 rows at once, no sticky first column; every sortable header shows ↕ regardless of
  state; "Rank by" duplicates header sorting; raw returns hidden behind expansion; 1-week
  uncoloured; `₹—` for null prices.
- P1 "Score" is 0–100 higher-is-better here and a lower-is-better rank-sum in the backtest
  signals table, unlabelled.
- **Change**: paginate or virtualise; sticky symbol; real sort icons; pill + signed return per
  cell; parent-group filter; a Held / Candidate badge from the active favourite's latest
  signal; rename one of the two "Score" concepts.

### Momentum › Saved runs
- P1 KPIs are a run-on string; edge and average holdings missing from the row; rename saves
  silently on blur; "Load settings" merges over the current form; no read-only run viewer;
  Overlay disabled for index 0 with no explanation; "Telegram active" is a bare radio with no
  confirm; "Settings that differ" covers only the current run's keys and labels 13 of them.
- **Change**: a real table with sortable headers and a sparkline; read-only result viewer;
  "Load settings" replaces rather than merges; one shared Compare (multi-select, period and
  benchmark rows, union-of-keys diff); confirm popover on Telegram-active; active run pinned.

### Momentum › Weekly signal (see BL-003 for loading states, BL-007 for mobile width)
- P1 Run result renders below two unrelated cards; Run is the secondary variant; Send only
  changes the label; status card duplicates Data & schedule.
- P2 Action chips uncoloured; dataset and severity ignored; raw ISO signal week; blocked as a
  lone badge; `text-danger`.
- **Change**: results under the controls with scroll-to; Run primary; inline confirm when Send
  is on; one readiness strip; Badges by action, severity as border tone.

### Momentum › Rebalance
- P0 Summary wrong for Broad; dataset choice disagrees with the section (offers hidden Nifty
  50, omits ETF).
- P1 Manual % entry only; disabled Preview with the reason lines away; result shows only
  deltas (`current_pct` / `target_pct` unused); unbounded price decimals; 820 px min-width.
- **Change**: `describeConfig`; paste holdings and prefill from model target or last signal;
  inline validation; full current → target table with HOLD rows, cash and totals.

### Options Lab › Daily results
- P1 Day click renders forensics at the bottom with no scroll; evening-run card dominates and
  its log stays after completion; token expiry fetched but never shown; ten metrics in 11 px
  text per strategy; no benchmark line, ranking or date range; NIFTY hardcoded in coverage
  line, anatomy fetch and "NIFTY shape" header; QUIET glyph equals the placeholder.
- P2 No skeletons or `InfoTooltip`s anywhere in Options Lab; weekday, DTE/expiry, VIX-open and
  gap in the payload but absent from the grid; strategy name/sha never shown.
- **Change**: inline forensics row or right drawer; evening run as a status bar with
  disclosure; sortable strategy comparison table with sparklines; expiry / DTE / VIX / gap
  columns; sticky day column; underlying from the strategy.

### Options Lab › Market regimes
- P1 Heatmaps lack month and weekday labels, are hover-only and red/green-only; green/red mean
  "above/below base rate" in the matrix and trend direction in the same table; share charts
  reuse `CumulativeLines` with no `%` or 50% reference line.
- P2 Developer messages in the UI ("export DATABASE_URL…", "run uv run obt fyers history");
  custom cuts persisted here but Results and the replay use `DEFAULT_CUTS`.
- **Change**: axis labels and focusable cells; neutral diverging tint for lift; dedicated share
  chart; Expiry vs non-expiry toggle; explanations into tooltips, CLI into `CodeBlock` with
  copy; shared cuts store.

### Options Lab › Strategy builder
- P0 Per-lot unit bug (§2); Save overwrites silently; New resets without confirm; Load select
  always shows "Load saved…"; no dirty indicator; a credit is spent with no disclosure and a
  402 surfaces as a raw string.
- P1 Click-only validation with Python strings at the bottom (the Backtest tab already has
  live debounced validation); row click wired to the first cell only; expanded trade log after
  the whole table; Validate and Save have no pending state; lots snap to 1 on clear; copy-leg
  duplicates ids; no templates; "RE COST / RE ASAP", "Trail SL (every X move SL by Y)",
  OTM1…10, square-off modes have no tooltips.
- P2 API returns `run_id` and stores every experiment; the type drops it and no UI lists past
  builder runs; gross, costs and version sha never shown.
- **Change**: two-pane (collapsible leg summaries left; sticky run rail with date range,
  "Backtest · 1 credit · N left", validation badge, latest result with Δ vs saved, sparkline,
  gross/costs, expiry split); live validation mapping pydantic paths to fields; whole-row click
  with keyboard; busy states; 402 handled; loaded name + version, dirty flag, confirms, unique
  ids, templates; "Recent experiments" from `run_id`.

### Backtest tab (YAML engine)
- P1 Second options backtester under Research with incompatible metrics; no chart though
  sessions carry per-day net; no P&L colouring; negatives as `₹-1,234`; raw regime keys;
  disabled Run gives no reason (needs both dates, no defaults).
- P2 Bootstrap CI paragraph is dead code (request never sets `bootstrap`); past runs cannot
  be reopened though `GET /runs/{id}` exists.
- **Change**: merge into Options Lab as Builder › YAML plus a Runs list; redirect `/backtest`;
  one result component, KPI strip, equity chart and regime badge map.

### Live
- P1 REST straddle panel polls a null stub and can never fill; no market-session context
  (after hours: "Connected" + "Waiting for first tick…" forever); no staleness detection;
  "· Live" unconditional even in simulation; degraded banner has no Login button; three
  severities for the same token condition; a hand-rolled `/api/meta` loop beside `useMeta`.
- P2 ATM ungrouped; ROC unitless; full date + seconds for intraday; tick buffer lost on tab
  switch; no previous-close reference.
- **Change**: market session badge; "Updated 4s ago" with Stale tone past 3× the interval;
  remove or gate the REST panel; Login button in the banner; one tone; day change vs previous
  close; straddle sparkline; tooltips on ATM / CE / PE / ROC / Accel.

### Trades · P&L · Personalities · Regimes
- P0 P&L window / empty-on-error / duplicate-time (§2).
- P1 No ₹ anywhere; raw exit codes; "Open" shares the green used for profit and Connected; no
  filters, sort, export or pagination (`downloadCsv` exists); personality, symbol, strike,
  expiry, exit time, P&L %, regime, VIX at entry in the row and not shown. P&L repeats win rate
  and closed count, line always green, no drawdown / profit factor / expectancy / range.
  Personalities: ten pulsing dots, "M2 engine" copy, suggestions show the new value without the
  current, Approve without confirm, no Reject, transparent dialog accepting NaN. Regimes:
  fixed 30-day NIFTY, raw enum, no legend or distribution.
- **Change**: Trades toolbar persisted in the URL plus the missing columns and an exit-reason
  label map; P&L aggregated per IST day with drawdown, profit factor, daily bars, range,
  per-personality table with Beat-Clockwork Δ; Personalities with Active / Paused / Frozen
  badges, include-inactive, P&L columns, expandable params, Current → Proposed with evidence,
  confirm on Approve; Regimes filter bar, `REGIME_META`, calendar strip, P&L by regime.

### Backfill · Replay
- P0 Replay coverage always empty (§2).
- P1 Backfill never polls while jobs run; no `from ≤ to`; UTC date defaults (a day off before
  05:30 IST); no token pre-flight; raw job id forever; form labels differ from table values.
- P2 No copy buttons; replay commands use a different underlying format from the how-to.
- **Change**: fix the status filter with a test; poll while in progress with a checkpoint
  progress bar; validation and IST defaults; token pre-flight with Login; shared label maps;
  copy buttons; merge into one Data › Coverage tab.

### Broker logins
- P1 Near-expiry invisible; no countdown or pre-market reminder; expired reads as "No API
  token"; every window focus flips to "Checking connection…" and hides the button; the OAuth
  callback tab is unbranded HTML with hardcoded slate colours, UTC expiry and raw JSON on error.
- **Change**: four-state badge with countdown; keep previous status during refetch and poll
  every 60 s; global banner; callback redirects to `/brokerLogins?fyers=connected` and the card
  toasts; "Feed: live / reconnecting" from `/api/meta`.

### Pricing
- P1 `₹X.00` with no grouping, period or inclusions; one `buying` flag for all cards;
  cancellation styled as an error; unknown region shows the India-only message; "development
  mode" copy in production; no current plan, credits or history; two test-mode sources; the
  test-mode banner renders on every tab in the green tone.
- **Change**: rename to Billing with current plan and credits first, plan inclusions and a
  recommended plan, per-plan state, neutral cancellation, success toast with order id, history;
  banner only here, info tone, from the server flag.

### Settings · Login
- See §4.

## 6. Roadmap

| Phase | Scope |
|---|---|
| Week 1 | §2 bug fixes + the Tailwind unknown-utility test; Direction B tokens, `next/font` Plex Sans + Plex Mono, radius and faint-contrast changes, series tokens; `lib/format.ts` owns all formatting. |
| Weeks 2–3 | New primitives (§3.3); always-on status cluster; token-expiry banner; per-tab titles; `PendingInfo` behind a dev flag; sectioned Settings; branded `/login`. |
| Weeks 3–5 | Momentum: two-pane Backtest, sticky run bar, `describeConfig`, previous result kept, chart fixes, Saved runs table + shared Compare, Weekly results under the button with send confirm, Rebalance prefill and full target book. |
| Weeks 5–7 | Options Lab: two-pane Builder with live validation and credit disclosure, Daily results comparison table and inline forensics, merge the YAML tab as Builder › YAML + Runs, one regime badge map. |
| Weeks 7–8 | Overview home; trading-tab upgrades; ⌘K palette; an "Ask the lab" assistant panel in Options Lab built on the existing `obt-mcp` tools (`propose_strategy`, `critique_result`, `run_sweep`, `export_personality`): natural language to a validated leg form, and plain-language explanation of a result. This is the one feature none of the comparison products have and it reuses tooling that already exists. |
