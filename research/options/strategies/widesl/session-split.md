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
| [BL-182][bl182] Phase 2 (owner override) | Adaptive (list C) picking two morning Widesl (09:17–11:47 → 12:00) and two afternoon (13:02–15:02 → 15:28) from Core's six Widesl families, against its top two whole-day Widesl from the same families | 434 pick days 2025-01-10 → 2026-10-27, after charges, per margin lot-day (book net ÷ 2), 90 % block bootstrap, seen data | **Killed on the rule.** Net +₹75 [−56, +205], gross +₹158 [+27, +288], ₹5-brokerage +₹112 [−18, +243]; drawdown −14k vs −17k; the gain entirely in T1's selection year (+178) and nil after (−1); the afternoon pair alone (+199) beats two whole-day sets (+188) | BL-182 Result (Phase 2) |

## What we know

- The friend's study is right about the shape and wrong only about charges: on our engine the split earns
  about ₹120–180 a day more gross than the whole day for every OTM1/OTM2 definition; under our charge
  model the second set adds ₹84 a day (₹171 for two sets against ₹87 for one), ₹44 more than the study's
  ₹40 allows, which takes the live files' net edge to ₹39–89 with intervals that include zero (BL-182,
  seen data).
- The robust part is the drawdown: the afternoon set is stopped a third as often as a whole-day set
  (42–47 vs 144–166 MTM stops in 501 days) and a morning stop no longer ends the day, so the max drawdown
  per lot halves for every OTM1/OTM2 definition. Two MTM budgets a day, though (₹5,000 at ₹2,500 a set).
- The halves are not alike across indices: NIFTY's morning and afternoon earn the same (+141 / +138 net);
  SENSEX's morning carries the whole day (+266 vs +83). A closest-premium ₹150 NIFTY set loses with the
  split (−₹115 a day), its morning half earning only +53.
- The gain is concentrated: for the live NIFTY file the split wins 2025 H1 and 2026 H1 and loses the other
  three half-years; the study's own quarters showed the same.
- Brokerage does not decide it: re-read at Shoonya's ₹5 an order the live files read +77 (NIFTY) and +126
  (SENSEX) a day, at Angel One's ₹20 an order over two lots +53 and +103, and the 90 % interval stays
  about ±150 wide, so no live file clears zero at any rate (BL-182 Log, post-hoc, descriptive).
- Adaptive picking does not rescue it (Phase 2, owner override): two morning + two afternoon Widesl
  against two whole-day from Core's six families reads +₹75 [−56, +205] net per margin lot-day; the gain
  sits in one of the two years (and in the other year on NIFTY alone), the mark of noise. The morning
  pair alone earns ₹64 a day; the afternoon pair alone ₹199, more than two whole-day sets (₹188) with a
  shallower drawdown: the split's gain is the afternoon re-entry.
- A tighter stop on the two sets makes it worse (BL-182 E1, owner override): at ₹2,000 a set the Adaptive
  split reads +₹82 [−61, +224] with a drawdown now deeper than the whole-day book's, and the fixed live
  files +₹1 (NIFTY) / +₹37 (SENSEX) a day; the afternoon's smaller premiums hit a ₹2,000 stop more often.
- The morning set wants a looser overall stop, not a tighter one (BL-182 E2, a nine-level sweep on seen
  data): below ₹2,500 every level earns less (the stop hit on 41–99 % of pick-days); at ₹3,000 / ₹4,000
  Adaptive's morning book earns +140 / +168 a day against +64, higher in every half-year, and the split
  then clears zero (+151 [+13, +287], +178 [+34, +319]) with a drawdown shallower than the comparator's;
  the morning book's own drawdown deepens, and the fixed 09:17 files barely move. A lead for a
  registration with one level fixed in advance.
- Profit targets hurt the morning set at every level, ₹500 to ₹4,000 (BL-182 E3, on the engine's
  recorded MTM paths): a morning Widesl earns by decay, and a target takes the good days off the top.
  Profit locks are neutral to mildly helpful; a lock-and-trail armed at ₹3,000 with a breakeven lock
  that rises 1:1 reads +91 a day with a −13,836 drawdown against the plain +64 / −16,609, helping in
  the first period and tying in the second, while the fixed 09:17 files do not gain. A lead. Armed earlier,
  at ₹1,500, it reads +75 / −17,527: it lifts the first year (+90) and gives up part of the second (+63
  against +99), and the fixed files lose, so ₹3,000 is the arm that holds.
- Not adopted after both phases, E1, E2 and E3. Leads: the afternoon-only Widesl pair; the split with a
  ₹3,000–4,000 morning stop; the ₹3,000 lock-and-trail on the morning set.

## Not yet tested

- Other close or re-entry times (11:30, 12:30, 13:02, 13:30); an afternoon set conditional on the
  morning's result; skipping 12:00–13:00 only on some days to expiry. All registered as "will not run"
  in BL-182 Phase 0.
- An afternoon-only Widesl book (two 13:02–15:02 picks, no morning set) as a rule of its own.
- The split with the morning set's overall stop at ₹3,000 or ₹4,000, one level fixed in advance, as a
  registered comparison and then a forward track (BL-182 E2's lead).
- Any unseen days: Phase 1 is on seen data; a forward track (Phase 3) is the only test.

## Related

- [Exit time](exit-time.md) (no earlier exit than 15:28 ranked, 12:00 never tried before this);
  [Entry time](entry-time.md) (the start-time curve is flat before charges; afternoon starts rely on
  late fills).
- [Overall MTM stop](mtm-sl.md): the split gives the day two MTM budgets.
- Script: `packages/option-backtesting/research/bl182/run.py` (outputs git-ignored; regenerate with it).

[bl182]: ../../../../backlog/BL-182-widesl-split-session.md
