# Momentum: portfolio rule and entry rule

**Status:** Tested · **Last updated:** 2026-10-14

## What it is

| Parameter | Default (where) | Mechanism | Grade |
|---|---|---|---|
| `portfolio` | `buffer` (Config) | Hold until rank fails; proceeds split equally over the current top N, topping up holdings. `slots` = N equal pots, no top-ups | M, TODO 3.9.18 |
| `entry` | `wait` (Config). `make_room` available | `make_room` trims all holdings equally to buy a new top-N name at once. `wait` holds off until a sale frees cash | M, TODO 3.9.23 |

## Live value

- ETF rotation: `portfolio = "buffer"`, `entry = "wait"` (`live_config.toml`).
- Broad search: `entry` is searched (`wait`, `make_room`) in
  [`round7_A.toml`](../../../packages/momentum-backtesting/search_spaces/round7_A.toml); three of
  the four frozen ensemble configs use `make_room`
  ([`bl010_phase6_frozen.json`](../../../packages/momentum-backtesting/search_spaces/bl010_phase6_frozen.json)).

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| TODO 3.9.18 | `slots` vs `buffer` | ETF and Broad (Broad on the gapped engine) | Buffer kept: it compounds winners; slots not adopted | TODO 3.9.18 |
| TODO 3.9.18 | `make_room` vs `wait` | full sample, Broad on the gapped engine | Reported a "clean win"; superseded below | TODO 3.9.18 |
| TODO 3.9.23 dry run | `make_room` vs `wait` | ETF and Broad (every week simulated), 28 rolling 3-year windows | **Do not flip the default** | ETF 25.2% / 1.02 / -29.1%, rolling 46 / 57 / 82%, median -1.4 (smoother, less return). Broad 31.3% / 1.05 / -20.4%, rolling 61 / 64 / 21%, median +0.1 (a marginal win with worse drawdowns) |

## What we know

- The 3.9.18 `make_room` win came from one full-sample run on an engine that skipped thin Broad
  weeks ([min_ranked](../strategies/broad/min-ranked.md)). Rolling windows do not confirm it.
- On ETFs `make_room` gives a smoother ride but less money.
- The search still offers `make_room`, and the frozen ensemble uses it; that is a search pick,
  not a tested default.

## Not yet tested

- `slots` under the rolling-window rule on the corrected Broad engine.

## In plain words

**Portfolio rule "buffer" (default).** Keep everything you bought until it fails the exit rank.
When something is sold, split the cash equally across the current top N, topping up the ones
we already own. The alternative, "slots", gives each slot its own pot and never tops up.

**Entry rule "wait" vs "make room".** When a new name enters the top N but nothing was sold,
"wait" holds off until there is cash. "Make room" trims every holding a little to buy it
immediately. An earlier test said make room was a clean win (TODO 3.9.18). The stricter test
says no: on ETFs it gives a smoother ride but less money, and on Broad it is a coin-flip with
deeper falls. Keep "wait" (TODO 3.9.23).

## Related

- [Top N and exit rank](top-n-exit-rank.md), [caps](caps.md), [cadence](cadence.md).
