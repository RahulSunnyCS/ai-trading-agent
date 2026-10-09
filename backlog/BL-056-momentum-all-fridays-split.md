# BL-056 — Momentum: backtest and follow a config with its money split across every rebalance Friday

| | |
|---|---|
| **Priority** | P0 — set by the owner (2026-10-09); how real money should follow any config that trades every 2 or 4 weeks |
| **Status** | Planned |
| **Type** | feature |
| **Area** | momentum / dashboard |
| **Created** | 2026-10-09 |
| **Depends on** | BL-051 (saved-run groups), BL-054 (the measurement below) |
| **TODO.md row** | — (filled in when started) |

## Context

A config that rebalances every K weeks has K possible trading calendars (`Config.rebalance_offset`
0..K-1). Which one you pick is luck. On the 10 top Broad configs (BL-054 L2,
`packages/momentum-backtesting/docs/bl054-levers-2026-10-09.md`), pre-tax:

| Median over 10 configs | CAGR |
|---|---|
| Luckiest single Friday | 43.8% |
| The Friday the search picked | 41.3% |
| All Fridays, money split equally | 40.4% |
| Unluckiest single Friday | 35.1% |

Five Sectors Monthly alone runs from 34.6% to 44.8% purely by calendar. Splitting removes the
gamble; it does not raise the average. Every after-tax number in BL-054 already assumes the
split. The owner (2026-10-09) wants it in the dashboard, both to backtest and to follow with
money.

**Measured after tax at Rs 5 lakh, 2017-2026** (`scripts/bl054_phase_split.py`, output
`data/search/round7_A/bl054/phase_split/phase_split.csv`): the split's worst fall is shallower
than the typical single Friday's in 10 of 10 configs (median -27.6% against -31.1%; the
unluckiest Friday -35.7%) and its Ulcer index is lower in 10 of 10 (9.9% against 10.8%), in
both FY2018-22 and FY2023-26; CAGR lands mid-range (31.5%, single Fridays 27.5% to 33.9%). A
measurement, not a pre-registered test, but consistent across every config and both windows.

**What already exists (reuse, do not rebuild):**
- `packages/momentum-backtesting/src/momentum_backtesting/tranches.py`: K equal sub-portfolios on
  staggered offsets, `capital / K` each, curves averaged; separate tax ledgers (documented as
  slightly pessimistic).
- `method._score_group` and `scripts/bl054_levers.py`: every phase, blended by
  `pd.concat(phases, axis=1).mean(axis=1)`.
- `api.py`: `BacktestRequest.rebalance_every` / `rebalance_offset`; background jobs with stages
  and lazily built sections (`analysis.payload_parts`, `run_parts.RunParts`,
  `GET /api/backtest/jobs/{id}/sections/{name}`). A new section needs `api.BacktestSection` and
  `MomentumSectionName` in `apps/dashboard/src/types/momentum.ts`.
- Saved-run groups (BL-051): `runs_store.create_group`, `POST /api/saved-runs/groups`;
  `groups.py` combines sleeves' weekly signals into one Telegram message; the Phase 6 ensemble is
  already a group of four sleeves on different Fridays. `SavedStrategiesView.tsx` has
  `createGroup()`.
- Settings: `components/momentum/MomentumSettingsPanel.tsx`, `lib/momentumConfig.ts`.

## Goal

1. A backtest can be run "All Fridays": the blended curve, plus each Friday's figures.
2. A saved strategy can be followed "on all Fridays": one group, one sleeve per Friday, one
   Telegram message and journal entry per week.
3. Nothing changes for an existing run or favourite unless the owner opts in.

## Out of scope

Changing the frozen Phase 6 ensemble; any new research; weekly (every = 1) configs, which have
only one calendar.

## Plan

### Phase 1 — API
- **Tasks:** `BacktestRequest.split_fridays: bool = False` (meaningful only when
  rebalance_every > 1): run every offset with `capital / K` and return the blended equity as the
  run's curve; a lazily built `friday_spread` section with each offset's CAGR, max drawdown and
  Ulcer (after tax when the request is taxed). Add the field to the request key and
  `saved_identity.fingerprint`, and follow the Broad ranking cache-key rules in the package
  CLAUDE.md.
- **Done when:** a test shows the split result equals the mean of the per-offset runs; the flag
  is in the key and fingerprint; momentum goldens unchanged.

### Phase 2 — Dashboard backtest
- **Tasks:** a "Fridays: One / All (split)" `SegmentedControl` beside the rebalance cadence
  (disabled when every = 1); a "Friday luck" card (each Friday against the split), following the
  Analytics page pattern, `components/ui/` controls, `lib/format.ts` and design tokens; the
  Guide pages for the changed screens in the same commit.
- **Done when:** dashboard unit tests and `bun run --filter @ata/dashboard typecheck` pass and the
  card renders on a real Broad run.

### Phase 3 — Follow on all Fridays
- **Tasks:** a "Follow on all Fridays" action on a saved strategy with rebalance_every > 1: save
  one run per offset (same config, `rebalance_offset` 0..K-1, capital / K) and `create_group`
  them as "<strategy> · all Fridays"; respect `MAX_FOLLOWED` and the status rules; show which
  sleeve trades this Friday on the This week page.
- **Done when:** a test creates the group from a saved run, the weekly job journals each sleeve,
  and the group's Telegram message names this week's sleeve and its orders.

## Risks

- K times the compute for a split backtest (about 20 s becomes about a minute for a monthly
  config): keep it a background job.
- Tax: separate ledgers per sleeve understate how losses offset gains in one real account.
- More, smaller orders every week; the flat Rs 16 depository charge counts more.

## Open questions

To ask the owner when this is started:
1. Should "All Fridays" be the default for configs with rebalance_every > 1, or opt-in?
2. Equal capital reset each April (the groups convention), or never rebalance the sleeves
   against each other?
3. With tax on, one shared tax ledger (what one account really does) instead of
   `tranches.py`'s separate ledgers?
4. Where should each Friday's orders appear on the This week page for a split group?

## Log

- 2026-10-09 — created at P0 by the owner, from the BL-054 L2 result.
- 2026-10-09 — the split-against-single-Friday measurement landed (above): shallower falls in 10 of 10.
