# BL-204 — T1's fifth and sixth lot, and a fourth on expiry days: where each extra lot goes as capital grows

| | |
|---|---|
| **Priority** | P2 — the owner trades T1 with real money on two accounts and the capital may grow from ₹9 lakh to ₹12–13 lakh, later more |
| **Status** | In progress |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-11-03 |
| **Depends on** | BL-133 (fourth lot: the Dir; expiry days stay 3 of the expiring index), BL-183 (Dir ×2 live), BL-194 (book stop on 4-lot days), BL-122 (expiring-index rule), BL-192 (SL150% cap) |
| **TODO.md row** | — (research only) |

## Context

Owner (2026-11-03): "currently I have 9 lakh rupees. So this would be mostly sufficient for 3 lots of Nifty
expiry or Sensex expiry trades, and 4 lots of non-expiry trades. But let's say my capital moves to 12 lakh or
13 lakh. So there's a possibility that I can do 4 lot on expiry and maybe 5 lot on non-expiry days. It can be
also 6 lot if it is 30 lakh. So I need you to find out which is the best configuration to run the T1. Like for
now, if there is a 4 lot, we will be running the best directional one and the 2 widesl. So what if we have a 5
lot? ... or 4 lot in expiry and 5 lot or 6 lot in non-directional. So what would be the best approach?"

What is live (T1, one account): on a non-expiry day the picked Dir at 2 lots and the two Widesl at 1 (BL-183),
on an expiry day the expiring index's three picks at 1 lot each (BL-122, BL-133 Amendment 3), under a book stop
of ₹9,000 plus the extra lot's own MTM SL (BL-194). BL-133 read the fourth lot only ("Will not run: 5+ lots");
nothing has read a fifth or sixth lot, or a fourth on an expiry day.

Margin, from BL-133 Amendment 3's reading of Angel One's calculator (≈ ₹2.0–2.08 lakh a lot on a normal day,
≈ ₹2.6 lakh on the expiring index's expiry day; estimates, not measured since):

| Capital | Normal day | Expiry day |
|---|---|---|
| ₹9 lakh | 4 lots (≈ ₹8.3 lakh) | 3 lots (≈ ₹7.8 lakh) |
| ₹12–13 lakh | 5 lots (≈ ₹10.4 lakh); 6 (≈ ₹12.5 lakh) only at ₹13 lakh with no buffer | 4 lots (≈ ₹10.5 lakh) |
| ₹30 lakh | 6 lots (≈ ₹12.5 lakh) | 6 lots (≈ ₹15.7 lakh) |

## Goal

For T1, the result, drawdown and worst day of each way of placing a fifth and a sixth lot on non-expiry days
and a fourth (and fifth) on one-index expiry days, against the lots live today and against the same lots
spread evenly over the picks. Nothing live changes.

## Out of scope

Core-298; Buy; the lot ladder as a function of capital inside a day; margin measured (the table above is
taken as given); any change to a list, an export or a setting.

## Plan

### Phase 0 — Pre-register (committed before any run)

- **Hypothesis:** the Dir is the best home for the fifth lot too (Dir ×3), and on an expiry day the expiring
  index's Dir at 2 lots beats adding a strategy; the sixth lot is where the reading is least sure.
- **Book:** T1, list C (registered weights and lookbacks) reconstructed day by day from the stored results
  (`daylog.reconstruction` over Core-298 + the T1 variants, `pick._rank`), as BL-194: the expiring-index rule
  (`expiry.filter_picks`) and the SL150% cap (`sl150_cap.cap_picks`) applied as if live throughout; core picks
  only, Buy left out. Day d's composite is built from results before d only.
- **Picks named:** D = the core Dir pick, or on a three-Widesl day the best unpicked Dir (added, as BL-133);
  W1 / W2 = the Widesl picks by composite (ties by name; a three-Widesl day's third Widesl is a third 1-lot
  member in every arm); D+ = the best-ranked unpicked Dir other than D; W+ = the best-ranked unpicked Widesl;
  R+ = whichever of D+ / W+ has the higher composite. On a one-index expiry day every runner-up comes from the
  expiring index (`expiry.filtered_runners_up`'s rule); O+ = the other index's best-ranked non-Buy variant by
  the unrestricted composite.
- **Day types:** *normal* = neither index expires and both labels known; *expiry* = exactly one index expires
  (`expiry.expiring_index`); a both-expiry or unknown-label day trades 3 lots in every arm, as live
  (`live_lots.lots_for_day`), and is counted.
- **Arms, normal days** (the base **N4** = D ×2, W1, W2, live today):
  - 5 lots: **N5-D3** D ×3; **N5-W1** D ×2, W1 ×2; **N5-W2** D ×2, W2 ×2; **N5+D** D ×2 + D+; **N5+W** D ×2 + W+;
    **N5+R** D ×2 + R+. Comparator **B5** = the 3-lot book × 5/3.
  - 6 lots: **N6-all2** D ×2, W1 ×2, W2 ×2; **N6-D3W1** D ×3, W1 ×2; **N6-D4** D ×4; **N6+D+W** D ×2 + D+ + W+;
    **N6+D2** D ×2 + D+ ×2; **N6-D3+D** D ×3 + D+; **N6-W1+D** D ×2, W1 ×2 + D+. Comparator **B6** = the 3-lot
    book × 2.
- **Arms, one-index expiry days** (the base **E3** = the expiring index's picks ×1, live today):
  - 4 lots: **E4-D2** the Dir ×2 (no Dir: the expiring index's best unpicked Dir added); **E4-W1** W1 ×2; **E4+D**
    + D+; **E4+W** + W+; **E4+O** + O+ at 1 lot. Comparator **B4e** = E3 × 4/3.
  - 5 lots: **E5-D2W1** Dir ×2, W1 ×2; **E5-D3** Dir ×3; **E5+D** Dir ×2 + D+; **E5+O** Dir ×2 + O+. Comparator
    **B5e** = E3 × 5/3.
- **Book stop:** ₹9,000 plus, for every lot beyond the three base lots, that lot's strategy's own
  `overall.stop_loss_inr` (₹4,000 if none), replayed per minute with `rotation/portfolio.apply_book` over
  `one_lot_path` (a k-lot member = k × its one-lot path, the per-lot stop scaling the owner confirmed); an even
  spread's stop is ₹9,000 × k/3 and its paths the 3-lot paths × k/3. A day whose path cannot be replayed is
  skipped and listed.
- **Money:** gross from the replayed paths × lots under the stop; brokerage = 2 orders × the stored `n_trades`
  × ₹20 × 1.18 once per strategy placed (lots of one strategy share orders); net = gross − brokerage; turnover
  charges scale with lots and are left out alike. Slippage not modelled (every arm alike).
- **Measures (net):** per day over the day type's days and per lot-day; annualised (× 250); max drawdown;
  worst day; worst 5-day week; share of losing days; return ÷ |max drawdown|; drawdown per lot; book-stop
  days; peak lots open at once. Intervals: 90 % circular block bootstrap, 5-day blocks, 2,000 resamples, seed
  20261103, of arm − base and arm − even spread over the day type's days in date order; head to head, the
  best arm of each lot count against the second best (by net per day). For the best arm of each lot count:
  arm − even spread with the 5 and 10 best days removed and their share of the excess. **Whole book:** every
  normal arm paired with E3 on expiry days and every expiry arm paired with N4 on normal days, plus the best
  normal and best expiry arm together, over all days: per day, max drawdown, worst day, R/DD, drawdown per
  lot.
- **Windows:** 2025-01-10 → 2026-10-30 (BL-194's days) and the last year 2025-11-03 → 2026-10-30.
- **Reading:** an arm "earns its lot" if arm − even spread is above zero; one arm "beats" another if their
  difference is above zero; drawdown and worst day reported, not judged. Descriptive and in-sample: T1's
  universe was selected on part of these days, and BL-133's Dir reading came from them. With 22 arm cells,
  one or two intervals clearing zero by chance are expected; nothing is adopted here. A live change needs
  BL-135's forward rule (60 scored days, interval above zero, drawdown per lot no deeper).
- **Look-ahead check:** day d's ranking uses results before d; the expiring index and the labels are known
  before the day; the stop level is the strategy files' own.
- **Hold-out:** none (descriptive, in-sample, as BL-133 / BL-194).
- **Will not run:** 7+ lots; mixes of both indices on an expiry day beyond O+; any day after 2026-10-30;
  Core-298; Buy.

### Phase 1 — Run

- **Tasks:** `packages/option-backtesting/research/bl204/lot_ladder.py`; JSON beside it; Log.
- **Done when:** the Log has every arm and comparator for both day types, both windows, and the whole-book
  pairings.

## Risks

In-sample and the T1 universe's selection window overlaps; a stop fills at the minute's close with no
slippage; runner-ups are rebuilt from the stored composites, not journal entries; the margin table is an
estimate from one reading.

## Open questions

None before the run; the owner's choice of lots per capital level comes after reading the result.

## Log

- 2026-11-03 — Created; Phase 0 registered before any run (the owner's question, the arms chosen here).
