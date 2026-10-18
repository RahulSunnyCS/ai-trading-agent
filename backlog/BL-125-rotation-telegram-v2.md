# BL-125 — Rotation Telegram messages redone: one morning message, a short 16:00 evening message

| | |
|---|---|
| **Priority** | P1 — the messages the owner reads every trading day, from Mon 2026-10-19 |
| **Status** | In progress — built 2026-10-18 |
| **Type** | feature |
| **Area** | options |
| **Created** | 2026-10-18 |
| **Depends on** | BL-058 (the journal and the messages), BL-113 (the T1 track), BL-122 (the expiry rule), BL-012 (the scheduler) |
| **TODO.md row** | 3.10.31 |

## Context

The owner, 2026-10-18 (chat): **"combine Adaptive and T1 in one morning message, T1 labelled testing
phase, vertical with icons, self-explaining strategy names, short evening message with tomorrow's
strategies in full, evening at 16:00."**

Before: the 09:16 job sent Adaptive's message, then T1's as a second message of its own; strategy ids
(`N_wide_1117`) said little; the evening message carried likelihood percentages, win-rate tables,
"probable changes" and an explanation, was sent at the end of the 15:45 job (about 15:55), and had no T1.
`options-rotation-t1-update` (21:00) had never run on the scheduler.

## Goal

Message text and scheduling only. **Nothing about what is picked, scored or journaled changes**: no
hash, `inputs_sha` or journal field, no pick, no score, not the BL-122 rule.

## Decisions (owner, 2026-10-18, and the design choices under them)

1. **Labels.** `rotation/labels.py`: `label(name)` -> head `{N|S}_{dir|widesl|buy}_{strike}` (`N_widesl_OTM1`,
   `N_dir_ITM1`, `N_widesl_p150`, `N_buy_p50`) and params from the strategy's own YAML:
   `SL21% · TSLnone · RECOST1 · MTMSL3000` (CE/PE differences joined, `SL114%/115%`; percent trail
   `TSL15%/10%`, points `TSL1pt/1pt`; `REnone` / `RECOST<n>` / `REASAP<n>`; a Buy's range breakout takes the
   re-entry slot, `RB09:17-09:27-high`). A name with no readable file shows the raw id. Every one of the 521 YAMLs is tested.
2. **Morning (09:16): one message**, vertical with icons: `🎯 ADAPTIVE · Mon 19 Oct`, the BL-122 line
   `⚡ Expiry day · NIFTY only` on a rule day, the three strategies (by entry time) with their settings, the
   Buy add-on when there is one (with when it buys), `➕ Optional: Widesl … · Dir …`; a separator; then
   `🧪 T1 · TESTING PHASE · not traded` in the same shape; the Adaptive entry's hash and time. LATE puts
   `⚠️ LATE · not a forward entry` first. The friends' group gets Adaptive alone (T1 stays private).
3. **T1 never delays or loses Adaptive.** `obt rotation pick --with-t1` records Adaptive, then T1 in the same
   process (reusing the live VIX read, recorded with its true source), and sends one message. If T1 fails,
   is not ready by 09:16:50 IST (or 20 s after Adaptive's entry on a later run), Adaptive goes out alone with `🧪 T1 · TESTING PHASE · follows in a separate message` (slow, or its results being caught up) or `… · not recorded today` (failed),
   the friends' group copy never waits for T1 at all; the failure still alerts the owner as before and the job exits 2 (retry); missing T1 results are stored
   in-process after Adaptive is sent, and T1 then follows as its own message in the T1 layout.
4. **Evening: one short message** for both lists: each list's total and per-strategy result (real minus sign),
   then tomorrow's strategies in full with their settings (`tomorrow.next_session_picks`, the same expected-pick
   computation, BL-122 rule included, run on the T1 universe for T1). Removed: likelihood percentages, win-rate
   and mean tables, probable changes, explanations, the hash. T1 results not ready: `🧪 T1 · result not ready`.
5. **Sent markers, per destination and piece** (`.sent` owner, `.group.sent`, `.t1.sent`): a retry never
   double-sends; a failed group copy is retried alone; a late T1 result follows as its own message. Design
   chosen: wait for T1 until 16:25 (the job retries every 5 minutes), then send what exists.
6. **Schedule.** `options-evening` (15:45) collects, updates, rebuilds derived tables, then stores the T1
   results with `--soft-fail`, and ends with `obt rotation result --not-before 16:00 --soft-fail` (a no-op on a normal
   day; it sends at once when the run only succeeds on a late retry, since a failed 16:00 slot is never caught up). New `options-rotation-result` at 16:00 runs
   `obt rotation result --wait-until 16:25`, retried every 5 minutes to 16:35; if Adaptive's results never
   complete the job fails and the scheduler alerts the owner. `options-rotation-t1-update` (21:00) stays as the
   catch-up (its update `--soft-fail`, so its result step always runs) and its second step sends whatever is still owed. The scheduler reads `jobs.ts` at start: restart it after merge.

## Out of scope

Lists A / B / REF, the journal, scoring, the dashboard's rotation pages, per-trade charges.

## Plan

### Phase 1 — Build (done 2026-10-18)
- **Tasks:** `rotation/labels.py`, `messages.py`, `deliver.py`; `pick.record(vix_source=)`; `result.calculate(track=)`;
  `tomorrow.next_session_picks`; `Notification(plain=True)`; `obt rotation pick --with-t1`, `result --wait-until`;
  `jobs.ts`; docs and Guide.
- **Done when:** unit suites pass; dry runs for 2026-10-19 print both tracks in the new layout; scheduler tests pass.

### Phase 2 — First days
- **Tasks:** read the 2026-10-19 09:16 and 16:00 messages; check the markers under
  `TRADING_DATA_ROOT/rotation/result-notifications/` and that the 16:00 message left at 16:00-16:05.
- **Done when:** a normal day and a day with T1 not ready have both gone out as designed.

## Risks

- The 16:00 message needs `options-evening` to finish by about 16:00; it is retried to 16:25, then sent without T1.
- The T1 step comes after the live update and the derived tables, and is `--soft-fail`: a T1 problem alerts but never
  fails the evening run (whose retries would resend the `obt daily` summary).
- Telegram is proportional-font: right-aligned amounts are approximate.

## Log

- 2026-10-18 — created and built. Owner: "combine Adaptive and T1 in one morning message, T1 labelled testing
  phase, vertical with icons, self-explaining strategy names, short evening message with tomorrow's strategies
  in full, evening at 16:00". Measured: `obt rotation update --track t1` for one collected day (223 variants)
  took 2.4 s of simulation on the real data (read-only run, writes patched out); Core-298 0.8 s warm.
- 2026-10-18 — review fixes (PR #245, Opus review): the group copy is sent the moment Adaptive is
  recorded, and the owner's message waits for T1 only until 09:16:50 IST (20 s cap); any error reading
  T1 in the evening degrades to `T1 · result not ready` and never stops Adaptive's result; a per-day
  `flock` around the evening's decide-send-mark; `--dry-run` never runs the T1 catch-up; the evening
  run's T1 step is `--soft-fail` (alerts, exits 0, so `obt daily` is never re-run for it); a pre-BL-125
  `.sent` marker still covers owner + group.
- 2026-10-18 — second round (coordinator's list on the review): the morning note is honest about why T1 is
  missing (`follows in a separate message` when slow or being caught up, `not recorded today` when it
  failed); the combined T1 block carries the `⚡ Expiry day` line too; `options-evening` ends with
  `obt rotation result --not-before 16:00 --soft-fail`, so a run that only succeeds at 17:15 still sends
  that evening (a failed 16:00 slot is never caught up); the 21:00 job sends anything owed with a soft
  `result` first, then runs a strict T1 update (a failure fails the job, so its 22:00 / 23:00 retries
  try again; review of #249) and a last `result`; in `send_result` the owner goes first, a failing group copy is retried on its
  own and never holds back the owner's T1 follow-up, and a T1 that cannot be read alerts the owner;
  `obt rotation verify --track t1` checks the T1 journal.
