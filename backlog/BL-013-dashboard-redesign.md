# BL-013 — Dashboard redesign: design system, shell, and per-tab UX for Momentum and Options Lab

| | |
|---|---|
| **Priority** | P1 — the dashboard is the paid product surface; today it reads as a generated template, ships eleven CSS classes that never compile, and hides results a page away from the controls that made them |
| **Status** | In progress |
| **Type** | improvement |
| **Area** | dashboard |
| **Created** | 2026-10-05 |
| **Depends on** | none to start. Overlaps: BL-003 (Momentum loading states), BL-006 (Scores table responsiveness), BL-007 (Momentum polish) — those stay separate; this item references rather than absorbs them |
| **TODO.md row** | §3.12.12 (server follow-ups: §3.12.13) |

## Context

Full findings, with file and line references, severities and the trade-offs between the three
visual directions, live in `docs/dashboard-ui-review.md` (text) and the interactive review
<https://claude.ai/artifact/DPikKe4kJKEtF2HoWHnGwg> (switchable mock of each direction on the
Momentum result and the Options Lab builder, both themes). This file is the plan only.

The owner's reaction to the current UI was "good but not that good — feels like AI; something
Quantiply-like would be better". The review confirms the cause: the tokens in
`apps/dashboard/src/index.css` are the standard generated look (warm ivory ground, serif
wordmark, terracotta accent, 12 px radius everywhere, system sans), and the warm accent competes
with the only colours that carry meaning on these screens, red and green P&L. Underneath, the
foundation is sound (semantic HSL tokens, class-based dark mode, shared primitives, URL-driven
navigation, almost no hardcoded colours), so the re-skin is a token swap plus primitive upgrades.

The deeper problems are structural:

- Two unrelated options backtesters (`/backtest` YAML engine and Options Lab › Builder) with
  incompatible metrics (total ₹ vs ₹/lot vs ₹/lot-day) and three regime vocabularies.
- Results render a full page below the controls that produced them (Momentum run, builder
  result, day forensics, weekly run).
- No "today" surface: feed health, token validity, latest weekly signal and credits are not
  visible anywhere together; the chrome's status cluster renders nothing when the API is down.
- Settings is tab visibility only; the remote login is the browser's Basic-Auth prompt.
- Nine confirmed bugs, each a small fix (listed in Phase 1).

## Goal

1. The dashboard has a visual identity a quant trader recognises as a serious tool: neutral
   graphite surfaces in both themes, mono tabular numerals for every figure, one restrained
   accent reserved for primary actions and focus, semantic colour reserved for meaning.
2. Every control sits next to the result it produces, on desktop and phone.
3. One place to backtest options, one KPI vocabulary, one regime vocabulary.
4. The product answers the daily operator questions on its first screen and in its chrome.
5. No class in `src/**` fails to compile; no money, percentage or date is formatted outside
   `lib/format.ts`.

## Out of scope

- Any change to backtest arithmetic, API contracts or the Python services. Where a finding
  needs new data (for example builder `run_id` in the response), the plan adds a frontend type
  and notes the server change as a dependency, not as work in this item.
- The Momentum performance work in BL-005/BL-006 and the loading-state work in BL-003.
- Internationalisation beyond IST and en-IN formatting.
- Live trading surfaces: nothing trades live yet (see `overview.md`).

## Plan

Phases are ordered so the visible win (Phase 2) ships in the first week and each later phase
ships on its own. Estimates assume one engineer.

### Phase 1 — Compile-safe fixes (1–2 days)
- **Tasks:**
  - Replace the opacity modifiers Tailwind 3.4 does not generate: `/12 → /10`, `/14 → /15`,
    `/8 → /10` in `ui/Badge.tsx`, `shell/Sidebar.tsx`, `SettingsView.tsx`,
    `momentum/MomentumMonthlyHeatmap.tsx`, `momentum/MomentumCompare.tsx` (or extend
    `theme.opacity` in `tailwind.config.ts`).
  - `bg-surface-1 → bg-surface`, `shadow-2xl → shadow-elevated` in `EditPersonalityDialog.tsx`;
    `text-danger → text-negative` in `MomentumWeeklyView.tsx`.
  - `ReplayView.tsx`: filter on `completed`; add a test pinned to the server's status union.
  - `MomentumResultDetails.tsx`: add `cash` to `PERCENT_KEYS`.
  - `StrategyBuilder.tsx` result table: show `Net` and `Worst MTM` per lot (divide by lots) or
    relabel and add the total as a second column.
  - `MomentumBacktestingView.tsx`: split "Refresh data" into "Reload prices" (refetch meta,
    keep edits) and "Reset to defaults" (confirmed).
  - One `describeConfig(config, dataset)` helper used by the "What this run tests" strip, the
    collapsed summary, the assumption chips and `MomentumRebalanceView` — correct for Broad and
    for every-N cadences.
  - `lib/pnl.ts`: aggregate the cumulative series to one point per IST day; `PnlView` and
    `TradesView` caption "latest 100 trades" until the API paginates; surface a DB error as an
    error, not an empty state (server returns `{data: []}` on failure — note as a server
    follow-up).
  - Add a Vitest that runs the Tailwind compiler over `src/**` and fails on any utility that
    produces no CSS.
- **Deliverables:** one PR, no visual redesign yet.
- **Done when:** the new Tailwind test passes; every tinted Badge has a background; the sidebar
  active item has a fill; Replay lists completed backfills; the builder day table's units match
  its header.

### Phase 2 — Design tokens and type (3–4 days)
- **Tasks:**
  - Replace `:root` / `.dark` in `index.css` with the chosen direction's tokens (default
    proposal: Direction B "Quant Studio"; values in `docs/dashboard-ui-review.md` §3.2). Add
    `--series-1..4` tokens (validated palette) and expose `getSeriesPalette()` from
    `lib/chartTheme.ts`; replace `optionslab/shared.tsx` `SERIES_COLORS` and the Momentum
    overlay / donut palettes with it.
  - Load the body and mono faces through `next/font` (self-hosted, no layout shift); apply mono
    + `tabular-nums` through the existing `.metric` class and `Td numeric`.
  - `--radius` to 8 px; lift `--faint` to AA on both themes; drop `font-serif` from the wordmark
    and Pricing heading.
  - Dark as the default theme for first-time visitors; a Light / Dark / System control (the
    binary toggle stays as a shortcut).
  - Momentum Plotly layouts: `font.family` and `hoverlabel` from the theme.
- **Deliverables:** token file, font setup, series palette, a short `docs/` note on the token
  roles so new components use them.
- **Done when:** a screenshot sweep of every route at 1440 px and 390 px in both themes shows
  no literal hex outside `chartTheme.ts`, no serif, numerals aligned in every table, and the
  contrast check on `--faint` text passes AA.

### Phase 3 — Primitives and formatting (4–5 days)
- **Tasks:**
  - `lib/format.ts` gains `formatInr`, `formatPct(n, dp)`, `formatPp`, `formatIstDate`,
    `formatIstTime`, `formatRelative`, `EMPTY`; delete the ~15 local formatters (Momentum KPI
    cards, Insights, CircuitExposure, EquityChart, ScoresView, SavedRunsView, Compare,
    Regime/Backfill/Replay/FyersAuthCard date formatters, Pricing `formatPrice`, Backtest
    `fmtInr`, `StraddleCell`).
  - New `ui/` primitives: `SegmentedControl` (radiogroup, arrow keys), `Tabs` (Radix Tabs is
    already a dependency), `Input` / `Select` / `NumberField` (string draft, commit on blur or
    valid, `min`/`max`), `Toolbar`, `Toast`, `RefreshButton`, `CopyButton`.
  - Extend: `Button` (`loading`, `size="icon"`, `asChild`), `StatCard` (`hint`, `delta`,
    `loading`), `Badge` (semantic aliases so Open / Connected / Completed / profit stop sharing
    one green), `Table` (`stickyFirstCol`, `maxHeight`, working sticky header, `TRow onClick`
    with keyboard), `StatusDot` / `Skeleton` / `StateMessage` ARIA roles, `InfoTooltip`
    per-field `aria-label`.
  - Replace the six hand-rolled segmented controls, two underline-tab copies, two metric tiles
    and five input class strings with the primitives.
- **Deliverables:** primitives with unit tests where logic exists (NumberField drafts,
  SegmentedControl keyboard); formatting tests for en-IN grouping and signs.
- **Done when:** `grep` finds no `Intl.NumberFormat` / `Intl.DateTimeFormat` / `toFixed(`
  outside `lib/`; no `role="tablist"` outside `ui/Tabs`; excess CAGR renders one way everywhere.

### Phase 4 — Shell: status, navigation, Settings, login (5–6 days)
- **Tasks:**
  - Status cluster that always renders (`shell/SystemStatus.tsx`): API reachable, market
    session (Open / Pre-open / Closed, computed in IST in `lib/format.ts`), token state as a
    button calling `startFyersLogin()`, credits; dots only on mobile.
  - Global token-expiry banner under the top bar from two hours before expiry; `FyersAuthCard`
    four-state badge with countdown; `useFyersAuthStatus` keeps the previous status during
    focus refetches and polls every 60 s. (Server follow-up: callback redirects to
    `/brokerLogins?fyers=connected|error` instead of inline HTML/JSON.)
  - Regroup `shell/nav.ts`: Overview · Live (Live, Trades, P&L, Personalities) · Options Lab
    (Strategies, Builder, Runs, Daily results, Regimes) · Momentum (Backtest, Scores, Weekly
    signal, Rebalance) · Data (Coverage = Backfill + Replay) · Account (Brokers, Billing,
    Settings). Extend `lib/routes.ts`; keep old paths as redirects; migrate stored
    `NavigationPreferences`.
  - Settings sections: Appearance (theme, Compact density), Navigation (existing UI, without
    the pending-items subtitle), Defaults (landing tab, dataset, date range), Notifications,
    Account, About (`/api/meta` facts). Remove the duplicate footer card. `PendingInfo`
    behind a developer flag; refresh its stale entries.
  - Branded `/login` page and an HMAC-signed `HttpOnly` cookie issued by the edge middleware,
    per-IP backoff, Logout item, generic 503 copy; Basic auth kept for `/api/*` and curl.
  - Per-tab `document.title`, `aria-label` on `<nav>`, skip link; mobile bottom tab bar for
    the five sections plus "More".
- **Deliverables:** new nav, Settings, login, status cluster, banner; redirects for old URLs.
- **Done when:** every old path still lands on its view; the login flow works in a production
  build with and without the Cloudflare tunnel vars; killing the API shows "API unreachable"
  in the chrome within one poll; a token two hours from expiry shows the banner.

### Phase 5 — Overview home (3 days)
- **Tasks:** a landing view with cards for market session and clock, feed health with last
  tick age, token countdown, open paper trades and today's P&L, latest weekly signal and next
  scheduled run, credits, evening Options Lab job status; each card links into its tab. Uses
  existing hooks (`useMeta`, `useLiveTicks`, `usePaperTrades`, weekly status, legwise data
  status, pricing status). Becomes the default tab.
- **Deliverables:** `OverviewView.tsx`, route `/overview`.
- **Done when:** after hours the first screen says "Market closed · next open …" instead of
  "Waiting for first tick…", and every daily question in the Goal is answered without a click.

### Phase 6 — Momentum (8–10 days)
- **Tasks:**
  - Backtest: two-pane layout at `xl` (settings column with a sticky bottom run bar: Run,
    Re-run fresh as a labelled split item, dirty badge, Ctrl+Enter; results on the right);
    settings summary chips above the results from `describeConfig`, each opening its
    accordion; keep the previous result faded while a run computes and pass the real
    `hasPreviousResult`; "vs previous run" deltas and the benchmark value under each KPI;
    split Sharpe / Sortino; move the circuit realism strip into the Performance card for Broad.
  - Equity chart: dock `WeekDetail` below the plot; 1Y / 3Y / 5Y / All with rebasing; overlays
    from the series palette; thin rotation markers below a zoom threshold.
  - Settings panel: Period & benchmark together; split the Broad universe accordion into
    "Universe & tradability" and "Selection"; `grid-cols-1 sm:grid-cols-2`; modified-dot per
    accordion from a diff against defaults; research findings behind a "Why?" disclosure;
    accordion open state kept across collapse.
  - Details: rename Trade split to Timeline & holdings and cap the Gantt to top N by holding
    time; heatmap benchmark row, yearly total, `%` suffix; colour signed cells; signal actions
    as Badges; render the per-lookback returns behind each rank; run tabs show CAGR / edge and
    a diff popover; align the in-session and auto-saved "Run N" names.
  - Scores: pill + signed return per lookback cell; real sort icons; parent-group filter; Held
    / Candidate badge from the active favourite's latest signal; rename the backtest table's
    "Score" to "Rank score". (Paging / virtualisation is BL-006.)
  - Saved runs: a `Table` with sortable headers and a sparkline; read-only result viewer;
    "Load settings" replaces rather than merges; one shared Compare component (multi-select up
    to four, period and benchmark rows, union-of-keys diff labelled from the settings panel);
    confirm popover on "Telegram active"; active run pinned.
  - Weekly: results directly under the controls with scroll-to; Run as primary; inline confirm
    when Send is on; disallow Preview + Send; one readiness strip; action Badges, dataset tag,
    severity as border tone. (Loading states are BL-003.)
  - Rebalance: `describeConfig`; dataset choice aligned with the section; paste holdings and
    prefill from model target or last signal; inline validation beside Preview; full current →
    target table with HOLD rows, cash, totals, responsive columns.
- **Deliverables:** one PR per sub-tab.
- **Done when:** a settings change and its result are visible without scrolling at 1440 px;
  hovering the chart never hides a sub-panel; the two summaries never disagree; Saved runs can
  be sorted by edge and reopened without re-running; Send to Telegram cannot fire without a
  confirmation.

### Phase 7 — Options Lab consolidation (8–10 days)
- **Tasks:**
  - Builder: two-pane layout (collapsible one-line leg summaries left; sticky run rail with
    date range, "Backtest · 1 credit · N left", validation badge, latest result with Δ vs
    saved, sparkline, gross / costs, expiry vs non-expiry); live validation hook mirroring
    `useBacktestValidate`, pydantic paths mapped to inline field errors; whole-row click with
    keyboard and an inline expanded trade log; busy states on Validate / Backtest / Save; 402
    handled as in the Backtest tab; loaded name + version sha, dirty flag, confirm on overwrite
    and New, unique ids on copy, templates (straddle, strangle, iron condor), tooltips on
    RE COST / RE ASAP / Trail SL / square-off / OTM; "Recent experiments" table once the
    response carries `run_id` (server follow-up: add it to `BacktestResponse`).
  - Daily results: evening run as a status bar (token badge with expiry, last run, Run) with
    options and log behind a disclosure; sortable strategy comparison table with sparklines
    replacing the StatCards; inline forensics under the clicked day; Weekday / DTE / VIX-open /
    gap columns; sticky day column; date-range filter; underlying derived from the strategies;
    distinct QUIET glyph and a shared legend; strategy version shown.
  - Market regimes: month and weekday labels, glyphs for direction, focusable cells; neutral
    diverging tint for lift; a dedicated share chart with a 50 % baseline; Expiry vs
    non-expiry toggle; explanations into tooltips and CLI text into `CodeBlock` with copy;
    cuts shared with Results and the replay through one store.
  - Merge the YAML Backtest tab: Builder gains a Form | YAML mode switch hosting the textarea
    and presets (as `RadioCards` with descriptions); a Runs list merges the YAML registry's
    past runs with legwise `adhoc` and `daily` runs, clickable and comparable; one result
    component, KPI strip, equity chart and regime badge map; `/backtest` redirects.
- **Deliverables:** Options Lab with five sub-routes (Strategies, Builder, Runs, Daily
  results, Regimes); `/backtest` retired.
- **Done when:** one place to backtest options; a credit is never spent without the cost shown
  beside the button; clicking a day opens its replay in view; the same regime label renders
  the same badge on every tab.

### Phase 8 — Trading tabs and Billing (5–6 days)
- **Tasks:**
  - Live: market session badge; "Updated Ns ago" with a Stale tone past 3× the expected
    interval; remove or gate the null-stub REST panel; Login button in the degraded banner;
    one tone for token problems; day change vs previous close; straddle sparkline; tooltips on
    ATM / CE / PE / ROC / Accel; `useMeta` instead of the local loop; tick buffer kept in the
    hook.
  - Trades: toolbar (status, personality, date range, Export CSV) persisted in the URL;
    Personality, Exit time + duration, P&L %, Lots × size, Regime columns; exit-reason label
    map; distinct tone for Open.
  - P&L: drawdown, profit factor, average win / loss, daily P&L bars, range control,
    per-personality table with Beat-Clockwork Δ; line coloured by sign.
  - Personalities: Active / Paused / Frozen badges; include-inactive toggle; Net P&L / Win% /
    Trades columns; expandable full params; suggestions inbox with Current → Proposed, P&L %
    and Beat-Clockwork Δ, confirm on Approve; dialog validation and token fix; drop "M2" copy.
  - Regimes: filter bar, `REGIME_META` (label, tone, definition), calendar strip, distribution
    tiles, P&L by regime.
  - Backfill / Replay as Data › Coverage: poll while in progress with a checkpoint progress
    bar, range validation, IST defaults, token pre-flight, shared label maps, copy buttons.
  - Pricing → Billing: current plan and credits first, plan inclusions, recommended plan,
    per-plan buying state, neutral cancellation, success toast with order id, purchase history
    (server follow-up for the history endpoint); test-mode banner only here, info tone, from
    the server flag.
- **Deliverables:** one PR per tab.
- **Done when:** every money figure carries ₹ and en-IN grouping; Trades can be filtered to one
  personality and exported; a stalled feed is labelled Stale within a minute; Billing shows the
  balance a paying user has.

### Phase 9 — Power features (4–5 days, optional)
- **Tasks:** ⌘K command palette over tabs, saved strategies and saved runs with ⌘1…6 for
  sections; an "Ask the lab" assistant panel in Options Lab that calls the existing `obt-mcp`
  tools (`propose_strategy`, `critique_result`, `run_sweep`, `export_personality`) through a
  Fastify proxy: natural language to a validated leg form, and a plain-language explanation of
  a result's loss clusters. The MCP tooling exists; this phase is the UI and the proxy route.
- **Deliverables:** palette; assistant panel behind a feature flag.
- **Done when:** "short straddle at 9:20, 25 % SL, skip expiry days" produces a valid builder
  form without typing in a field.

## Risks

- **Re-skin without agreement on direction.** Phase 2 is cheap to redo but noisy for users;
  pick the direction (open question 1) before starting it. The artifact lets the owner compare
  all three on real screens.
- **Navigation regrouping breaks shared links.** Keep every old path as a redirect in
  `lib/routes.ts` and migrate `ata.navigation.v1` preferences; test with the existing route
  unit tests.
- **Phase 7 touches the credit-consuming path.** Keep the proxy contract unchanged; the only
  behaviour change is disclosure and 402 handling. Any `run_id` surfacing waits for the server
  change.
- **Scope creep from the per-tab list.** Each phase ships alone; anything found during a
  phase that is not in its task list goes to the Log and a follow-up, not into the PR.
- **Font loading on the remote dashboard.** Use `next/font` self-hosting so the Cloudflare
  tunnel setup needs no new allowed origins.

## Open questions

Answered by the owner on 2026-10-05, when the item was started.

1. Direction: B "Quant Studio" as proposed, A "Terminal" for a denser Quantiply-like feel, or
   C "Ledger" to keep the warm brand? And dark as the default theme?
   **Answer: Direction B "Quant Studio". Dark is the default theme for first-time visitors,
   with a Light / Dark / System control in Settings.**
2. Should the YAML backtest engine stay user-facing at all after the merge, or become an
   advanced mode behind a flag?
   **Answer: stays user-facing as Builder › YAML mode, visible to every user; `/backtest`
   redirects there.**
3. Is the "N pending items" roadmap surface wanted anywhere for the owner (developer flag), or
   removed entirely?
   **Answer: keep it behind a developer flag.**
4. Login: is a cookie session acceptable for the remote dashboard, or must it stay Basic auth
   for a reason not in `docs/remote-dashboard.md`?
   **Answer: cookie login page (`/login`, HMAC-signed `HttpOnly` cookie); Basic auth kept for
   `/api/*` and curl.**
5. Billing history and builder `run_id` need small server changes; do those ride this item or
   their own rows in `TODO.md`?
   **Answer: their own `TODO.md` rows (§3.12.13). This item stays frontend-only; the dependent
   UI waits for them.**
6. Phase 9: is the assistant panel in scope for this quarter, or parked?
   **Answer: parked. Phases 1–8 first; revisit Phase 9 (palette and assistant panel) after.**

## Log

- 2026-10-05 — created from the dashboard UI review (`docs/dashboard-ui-review.md`,
  artifact linked above). Plan only; no code changed.
- 2026-10-05 — started. Open questions answered (above); status `In progress`; TODO.md
  §3.12.12 added.
- 2026-10-05 — **Phase 1 done** (branch `feat/bl-013-phase-1`). All ten tasks landed: opacity
  steps changed in the five files (classes changed, `theme.opacity` left alone);
  `EditPersonalityDialog` and `MomentumWeeklyView` tokens; Replay filters on `completed` via
  `lib/backfill.ts`, with `BackfillStatus` now a union in `types/trading.ts` and a test pinned
  to it; `cash` in `PERCENT_KEYS`; builder day table shows Net / lot and Worst MTM / lot;
  "Refresh data" split into "Reload prices" (keeps edits) and "Reset to defaults" (inline
  confirm); `lib/momentumConfig.ts` `describeConfig` used by the strip, the collapsed summary,
  the cadence chip and Rebalance; cumulative P&L series is one point per IST day; "latest 100
  trades" captions on P&L and Trades; `lib/__tests__/tailwindClasses.test.ts` compiles Tailwind
  over `src/**`. Checked: dashboard typecheck, 163 dashboard unit tests, Biome, and a browser
  pass of `/personalities` (edit dialog), `/replay`, `/momentum/backtest` (ETF and Broad),
  `/optionslab/builder` (2-lot backtest) and `/pnl`.
  - Decision: "Reload prices" moves the end date to the new last week only when it was still
    on the old last week; every other setting is untouched.
  - Not done in Phase 1, by design: showing a DB failure on `/api/trades` as an error needs the
    server to stop answering `{data: []}` on failure (§3.12.13).
  - Found outside the task list, not fixed here:
    - Root `bun run test` fails under bun 1.3.14 before running anything: `bun run --workspaces
      test` stops at `packages/notify`, which has no `test` script.
    - `apps/server` unit test `fetchHistoricalCandles — dashboard credential precedence > uses
      the stored token even when env credentials are set` fails on this laptop (964 others
      pass); this branch changes nothing under `apps/server`.
    - The Tailwind test only covers token-bearing utility families (`bg-`, `text-`, `border-`,
      `ring-`, `shadow-`, `rounded-`, `font-`, …); a typo in a layout utility (`flex-`, `grid-`,
      `p-`) is not caught.
- 2026-10-05 — **Phase 2 done** (branch `feat/bl-013-phase-2`, stacked on Phase 1). Direction B
  tokens in `index.css` for both themes; `--series-1..4` with `getSeriesPalette()`,
  `pickSeries()`, `seriesCssColor()` and `plotlyChrome()` in `lib/chartTheme.ts`; Options Lab's
  `SERIES_COLORS`, the Momentum comparison/overlay lines and the holdings donut now use the
  series palette; IBM Plex Sans / Plex Mono through `next/font`; `.metric` and `Td numeric` set
  figures in mono; `--radius` 8 px; no serif; dark default with Light / Dark / System in
  Settings › Appearance; Plotly and Lightweight Charts take their font from the theme; token
  roles in `docs/dashboard-design-tokens.md`. Checked: typecheck, 177 dashboard unit tests
  (new: token contrast, theme preference), Biome, and a browser pass in dark and light at
  1440 px (Momentum backtest, Options Lab results, Trades, Settings) and light at 390 px (P&L).
  - Decision: `--faint` is `#687080` (light) and `#868e9a` (dark), not the review's `#8e95a1` /
    `#6c7480`, which measure 2.8:1 and 3.9:1. The chosen values pass AA on background and
    surface; light faint on `surface-2` is 4.36:1.
  - Decision: the 13 px base size from the review's description of Direction B was not applied.
    Sizes here are Tailwind `rem` classes, so changing the root size would shrink every control;
    density is Phase 4's "Compact" setting.
  - Not checked: the Momentum Plotly charts (equity, yearly, timeline, donut) were not rendered
    in the browser pass, because running a backtest auto-saves a run to the owner's saved runs.
    The sweep was a sample of routes, not every route in every theme and width.
  - Found outside the task list, not fixed here:
    - Light-theme `positive` (4.1:1) and `warning` (3.4:1) text on `background` are below AA at
      the review's values; small coloured figures are affected.
    - The series palette has four colours where Options Lab had six, so a fifth strategy on one
      chart repeats the first colour.
- 2026-10-05 — **Phase 3 done** (branch `feat/bl-013-phase-3`, stacked on Phase 2).
  `lib/format.ts` now owns display formatting (`formatNumber`, `formatInt`, `formatInr`,
  `formatPct`, `formatPp`, `formatMultiple`, `formatIstDate`, `formatIstTime`,
  `formatIstDateTimeShort`, `formatDay`, `formatRelative`, `formatDuration`, `EMPTY`) and every
  view calls it; new `ui/` primitives `SegmentedControl`, `Tabs`, `Input` / `Select` /
  `NumberField`, `Toolbar`, `Toast`, `RefreshButton`, `CopyButton`; `Button` (`loading`,
  `size="icon"`, `asChild`), `StatCard` (`hint`, `delta`, `loading`), `Badge` (`status`),
  `Table` (`stickyFirstCol`, `maxHeight`, clickable `TRow`), and ARIA on `StatusDot`,
  `Skeleton`, `StateMessage`, `InfoTooltip`. Both done-when greps are empty: no
  `Intl.*` / `toFixed` / `toLocale*` outside `lib/`, no `role="tablist"` outside `ui/Tabs`.
  Checked: typecheck, 201 dashboard unit tests (new: formatters, NumberField drafts,
  SegmentedControl keyboard), Biome, and a browser pass of Momentum (all five sections, both
  datasets), Options Lab builder, Backfill, Replay and Live in dark at 1440 px.
  - Visible changes that come with one formatter: negative rupees read `-₹1,234` (were
    `₹-1,234`); numbers of 1,000+ that used `toFixed` gain en-IN grouping (trade-log prices,
    Pricing); a signed zero reads `0.0%` (was `+0.0%`); dates read `05 Oct 2026`; the Momentum
    "Updated" time is IST 24-hour (was browser-local); Edge vs benchmark is `+1.2 pp` on the
    KPI tile and in Saved runs (was `1.2 pp` / `1.2%`); Scores percentages show fixed decimals.
  - Visible changes that come with the primitives: dataset switches and Stocks / Sectors are
    segmented radiogroups; section and run tabs are Radix tabs (active = solid primary pill);
    number fields can be cleared and settle on blur instead of snapping to 0 or NaN; Open,
    Connected and Completed badges no longer share the profit green (info, primary, neutral);
    Replay commands have copy buttons; the builder's day row is clickable as a whole.
  - Left for later, deliberately: raw ISO dates printed as-is (circuit lock dates, signal week,
    saved-run period) — an existing test pins them; "Beat X by 1.2% a year" in Insights and the
    yearly table's Difference column stay `%` because `formatPp` is always signed; the YAML
    textarea and the "Running…" buttons were not moved to `inputClass` / `Button loading`;
    `Toolbar`, `Toast`, `StatCard` `hint`/`delta` and `Table` `stickyFirstCol`/`maxHeight`
    exist but have no caller yet (Phases 6–8 use them); nullable number fields (blank = off)
    keep their local input.
  - `e2e/momentum-rebalance.spec.ts` selectors updated for the radiogroup; the Playwright suite
    itself was not run (it is stale: BL-008).
- 2026-10-05 — Phase 3 leftovers closed on the same branch: the raw ISO dates now go through
  `formatDay` (circuit lock and exit dates, signal week, saved-run period, result period, the
  Insights drawdown date; the component test's expected strings were updated); Insights and the
  yearly table's Difference column use `formatPp` (unsigned inside the "Beat X by …" sentence);
  the YAML textarea uses `fieldClass`; the two "Running…" buttons use `Button loading`;
  `Tabs` items take a `title`; `formatPnl` accepts null. One ETF backtest was run in the
  browser to check the KPI cards, insights line, equity chart and yearly chart after Phases 2
  and 3 (it auto-saved one run to the owner's saved runs).

