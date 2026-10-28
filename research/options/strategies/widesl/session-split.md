# Widesl: session split (two sets a day)

**Status:** Tested · **Last updated:** 2026-10-28

## What it is

Running the Widesl as two trades a day instead of one: a set sold at 09:17 and closed at 12:00, then
a fresh set of the same definition sold at 13:00 (strikes chosen again from the spot) and closed at
15:28. Nothing is held 12:00–13:00. Each half carries its own leg stops and its own overall MTM stop,
so a morning stop-out does not end the day. In the YAML it is two files: the 09:17 file with
`exit_time: "12:00"`, and the same file with `entry_time: "13:00"`.

## Live value

One set a day, 09:17–15:28, in every live and rotation Widesl file.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| Friend's study (not this repo) | NIFTY OTM1, SL 115 %, no trail, MTM ₹2,500; split 09:17–12 + 13–15:29 vs 09:17–15:29 | 2024-09-25 → 2026-10-27, 510 days, ₹40 costs a set | Split +₹82,752 after its costs (₹162 a day), days in profit 60 % vs 53 %, max DD −₹18k vs −₹40k; no interval; the edge sits in two quarters | [BL-182][bl182] Context |
| [BL-182][bl182] Phase 1 | The same split on our engine for the study's definition, the live `N_wide_0917` and `S_wide_0917`, and the four T1 Widesl settings | 2024-10-09 → 2026-10-27, 501 days each index, **after charges** (`ruletest/charges.py`, ₹87 a set), 90 % 5-day block bootstrap, all seen data | **Killed on the registered rule.** Live NIFTY +₹39 [−107, +187] net per lot-day, live SENSEX +₹89 [−63, +241]; gross +₹123 / +₹171; max drawdown halved (₹50k → ₹23k, ₹42k → ₹27k a lot). The study's definition reconciles within 15 % (gross +₹179 [+22, +336]). T1 OTM1 settings +₹77 / +₹84 net, intervals include zero; the ₹150-premium setting −₹115 | BL-182 Result |

## What we know

- The friend's study is right about the shape and wrong only about charges: on our engine the split earns
  about ₹120–180 a day more gross than the whole day for every OTM1/OTM2 definition, and the second set
  costs ₹84 a day more than the study's ₹40 model allows, which takes the live files' net edge to ₹39–89
  with intervals that include zero (BL-182, seen data).
- The robust part is the drawdown: the afternoon set is stopped a third as often as a whole-day set
  (42–47 vs 144–166 MTM stops in 501 days) and a morning stop no longer ends the day, so the max drawdown
  per lot halves for every OTM1/OTM2 definition. Two MTM budgets a day, though (₹5,000 at ₹2,500 a set).
- The halves are not alike across indices: NIFTY's morning and afternoon earn the same (+141 / +138 net);
  SENSEX's morning carries the whole day (+266 vs +83). A closest-premium ₹150 NIFTY set loses with the
  split (−₹115 a day), its morning half earning only +53.
- The gain is concentrated: for the live NIFTY file the split wins 2025 H1 and 2026 H1 and loses the other
  three half-years; the study's own quarters showed the same.
- Not adopted; a cheaper broker or an owner who values the halved drawdown could still prefer it (an
  `override:` in BL-182 would open Phase 2).

## Not yet tested

- Other close or re-entry times (11:30, 12:30, 13:02, 13:30); an afternoon set conditional on the
  morning's result; skipping 12:00–13:00 only on some days to expiry. All registered as "will not run"
  in BL-182 Phase 0.
- The Adaptive two-plus-two book (top two Widesl in the morning, top two in the afternoon) — BL-182
  Phase 2, only on a Phase 1 pass.
- Any unseen days: Phase 1 is on seen data; a forward track (Phase 3) is the only test.

## Related

- [Exit time](exit-time.md) (no earlier exit than 15:28 ranked, 12:00 never tried before this);
  [Entry time](entry-time.md) (the start-time curve is flat before charges; afternoon starts rely on
  late fills).
- [Overall MTM stop](mtm-sl.md): the split gives the day two MTM budgets.
- Script: `packages/option-backtesting/research/bl182/run.py` (outputs git-ignored; regenerate with it).

[bl182]: ../../../../backlog/BL-182-widesl-split-session.md
