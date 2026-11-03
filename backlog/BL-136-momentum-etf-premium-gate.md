# BL-136 — Momentum: do not buy an ETF trading too far above its NAV (the premium gate)

| | |
|---|---|
| **Priority** | P1 — protects the money the ETF favourites' signal would have put into a premium that can vanish in a day; the live gate is cheap, the research decides whether it stays |
| **Status** | In progress — Phase 1 (the live gate, ETF favourites) built 2026-10-18; Phase 1b (Broad / Custom Index atomics) next; Phase 2 (pre-registered research) planned |
| **Type** | research (Phase 1 is a feature; Phase 2 is the research that keeps or kills it) |
| **Area** | momentum |
| **Created** | 2026-10-18 |
| **Depends on** | BL-024 (the journal records the skips), BL-051 (This week shows them) |
| **TODO.md row** | 3.29 |

## Context

On Friday 2026-10-16 the ETF rotation ranked Nasdaq 100 first. The instrument it buys is MON100,
and `mbt fetch` put MON100 at **+16.89% above NAV** (price ₹316.61, NAV ₹270.87): the RBI
overseas-investment limit has stopped new unit creation, so the ETF trades at whatever the
secondary market pays. Hang Seng's HNGSNGBEES was at +4.5%. The ranking is right about the
index; the traded instrument is detached from it. If creation resumes the premium goes to zero
on its own, about 14.5% on MON100, independent of what the Nasdaq does. The strategy's whole
backtested edge over its benchmark is a few points a year.

What existed before this item:

- `live_config.toml` `premium_warn_pct` (1%) / `premium_warn_international_pct` (2%): the Telegram
  line of a BUY or ADD over the limit gets "⚠️ buying above NAV". A warning, not a gate: Friday's
  message would have said BUY Nasdaq 100 with the flag.
- `engine.run_backtest(no_buy=...)` and `analysis.latest_signal(no_buy=...)`: a week × instrument
  table of names not buyable that week. A flagged name not already held is skipped and the
  next-best buyable name within `exit_rank` takes its place (Broad uses it for upper-circuit
  locks and the levers' masks). Held names are untouched.
- `data/etf_premium.csv` (`fetch_etfs`, refreshed by the weekly job): each ETF's close / AMFI NAV
  − 1 per day. The README's `mbt tracking` rule: a round trip losing more than 0.5% to the
  premium means backtest with `--track etf`.
- The premium history is short: Yahoo's closes are split-adjusted while AMFI's NAV history is
  not, so every day before an ETF's unit split fails the units check (`MAX_PREMIUM`) and is
  dropped. MON100's series starts in mid-2021 (1,344 days dropped), HNGSNGBEES's in late 2019
  (745 dropped). The only real premium episode in it is the 2022–2024 RBI-limit period.

Owner, 2026-10-18: "should we create a rule that we should not buy if there is some premium
above some level" → yes, in two layers: the live gate now, the research next; and the skip must
show in the journal and on This week.

## Goal

1. **Live:** an ETF favourite never opens a new position in an ETF more than the limit above
   NAV; the next-best name takes the slot; the skip, its premium, the limit and the reason are in
   the Telegram message, the forward journal entry and This week.
2. **Research:** a pre-registered test of whether the gate (hard limit), a premium-adjusted
   ranking, or no rule serves the strategy best over the premium history, and whether the gate
   should enter the engine (so the model portfolio follows it) rather than stay a decision-only
   rule.
3. The limits in `live_config.toml` are whatever Phase 2 passes, or the gate is removed.

## Out of scope

- Selling or trimming a held name for its premium. Selling into a premium is a gift, not a cost;
  the rule is one-sided by design.
- Blocking a top-up (ADD) of a held name: it keeps the warning. Open question below.
- The Rebalance preview. It still shows the ungated ETF trades; note it on the page if a
  follower is ever on an ETF favourite.
- Stock (no ETF is traded there).
- **Not yet covered, and it matters: Broad and Custom Index.** Both rank Gold, Silver, **Nasdaq
  100 and Hang Seng** as atomics (`categories/broad.py` `ATOMIC_NAMES`, `api.ATOMIC_INSTRUMENTS`),
  bought in real money as MON100 / HNGSNGBEES, and the followed favourites, the headline and Your
  orders are Broad. So after Phase 1 the motivating case, MON100 at +16.9%, is still a BUY on the
  strategies the owner follows. Phase 1b below gates them; until it ships the Guide says so.

## Plan

### Phase 0 — Pre-register (for Phase 2; committed 2026-10-18, before any run)
- **Hypothesis:** blocking a new buy whose ETF is more than X above NAV improves the ETF
  rotation's net return per unit of drawdown over 2021-07 → 2026-10 against the same strategy
  with no gate, because the premium paid at entry is lost when creation resumes and momentum
  buys into premiums (inflows push the premium up) and sells after they shrink.
- **Universe:** the ETF rotation's `core` names with an `amfi_code` (`universe.csv`), their
  real premium series (`etf_premium.csv` as rebuilt by Phase 2 task 1), P&L on the ETF
  (`--track etf`, the live setting), Friday close fills.
- **Look-ahead check:** the gate on week W reads the newest premium dated **before W's Friday**
  (`latest_premiums` stops at the previous session whatever the file holds, so a rerun after
  AMFI has published Friday's NAV decides the same way the 16:45 run did; pinned in
  `test_weekly.py`). A re-run with the premium series cut off at each
  decision date must give identical decisions (the pattern of `tests/golden/test_lookahead.py`).
- **Arms:** (A) no gate (the baseline, today's backtest); (B) hard gate at 2% domestic / 5%
  international (the live numbers); (C) hard gate at 1% / 2% (the warning levels); (D)
  premium-adjusted ranking: each name's score less its latest premium, no hard block.
- **Pass / kill rule:** B (the live gate) stays if, against A, its CAGR after costs is not lower
  by more than 0.3 points **and** its worst drawdown or Ulcer index is better, over the whole
  window and in both halves (2021-07 → 2024-01, 2024-01 → 2026-10); D replaces B only if it beats
  B on the same figures in both halves. Otherwise the gate is removed from `live_config.toml`
  (set to 0) and the warning stays. Measured on `metrics.turnover`, CAGR, max drawdown, Ulcer,
  from `Result` as the goldens read them.
- **Hold-out:** none is possible — one episode (2022–2024) is the whole sample. Said plainly in
  the findings: this is a measurement on one episode, so the result is "consistent with" or
  "contradicted by", never "proven".
- **Will not run:** a sweep over thresholds finer than the three arms (it would fit the one
  episode); any arm that sells held names on their premium.

### Phase 1 — The live gate (built 2026-10-18)
- **Tasks:** `premium_block_pct` / `premium_block_international_pct` in `live_config.toml`
  (2% / 5%, 0 = off), read by `load_live_config` and shared with every ETF favourite through
  `settings_from_saved_config` (`live_premium_settings`). `compute_signal` builds a one-week
  `no_buy` table from `latest_premiums` (newest premium dated before the signal Friday, with its
  date; Friday's own NAV is never read, even on a later rerun) + `premium_blocked` and passes it to `analysis.latest_signal`; a skipped name is relabelled
  `SKIP (premium)` with `premium`, `premium_date`, `premium_limit` and a `reason`. `format_message`
  lists them under "NOT BOUGHT · ETF too far above NAV". `groups.combine` keeps a sleeve's skip as
  a skip (it used to read before = after = 0 as a TRIM); the group message says "not bought:".
  `this_week._rows` and `api._journal_entry_view` carry the label and reason; the dashboard has a
  "Not bought" section on the card (`rowSection` → `skip`), the reason under the name, the skip
  chip and reason on the Journal page. Guide pages and the README updated.
- **Deliverables:** the commit on 2026-10-18; tests in `test_weekly.py` (settings, newest known
  premium, the end-to-end skip on generated data, the message), `test_groups.py`,
  `test_this_week.py`, `momentumWeek.test.ts`, `MomentumJournalView.test.tsx`.
- **Done when:** a Friday run with MON100 over 5% records `SKIP (premium)` for Nasdaq 100 in the
  journal and shows it on This week, and the next-best name is the BUY.
- **Known limit, by design:** the gate is a decision for the week; `run_backtest` in
  `compute_signal` still runs without it, so the model portfolio records the buy and next week
  the name can show as HOLD for a follower who never bought it. Phase 2 decides whether the gate
  enters the engine (task 3); until then the Guide says so.

### Phase 1b — The same gate on Broad and Custom Index atomics (next)
- **Tasks:** the week's blocked atomics (same `latest_premiums` / `premium_blocked`, same TOML
  limits) passed as `no_buy` into the Broad engine decision (`api._broad_engine_signal`,
  `_broad_decide`, the sentinel-week run `_orders_signal` uses at 14:15) and Custom Index's
  `latest` for the decision week only, with the same `SKIP (premium)` row, reason and the
  no-sale-week rule (keep the ungated action, attach the note); the Broad Telegram message and
  the 14:15 orders summary name the skip; `_actionable_rows` leaves it out of the trades.
  `tests/test_broad_parity.py` stays green: the gate must not reach the full backtest.
- **Deliverables:** the change, tests on the Broad sentinel path (a blocked atomic in the top
  picks on a rebalance week; a held atomic untouched), Guide wording updated.
- **Done when:** a Friday on which MON100 is over 5% records `SKIP (premium)` for Nasdaq 100 on
  the headline's journal entry and Your orders plans no MON100 buy.

### Phase 2 — Fix the premium history, run the pre-registered arms
- **Tasks:**
  1. Rebuild `etf_premium.csv` on matching units: apply the same `split_factors` the price gets to
     the NAV (or compute on the unadjusted Yahoo close), so MON100's series starts in 2016, not
     2021. Check the join against the 1,344 / 745 dropped days; record how many remain dropped.
  2. A runner under `scripts/` (`bl136_premium_gate.py`) that builds the week × instrument
     `no_buy` table from the rebuilt series (Thursday's premium, per the look-ahead rule), runs
     arms A–D through `run_backtest(no_buy=...)` / an external-ranks tilt for D, and writes the
     figures of the pass / kill rule plus the per-trade premium paid (buys) and received (sells).
  3. Decide, from the result, whether the gate enters the engine for the live path (so the model
     portfolio follows it) or stays decision-only; record the owner's call here.
  4. Findings page `research/momentum/premium-gate.md`; update `live_config.toml` per the rule.
- **Deliverables:** the rebuilt series, the runner, the findings page, the TOML change.
- **Done when:** the pass / kill rule has been applied and logged, and the gate is either kept
  (with the numbers) or set to 0.

## Risks

- **One episode.** The 2022–2024 RBI-limit period is the whole sample; a finding either way is
  weak. Mitigated by saying so and by the two-halves requirement, not by more arms.
- **A missing NAV silently disables the gate.** If AMFI / mfapi fails on a Friday,
  `latest_premiums` returns an older premium (or none), and a name is bought at an unknown
  premium. The row's `premium_date` makes a stale premium visible; the journal check could flag a
  premium older than 5 trading days (follow-up if it happens).
- **The decision-only divergence** (Phase 1 known limit) confuses a follower on an ETF
  favourite. Today no followed favourite is an ETF strategy; Phase 2 task 3 settles it.
- **Yahoo's split adjustment** may differ by ETF; task 1 checks each join by eye against the
  dropped-day count.

## Open questions

1. ~~Should a **top-up (ADD)** of a held name also be blocked above the limit?~~ **Answered (owner,
   2026-10-28): no.** The gate blocks new BUYs only; a top-up (ADD) of a held name is flagged, not
   blocked, as built.
2. Should the gate **enter the engine** for the live path once Phase 2 reports (so the model
   portfolio and the journal's holdings follow the rule)? Proposed: yes if B passes; the owner
   decides at Phase 2 task 3.
3. Limits per name rather than per tax class (MON100 has run far wider premiums than HNGSNGBEES)?
   Proposed: no, until Phase 2 shows a reason.

## Log

- 2026-10-18 — created from the owner's question after MON100 read +16.89% above NAV. Phase 0
  committed. Phase 1 built in the same change: the live gate (2% domestic / 5% international),
  the Telegram "NOT BOUGHT" group, the journal and This week rows, the group combine fix.
- 2026-10-18 — PR review (Codex) found two real gaps, fixed before merge: the lookup read a
  premium dated on the signal Friday when a rerun found one (now strictly before it), and the
  paper-start views rebuilt the first week from the ungated weights, showing the refused name
  as a BUY (now the skip row is kept).
- 2026-10-18 — PR review (Opus) found three more, fixed before merge: a blocked name on a week
  that buys nothing was still labelled a refused buy with a refill that never happened (now it
  keeps its own action, WAIT, with the note); a skip-only week was sent as action_required (now
  "No trades", info); and the out-of-scope line wrongly said Broad and Custom Index have no ETF
  premium exposure. They rank Nasdaq 100 and Hang Seng as atomics and are what the owner follows,
  so Phase 1b was added as the next step and the Guide says the gate is ETF-favourite-only today.
- 2026-10-28 — Owner answered open question 1 (asked in chat, 2026-10-28): the gate blocks new BUYs only,
  not top-ups (ADD) of held names. That is how Phase 1 already behaves (an ADD is flagged), so no code
  change. Status unchanged.
