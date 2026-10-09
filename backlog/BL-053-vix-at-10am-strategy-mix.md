# BL-053 — Pick the NIFTY strategy mix at 10:00 from India VIX's first 45 minutes

| | |
|---|---|
| **Priority** | P2 — options research; does not block this month's Momentum work |
| **Status** | Done — killed by its pass rule (exploratory: owner override, no hold-out) |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-09 |
| **Depends on** | none |
| **TODO.md row** | — |

## Context

Owner's idea (2026-10-09 chat): instead of starting every NIFTY strategy at its own time
(09:17–09:35), wait until 10:00, read India VIX, and choose the mix. The chat had already shown
(1) over two years, the two short-premium strategies lose when VIX rises during the day while
Dir 924 and the buy breakout make money then, and (2) VIX's move up to 10:00 does not predict
its move after 10:00 (rank correlation about 0.01). So the owner has already seen last year's
VIX-band results: this test cannot be clean.

## Experiments

### 2026-10-09 — VIX-at-10:00 mix switch, last year
- **Hypothesis:** choosing the mix at 10:00 from VIX's 09:15→10:00 move earns more, with no
  worse drawdown, than holding one fixed mix of the same 6 lots.
- **Universe:** NIFTY weekly options from the trading-data lake (vendor + Fyers 1-minute bars),
  2025-10-09 → 2026-10-08, days `data_quality` marks usable. Strategies:
  `strategies/legwise/nifty_dir_924_itm1_sl21_recost.yaml` (Dir),
  `nifty_buy_range_breakout.yaml` (Buy), `nifty_widesl_917_otm1.yaml` (Widesl), each with
  entry moved to 10:00 and everything else unchanged. Buy's range window becomes 10:00–10:10.
  Exits unchanged. 1-lot runs scaled linearly by lots (AlgoTest multiplier semantics),
  today's lot size on every day, before charges (engine costs 0).
- **Rule:** VIX10 = close of the INDIAVIX 09:59 bar; VIX0915 = open of the 09:15 bar.
  If VIX10 − VIX0915 ≥ 0.25 → directional mix: 2 Dir + 2 Buy + 2 Widesl.
  Otherwise → quiet mix: 4 Widesl + 1 Dir + 1 Buy. (0.25 is the "rose" cut-off already used
  in the earlier analysis, not tuned here.)
- **Look-ahead check:** the signal uses only bars closed by 10:00; every entry is at 10:00 or
  later.
- **Pass / kill rule:** pass only if the switch beats each always-on comparator (A: always the
  directional mix at 10:00; B: always the quiet mix at 10:00) by ≥ 10% in total P&L with a max
  drawdown no worse, **and** beats C (2 Dir + 2 Buy + 2 Widesl at their original times) in
  total P&L. C prices the cost of waiting until 10:00.
- **Hold-out:** none. Owner override, below.
- **Will not run:** other thresholds (0, 0.5), other mixes, the ₹65-premium Widesl, other years.
  Any of them needs a new dated block.
- **Result:** **kill** (fails the pass rule; exploratory anyway). 241 days, 83 (34%)
  directional. 6 lots, before charges: switch ₹2,82,275 (max DD −₹79,771); A ₹2,62,250
  (−₹66,398); B ₹2,62,091 (−₹1,17,182); C ₹2,05,290 (−₹1,72,860). The switch is +7.6% over A
  and +7.7% over B (needs ≥ 10%) and its drawdown is worse than A's. It beats C by 37.5%, but A
  and B beat C by about 28% too: most of the gain comes from starting at 10:00, not from
  switching. Per lot, on VIX-up days vs quiet days: Widesl at 10:00 ₹66 vs ₹241, Dir ₹453 vs
  ₹374, Buy −₹77 vs −₹17 (Buy loses on both, worse on the days the rule gives it 2 lots).
  Waiting until 10:00, 1 lot, last year: Dir ₹56,583 → ₹96,628 (DD −36k → −19k); Widesl OTM1
  ₹37,523 → ₹43,655 (DD −45k → −33k); Buy ₹8,538 → −₹9,158. Run by script over the lake on
  2026-10-09 (not saved to the catalog); per-day rows kept outside the repo.

## Open questions

- The 10:00 start helped Dir 924 and Widesl OTM1 last year. That is a finding on data already
  seen, so it needs its own dated block, best tested on the unseen Mar 2022 – Oct 2024 days,
  before any real strategy changes its entry time.

## Log

- 2026-10-09 — override: owner asked for last year only, which is data already seen in the
  chat. The result is exploratory and cannot by itself justify moving money to this rule.
- 2026-10-09 — ran; killed by its pass rule (Result above).
