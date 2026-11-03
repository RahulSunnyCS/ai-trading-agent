# BL-205 — Margin for tomorrow: the brokers' daily margin statements, and a line in the 16:00 message saying whether tomorrow's lots fit

| | |
|---|---|
| **Priority** | P1 — real money runs at 90–97% margin utilisation most days (46 Angel One shortfall warnings since June; on 2 Nov the F&O segment was ₹1.28 L short of the exchange requirement, covered only by the equity segment's cash), and nothing in the repo says before the open whether tomorrow's lots fit |
| **Status** | In progress |
| **Type** | feature |
| **Area** | contract-notes / options / scheduler |
| **Created** | 2026-11-04 |
| **Depends on** | BL-168 (the Gmail readers and the store), BL-125 (the 16:00 message), BL-140 / BL-183 (Settings › Automation rows, lots per pick), BL-141 (the live capture: lots traded and today's P&L per account), BL-204 (where extra lots go) |
| **TODO.md row** | 3.10.60 |

## Context

The owner (2026-11-04), after BL-204 said where a fifth and sixth T1 lot should go: "I want to
have a system aware of my margin … margin will be available from the mail given by the brokers
… before giving me the Telegram message, analyse the margin report and tell me how much margin
is available … on expiry for Nifty, Sensex, non-expiry … what is the maximum margin required …
assume it can be a little higher, 10% … tell me whether tomorrow's margin is fine, looking into
the settings: which list, how many lots" — and if today lost money, that loss comes off what is
available. Not the shortfall warning e-mail: "there is email showing daily margin statement".

And the 50:50 rule (owner, later the same day): the exchange wants at least half of the margin
in cash (or cash equivalents), the rest may be pledged shares. "In Finvasia we should assume
strict 50:50 cash and non-cash collateral. In Angel One we should try to achieve it, else we get
the amount to be paid as interest." Angel One's "Interest on collateral used against your
derivative trade" e-mails are already in the ledger (`collateral_interest`, 119 days): the
interest is about 0.029% a day (≈ 10.5% a year) of the cash shortfall, which ran at about ₹3 L in
late October: roughly ₹2,000 a month.

What the mailboxes hold (read 2026-11-04 with the contract-notes IMAP reader, nothing stored):

| Broker | E-mail | When | What the PDF gives |
|---|---|---|---|
| Angel One | "Margin Statement for the day" from contract.notes@angeltrade.in, `CM_<client>_DDMMYYYY.pdf`, PAN password (the configured `pdfPassword`) | 00:00–05:00 IST the next day, every trading day (Oct: 21 of 21) | per segment (NSE-F&O, EQUITY, MCX, NCE) and a Total: funds (A), securities and pledged securities after haircut (B, C), **total margin available (F)**, **total upfront margin (G)**, crystallised obligation / MTM (H), total requirement (J), excess or shortfall (K). G is the day's **peak** requirement, not the end-of-day one: on 2 and 29 Oct it was within 0.3% of the warning e-mail's peak, on 30 Oct 8% under it (the exchange's random snapshot vs the broker's RMS peak) |
| Finvasia | "Client Margin Report#TID-…#" from Backoffice@shoonya.com, `MARGIN_<client>_DDMMYYYY.pdf`, PAN password | 17:45–20:00 IST the same day (a few the next morning) | funds, collateral after haircut, total margin available; the NSEFNO row's upfront margin is **0.00** on days the account traded intraday (29, 30 Oct) and its MTM column holds the day's crystallised obligation. No peak figure |
| Zerodha (Kite) | "Daily Equity Margin Statement for <client> - <date>" from reportsmailer.zerodha.net | ~20:30 IST | not needed (Momentum, no F&O) — skipped |

Both statements list the collateral scrip by scrip (ISIN, name, quantity, closing rate,
haircut, value after haircut; Angel One's 2 Nov: four pledged shares, ₹8.45 L after haircut, with
funds −₹1.04 L in F&O and ₹2.23 L in equity), so the cash and non-cash halves can be told apart,
once the cash-equivalent collateral (liquid ETFs, G-secs) is named.

So the margin **available** comes from the statements for both accounts (and, for Angel One,
today's figure already comes from the 15:50 `obt realised capital` SmartAPI read). The margin
**required** per day comes from Angel One's statements alone; Finvasia's must be inferred from
Angel One's per-lot figure (both are exchange SPAN + exposure on the same contracts) until a
better source exists. Angel One's shortfall warnings (`ledger.js`, `margin_warning`, 46 days
since June) are a second, intraday reading of the same peak.

The other pieces exist: the tentative picks for tomorrow and tomorrow's weekday DTE labels
(`rotation/tomorrow.py`, `result.py`'s `➡️ <day> (Tentative)`), the lots each Settings ›
Automation row trades (`automation_settings.py`, `live_lots.py`), the lots each account actually
traded and its P&L today (`rotation/live/<day>.jsonl`, 15:40), and the 09:05 margin check
(BL-143), which compares the morning's free margin against a stale `margin.csv` (₹1.4 L a
straddle, Aug 2026) rather than against what the account was seen to need.

## Goal

Every trading day's 16:00 result message (the owner's copy only) ends with a margin block, one
row per Settings › Automation account that uploads a list:

```
🏦 Margin for Thu 5 Nov (SENSEX expiry · 3 lots of T1 on Finvasia, 3 on Angel One)
Angel One   ₹9.19 L free after today  ·  needs ≈ ₹8.9 L (peak ₹8.1 L on the last 4 SENSEX expiries +10%)  ✅ fits, ₹0.3 L spare
            cash ₹1.2 L of the ₹4.5 L the 50:50 rule wants  ·  ₹3.3 L on interest ≈ ₹95 a day (₹2,100 in Oct)
Finvasia    ₹12.4 L free (2 Nov statement − today ₹0.06 L), of which 2 × cash ₹5.1 L usable under 50:50  ·  needs ≈ ₹8.9 L  ⚠️ short ₹3.8 L · 1 lot fits
```

Finvasia's usable margin is the smaller of its total and twice its cash component (strict
50:50). Angel One's verdict is on the total, and a second line says how far the cash half is
from 50:50 and what that costs at the rate the interest e-mails show, so the owner can decide
whether to move cash in.

A row that does not fit says by how much and how many lots would (`⚠️ short ₹1.1 L · 2 lots
fit`). "Needs" = the largest requirement per lot seen on recent days of tomorrow's type (NIFTY
expiry, SENSEX expiry, both, normal), times tomorrow's lots for that row, plus the buffer.
"Free" = the newest reading of the account's margin available, less today's realised loss when
the reading predates today's close.

## Out of scope

- Changing lots, exports or deployments because of the verdict: the message says; the owner
  decides (as BL-143's checks).
- A margin calculator call to the broker for the exact basket (strikes are not known until
  09:17; a later phase if the observed figures prove too loose).
- Kite's statement, Momentum's margin, the equity segment's own needs.
- The Trade book's capital line (`obt realised capital`), which stays as it is.

## Plan

### Phase 1 — Read and store the daily margin statements
- **Tasks:** two ledger-style readers in `packages/contract-notes` (`margin.js`): Angel One's
  `CM_*.pdf` and Finvasia's `MARGIN_*.pdf`, decrypted with the account's `pdfPassword` (PAN),
  parsed by segment into `{funds, securities_after_haircut, pledged_after_haircut, available,
  upfront, mtm, delivery, requirement, excess, rms_additional, balance}` with the Total row
  separately; `pdf-parse` runs the cells together (`0.000.000.000.00-2562.82`, a number wrapped
  over two lines as `222888.\n91`), so split on the two-decimal boundary after re-joining wrapped
  lines, and check each row adds up (F = A+B+C+D+E, J = G+H+I, K = F−J) — a row that does not
  is reported, not stored. One line per statement in `contract-notes/margin/<day>.jsonl`
  (`day` = the statement's trade date, not the e-mail's), keyed by message id like the ledger.
  Run by the nightly job and its retries; a `--margin --from D --to D` backfill from the
  mailboxes (Angel One from Sep 2026, Finvasia from Sep 2026). Every password already
  registered with `@trading/notify`.
- **Deliverables:** `margin.js` + tests on redacted fixture texts; the store folder; the package
  and project docs (`packages/contract-notes/CLAUDE.md` store table, `technical.md`).
  The collateral table is stored with each statement (scrip, ISIN, quantity, rate, haircut,
  value after haircut) and each scrip is tagged cash-equivalent or not from a small list in
  `reference/` (owner, 2026-11-04: cash, pledged liquid ETFs such as Liquidbees, pledged
  sovereign gold bonds; plus G-secs and T-bills, which the exchange treats the same way), so
  the cash component = funds + cash-equivalent collateral is a stored figure, not a guess at
  message time. A pledged scrip the list does not name is non-cash.
- **Done when:** the backfill stores one line per statement e-mail since Sep for both accounts,
  each row's arithmetic checks, and 2 Nov's Angel One NSE-F&O line matches the PDF (a shortfall of
  about ₹1.3 L against the exchange) with its pledged scrips adding up to the table.

### Phase 2 — The requirement by day type, per lot
- **Tasks:** `obt margin days [--from D --to D]` (Python, `realised/margin.py`): per trading
  day and account, the statement's available and peak requirement (Angel One's G; Finvasia:
  none), the day's type from the journal's weekday DTE labels (NIFTY expiry / SENSEX expiry /
  both / normal), the lots the account had open at the same time (the live capture's fills:
  the largest number of lots whose entry–exit windows overlap, the tool's and the discretionary
  rows, with the tool-only count beside it), and requirement ÷ lots. `obt margin table`: per
  day type the last N (default 6) such days' per-lot figures, max and median, Angel One's and
  the inferred Finvasia one.
- **Deliverables:** the two commands; `GET /legwise/contract-notes/margin` for a later Trade
  book card (read-only).
- **Done when:** the table prints for both accounts over the captured days (from 21 Oct) and
  the per-lot figures sit near BL-133 A3's ₹2.0–2.6 L, or the difference is explained in the Log.

### Phase 3 — The block in the 16:00 message
- **Tasks:** `rotation/margin_lines.py`: for each account row that uploads, tomorrow's type
  and lots (the tentative picks through `live_lots.lots_for_day` with the row's Dir ×2 and
  multiplier), needs = max per-lot of that type over the last N days × lots × (1 + buffer),
  free = Angel One: today's 15:50 SmartAPI reading (`manual/<next>.json`), Finvasia: the
  newest statement's available less today's realised P&L from the 15:40 capture when the
  statement is from before today; the verdict and the lots that fit. The 50:50 rule: Finvasia's
  free figure is the smaller of its total available and 2 × its cash component (strict); Angel
  One's verdict stays on the total, with a cash line: cash held, the cash the rule wants (half
  of needs), the shortfall, and its cost a day at the rate implied by the newest
  `collateral_interest` events (amount ÷ shortfall) and the month's interest so far from the
  same events. Rendered by `result.py`
  into the owner's copy only, after the month lines; an account with no reading says so
  (`margin: no statement since <day>`), never a guess. Settings › Automation gets the buffer
  (default 10%) and N.
- **Deliverables:** the lines, their tests, the Guide page for the message, `technical.md`'s
  `rotation result` entry.
- **Done when:** three evening messages carry the block with figures that match the statements
  and the next morning's AlgoTest login shows the same free margin within the buffer.

### Phase 4 (optional) — The 09:05 check reads the same figures
- Replace BL-143's `margin.csv` need with Phase 2's per-lot figure, so the morning check and the
  evening block never disagree. Decided after Phase 3 has run for two weeks.

## Risks

- **The PDFs' layout changes:** the readers refuse a row that does not add up and the nightly
  run alerts, as the note readers do when a subject or file name changes.
- **G is one exchange snapshot, not the true peak:** 30 Oct's G was 8% under the warning e-mail's
  peak. The buffer covers it; the warning e-mails' `margin_used` is kept beside G in the table
  and the larger of the two can be used if the owner prefers.
- **Finvasia's requirement is inferred:** its statement gives no peak. If its RMS adds a
  broker margin the inference misses, the morning AlgoTest login's free figure will show it;
  Phase 3's done-when checks exactly that.
- **Discretionary trades inflate the per-lot figure:** the owner's own strategies share the
  account. Counting their lots in the divisor keeps the figure a per-lot one; the tool-only
  count is printed beside it so an odd day is visible.
- **The cash component is only as good as the cash-equivalent list:** a liquid ETF left
  untagged makes Finvasia look short and Angel One look costlier than it is. The block names
  the untagged collateral the first time it sees it, and the list lives in `reference/` where
  the owner can add to it.
- **Tomorrow's strikes are unknown:** an ITM1 Dir or a wide strangle at a different distance
  changes the margin a little; the day-type maximum plus the buffer is meant to absorb it.

## Open questions

1. Buffer: the owner said 10%, then 5%. Default 10% (a setting)?
2. Finvasia's requirement from Angel One's per-lot figure: acceptable until a Finvasia figure
   exists, or should the AlgoTest morning figure be used to calibrate it?
3. Day types: NIFTY expiry / SENSEX expiry / normal (and the rare both-expire day) — or one
   expiry type?
4. Which days count: the last N same-type days (N = 6?) or everything since 21 Oct?
5. Should the block also go into the 09:00 morning summary (the statements have arrived by then)?
6. ~~Which of the pledged scrips count as cash equivalents?~~ Answered (owner, 2026-11-04): any
   cash, pledged liquid ETFs (Liquidbees) and pledged sovereign gold bonds. Finvasia's 2 Nov
   funds of ₹1.05 L against ₹12.5 L of collateral, with 4–7 lots traded on 29 and 30 Oct, fits
   that: the pledged Liquidbees and SGBs carry the cash half. Phase 1 confirms it from the
   scrip list.
7. Angel One's cash shortfall (₹3.2 L on 2 Nov, ₹2,000 a month in interest): is the block's job
   to say the cost, or also to say how much cash to move in to clear it?

## Proposed answers (Claude, 2026-11-04 — stand unless the owner changes them)

1. **Buffer 10%.** Angel One's statement figure sat 8% under the broker's own peak on 30 Oct,
   so 5% would not even cover the reading's noise. A setting, default 10.
2. **Finvasia's requirement from Angel One's per-lot figure, yes** — and for the first two
   weeks the block prints Finvasia's morning AlgoTest free figure next to the previous evening's
   estimate, so a broker add-on would show up as a steady gap.
3. **Four day types:** NIFTY expiry, SENSEX expiry, both (holiday-shifted weeks only), normal.
   The expiry rule trades only the expiring index, so an expiry day's margin is one index's, and
   the two indices' per-lot margins differ.
4. **The last 6 same-type days,** taking the larger of the statement's peak and the warning
   e-mails' peak on each; about six weeks for an expiry type, two for normal days, which follows
   a VIX or lot-size change without forgetting a bad day. A type with fewer than 3 such days
   says so and uses what it has.
5. **Not in the 09:00 summary.** One place for the verdict (16:00), and the morning gate stays
   the 09:05 margin check, which Phase 4 feeds with the same figures.
7. **Say both:** the cost a day and the cash that clears it (`add ₹3.3 L cash to clear ₹95 a
   day`). One more number, no judgement.

## Log

- 2026-11-04 — created from the owner's request after BL-204; the mailboxes read once to learn
  what the statements hold (table above); nothing stored.
- 2026-11-04 — the owner added the 50:50 rule (strict on Finvasia; a target on Angel One whose
  miss is paid as interest); the ledger's `collateral_interest` events give the rate
  (≈ 0.029% a day); Goal, Phases 1 and 3, Risks and questions 6–7 updated. Question 6
  answered: the cash component is cash, pledged liquid ETFs and pledged SGBs. Proposed answers
  to 1–5 and 7 recorded, pending the owner.
- 2026-11-04 — started (owner: "looks good, let's start … complete this", then "complete phase 1 –
  last"); proposed answers stand. Phase 1 built: `packages/contract-notes/margin.js` reads both
  statements and checks every row's sums, the segments against the Total, the collateral against
  the table and Finvasia's funds against "Net Funds"; on the 166 statements mailed since June
  (67 Angel One, 99 Finvasia across two accounts) every one reads and checks. The nightly run and
  its retries store them in `contract-notes/margin/<day>.jsonl` (bookmark per broker and mailbox;
  the PDF kept encrypted); `node run.js --margin-only --from D --to D` backfills. Angel One's
  collateral is all ordinary shares (no Liquid BeES or SGBs), so its cash half is its funds alone;
  Finvasia FA··24 pledges Liquid BeES and SGBs.
- 2026-11-04 — Phase 1 reviewed (six findings, five fixed: a broken margin file no longer stops
  the run, Angel One's collateral is required whenever the table shows securities, one bookmark
  helper, tests, figures rounded here) and backfilled: 167 statements since June. Phase 2 built:
  `realised/margin.py`, `obt realised margin`, `GET /legwise/contract-notes/margin`. Quantiply's
  capture rows carry no fill times, so their lots are counted from the entry time in the
  strategy's name to the close (`lots_from` 'schedule'). Per lot (Angel One, peak ÷ every lot
  open, the owner's own strategies included) over 21 Oct – 2 Nov: normal days ₹1.2–1.9 L, SENSEX
  expiry ₹1.0–1.6 L, NIFTY expiry ₹1.0 L (one day). Below BL-133 A3's ₹2.0–2.6 L because the
  owner's own strategies on the account (some hedged) count as lots; the max of a type is what
  Phase 3 uses. Angel One's cash half is ₹0.7–1.1 L against ₹3–4.3 L the rule asks, which is
  the interest the e-mails charge; Finvasia's main account's cash (funds, Liquid BeES, SGBs) is
  about ₹4.6–5.2 L, so the strict rule caps it at about ₹9.3–10.4 L of its ₹12 L.
- 2026-11-04 — Phase 2 reviewed (four findings: two fixed, the day types checked against the T1
  journal's recorded labels, 11 of 11 agree, the cache stamp left at its 20 s bound). Phase 3
  built: `rotation/margin_lines.py` appends the block to the owner's 16:00 copy only (never the
  group's; any failure leaves it out). Lots per account come from the evening's expected picks as
  each platform's export trades them; free is Angel One's 15:50 reading or the newest statement
  plus today's capture P&L; Shoonya is capped at twice its cash, Angel One's cash gap is costed at
  the interest e-mails' rate. Settings › Automation gets `margin` (buffer 0–50%, days 1–30;
  defaults 10 and 6); a save from a dashboard without the field (the hosted one, built from
  `release`) keeps the current values. On 3 Nov's data the block for Wed 4 Nov read: both
  accounts 3 T1 lots, needs ≈ ₹6.3 L (₹1.91 L a lot, +10%); Shoonya ₹12.8 L free, ₹10.4 L usable
  under 50:50, fits with ₹4.1 L spare; Angel One ₹9.2 L free, fits with ₹2.9 L spare, its cash
  ₹2 L short of half the need (about ₹58 a day of interest). Not built: the first fortnight's
  comparison with Shoonya's morning AlgoTest figure (the 09:05 monitor does not store what it
  reads); Phase 4 adds that.
- 2026-11-04 — Phase 4 built (the owner asked for every phase): the block saves tomorrow's lots,
  per-lot figure and buffer to `rotation/margin-plan/<day>.json`; the 09:05 check
  (`MARGIN_CHECK`, still off) takes its need from it with today's lots and judges enough as ok
  (the buffer is the cushion), margin.csv stays its fallback, and it stores the free figures it
  reads, which the next evening's block shows for Shoonya beside last evening's figure (the
  first-fortnight comparison of the owner's answer 2). Nothing switched on.
