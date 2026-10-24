# Options: previous-session state (VRP, skew, PCR)

**Status:** Descriptive · **Last updated:** 2026-10-24

## What it is

Using what the chain looked like at the close of the **previous** session to say something about today's
Widesl and Dir, where [intraday state](intraday-state.md) uses what the market did since today's open. Three
states, each cut into terciles over the period, all known before the entry minute (`iv_daily` is built at
15:00 of its session; the PCR is shifted by one session):

- **VRP**: the previous session's `front_iv_1500` (the front weekly's ATM IV at 15:00) minus the realised vol
  of the previous 10 sessions' close-to-close log returns, in vol points.
- **Skew**: `skew_1500` = IV(put, ATM − 5 steps) − IV(call, ATM + 5 steps), previous session.
- **PCR**: the previous session's total put volume ÷ total call volume, nearest expiry, all strikes, from
  `bars_1m_option`.

These were screens in BL-159 (reads 1, 2 and 3), not rules. Each had its measurement and a lead bar (|t| of at
least 2 with the hypothesised sign) written down before the run.

## Live value

None. Nothing in the rotation or the live files reads any of them.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-159 read 1 | VRP top vs bottom tercile; Widesl OTM1 09:17 and Dir ATM 09:24 (stored rotation results, gross per lot) | NIFTY, 2024-10-09 → 2026-10-08, 487 state days | **No lead.** Widesl +₹520 (t 1.50), Dir −₹47 (t −0.15) | [BL-159][bl159] |
| BL-159 read 2a | Skew top vs bottom tercile, Widesl 09:17 (stored, gross) | same | **No lead.** +₹377 (t 1.05) | [BL-159][bl159] |
| BL-159 read 2b | Widesl with the PE at OTM2 (CE OTM1) and with the CE at OTM2 (PE OTM1), vs the symmetric file, within the top and bottom skew terciles (engine, after charges) | same, 489 engine days | **No lead.** PE at OTM2: +₹12 net on high-skew days (t 0.17), +₹54 on low-skew days (t 0.58); CE at OTM2 worse in both (−₹70, −₹85) | [BL-159][bl159] |
| BL-159 read 3 | PCR top vs bottom tercile, both base strategies (stored, gross) | same | **No lead.** Widesl −₹374 (t −1.06), Dir −₹411 (t −1.28) | [BL-159][bl159] |

The state reads compare groups of the same strategy on the stored results (gross, before charges); the
comparison is unaffected by charges to first order. Read 2b is after BL-063 charges.

## What we know

- **None of the three separates good days from bad for either base strategy** on two years of NIFTY. Every reported |t|
  is under 2 (the largest is Widesl on VRP, t 1.50).
- **The VRP mechanism check came out backwards.** The 09:20 ATM straddle decays *less* by 15:25 on high-VRP days
  (mean 3.4% of the 09:20 straddle) than on low-VRP days (7.0%), the opposite of "premium pays more when it is
  dear". Descriptive.
- **Skew does not justify moving the short legs.** Selling the put one step further out on high-skew days gave
  +₹12 a day, t 0.17, against the symmetric file; selling the call further out was worse in both terciles.
- The tercile cut points use the whole period, so a day's label depends on later days. Registered that way for
  a screen; a follow-up would need trailing cut points.
- One of about 30 tests in BL-159; with that many, one |t| of 2 or more is expected by chance. Read 4 (the
  overnight straddle) was the one that cleared the bar and it is on its [own page](../strategies/overnight-straddle/README.md).

## Not yet tested

- Each state on SENSEX, and on NIFTY 2022-01 → 2024-10 (locked in BL-159, unread).
- Terciles with trailing cut points; the states as a ranking ingredient or a sizing rule.

## Related

- [Widesl VIX](../strategies/widesl/vix.md), [Directional VIX](../strategies/directional/vix.md) (the VIX
  level is the neighbouring previous-session variable); [Widesl strike and
  premium](../strategies/widesl/strike-premium.md) (read 2b); [intraday state](intraday-state.md).
- Scripts: `research/bl159/states.py` (reads 1, 2a, 3), `engine_runs.py` (read 2b), `report.py`; outputs
  git-ignored, regenerate with them.

[bl159]: ../../../backlog/BL-159-eight-poc-reads.md
