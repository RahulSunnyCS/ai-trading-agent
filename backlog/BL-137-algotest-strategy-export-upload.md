# BL-137 — Rotation picks to AlgoTest: export to `.algtst` and upload

| | |
|---|---|
| **Priority** | P1 — the owner places 3 Core + 3 T1 picks a day by hand with real money; retyping six strategies before 09:17 is where a wrong SL or strike slips in |
| **Status** | In progress |
| **Type** | feature |
| **Area** | options (exporter), broker-login (uploader) |
| **Created** | 2026-10-19 |
| **Depends on** | BL-058 (journal), BL-113 (T1 track), BL-122 (expiry-only rule); none blocking |
| **TODO.md row** | §3.30 |

## Context

Since 2026-10-18 the owner trades one lot on each of Adaptive's three Core-298 picks and one lot on each
of T1's three picks, through AlgoTest. Each morning the 09:16 message names six strategies. Today each one is
built by hand in AlgoTest's backtest page or imported from an `.algtst` file. An `.algtst` file
(AlgoTest's "Import strategy" format, `version: "0.8"`) is JSON for **one** strategy: one entry time,
one exit time, the legs, and one overall MTM stop. So a day's picks are always several files, never one.

On 2026-10-19 a set of 224 T1 `.algtst` files was generated outside the repo (`~/Downloads/t1-algtst/`,
script not committed), and the three for that day were checked by hand against their YAMLs. Nothing in the
repo maps a strategy YAML to `.algtst` today, and nothing uploads one.

What already exists:

- `packages/option-backtesting/src/option_backtesting/legwise/schema.py`: the legwise strategy schema, one
  field per AlgoTest setting. Every rotation variant (`strategies/rotation/`, `strategies/rotation_t1/`)
  is one of these YAMLs, frozen.
- `rotation/journal.py` and `store.journal_path(track=)`: the 09:16 picks, hash-chained, for the live list
  and the T1 track. `rotation/tomorrow.next_session_picks` gives the evening preview.
- `packages/broker-login`: Playwright logs into AlgoTest every morning (`ALGOTEST_PHONE` /
  `ALGOTEST_PASSWORD`, `src/algotest.ts`, every locator in `src/selectors.ts`).
- `docs/algotest-execution.md` §2: AlgoTest's HTTP login (`POST https://api.algotest.in/login`) is
  verified. The endpoint the web app uses to save or import a strategy is **not** known.

The owner's sample (`nifty_widesl_917_otm1.algtst`) has entry 11:37 although its name says 09:17. It
was probably edited after export, so the name is no evidence of the time.

## Goal

1. `obt rotation algotest-export` writes the picked strategies of a day (Core, T1 or both) as `.algtst`
   files plus one zip, built from the strategy YAMLs by a tested mapping that refuses anything it cannot
   map exactly.
2. The picked strategies reach the owner's AlgoTest account without anyone typing a setting. Every
   uploaded strategy is read back and compared field by field with the file that was sent.
3. The owner still starts (deploys) each strategy in AlgoTest. Nothing here places, starts or
   squares off a trade.

## Out of scope

- **Starting, deploying or squaring off anything** in AlgoTest, paper or live. That stays a human click.
  The AlgoTest execution loop (TODO §3.1–3.4) is frozen (`overview.md`) and this item does not unfreeze it.
- Placing orders directly with a broker: that is BL-118, which is gated on separate conditions.
- Changing any pick, score, journal field or strategy YAML.
- Proving that AlgoTest's backtest reproduces our engine. That is BL-009's question. Phase 5 only records
  any differences it happens to see.

## Plan

### Phase 1 — Exporter (in-repo, no network)

- **Tasks:**
  - `legwise/algtst.py` (`legwise/algotest.py` is BL-009's trade-log comparison): `to_algtst(spec) -> dict`, a pure function. Fields mapped (from the owner's
    sample and the 2026-10-19 files):

    | Legwise YAML | `.algtst` (each read off an AlgoTest export, `tests/fixtures/algtst/`) |
    |---|---|
    | `underlying` | `Ticker` |
    | `entry_time` / `exit_time` | `EntryIndicators` / `ExitIndicators` → `TimeIndicator {Hour, Minute}` |
    | `square_off: partial` | `SquareOffAllLegs: "False"` |
    | leg `position`, `option_type`, `expiry: weekly` | `PositionType.Sell/Buy`, `LegType.CE/PE`, `ExpiryType.Weekly` |
    | `strike.strike_type: X` | `EntryType.EntryByStrikeType`, `StrikeParameter: "StrikeType.X"` |
    | `strike.closest_premium: P` | `EntryType.EntryByPremium`, `StrikeParameter: P` (a bare number) |
    | `stop_loss.percent` | `LegStopLoss {Type: LegTgtSLType.Percentage}` |
    | `trail_sl.percent / points: [a, b]` | `LegTrailSL {Type: TrailStopLossType.Percentage / Points, Value: {InstrumentMove: a, StopLossMove: b}}` |
    | `reentry_on_sl {mode: cost, count: n}` | `LegReentrySL {Type: ReentryType.AtCost, Value: {ReentryCount: n}}` |
    | `range_breakout {until, side: high, source: instrument}` | `LegMomentum {Type: MomentumType.DelayedBreadthHigh, Time: minutes from entry to until, Value: {Type: None, Value: 0}}` |
    | `lots` | `LotConfig {Type: LotType.Quantity, Value: lots}` (1 lot entered in the builder exports as 1) |
    | `overall.stop_loss_inr` | `OverallSL {Type: OverallTgtSLType.MTM}` |

    The constants are copied from the sample: `version 0.8`, `TakeUnderlyingFromCashOrNot "True"`,
    `StrategyType.IntradaySameDay`, `MaxPositionInADay 1`, `WeeklyOldRegime true`, `attributes.template
    Straddle920`. `execution.*` (slippage, cost, lot sizing) is engine-only and not exported. **Any other
    field that is set** (momentum, targets, roll, range breakout, overall trail or lock, re-entry other
    than `cost`) raises an error naming the field. It is never dropped or guessed. A new mapping is added
    only with a verified example file.
  - Leg `id`s: 8 lowercase alphanumerics, derived from a hash of the strategy id and the leg id, so the
    same strategy always exports to the same bytes.
  - `obt rotation algotest-export [--day D] [--book core|t1|both] [--preview] [--variants a,b] [--out DIR]`:
    by default the day's recorded journal entry (list C; the Buy add-on included and labelled). With
    `--preview`, the evening's `next_session_picks` for the next session, with the file names marked
    `preview`. Writes `<id>.algtst` and `<day>-<book>.zip`, and prints a table (entry, legs, SL, trail,
    re-entry, MTM SL) to check by eye.
- **Deliverables:** module, CLI, `tests/unit/test_algotest_export.py`.
- **Done when:** the owner's sample (time set back to its YAML's 09:17) and the three 2026-10-19 T1 files
  are reproduced field for field, leg `id`s aside. Every file in `strategies/rotation/` and
  `strategies/rotation_t1/` exports or fails with a named field, and the test lists which. The 224 T1 files
  in `~/Downloads/t1-algtst/` are compared once and the differences are logged here.

### Phase 2 — Discovery spike: how AlgoTest saves an imported strategy (owner present)

- **Tasks:** the owner signs in to AlgoTest in the built-in browser. One file is imported by hand while
  the network requests are recorded. Write down: the request that saves it (URL, method, body: the raw
  `.algtst` or a converted shape), the auth it carries (cookie and CSRF header from `POST /login`, or
  something else), the request that lists saved strategies and the one that reads one back, the
  strategy-name rules, and any limit on how many strategies can be saved. Delete the test strategy
  afterwards, by hand.
- **Deliverables:** a new §7 in `docs/algotest-execution.md`, "Strategy import contract", in the style
  of §2, with redacted example requests.
- Also record the delete request and what AlgoTest does when asked to delete a strategy that is
  deployed or running. Phase 4 deletes every evening.
- **Done when:** one of these is chosen and the reason logged here:
  - **(a) HTTP:** `POST /login`, then the save call. No browser, no selectors. Preferred if the save
    call is plain JSON.
  - **(b) Playwright:** a new flow in `packages/broker-login` that reuses its AlgoTest login and calls
    `setInputFiles` on the import control, with the locators in `selectors.ts`.

### Phase 3 — Uploader, dry run by default

- **Tasks:** `upload` (TypeScript in `packages/broker-login` for either route, so AlgoTest credentials
  stay in one package; it reads the Phase 1 files and imports no Python):
  - **Idempotent by name:** list the saved strategies first and skip a name that is already there with
    the same content. A name that exists with different content is a stop and an alert, never an
    overwrite.
  - **Read-back:** after each save, read the strategy back and compare it with the sent file
    (leg `id`s aside). Any difference raises an alert and the run stops.
  - **Delete** (for Phase 4's evening replace): only ids in the ledger whose name carries the tool's prefix.
    It refuses a strategy AlgoTest reports as deployed or running, and alerts.
  - `--dry-run` is the default and `--apply` must be passed. A kill switch (`ALGOTEST_UPLOAD=off`) is
    checked at start. One attempt per call, never blind-retried (§2: AlgoTest does not de-duplicate).
- **Deliverables:** the uploader, its tests against a recorded fake, and a `bun run algotest-upload`
  script.
- **Done when:** a supervised `--apply` with the owner watching uploads one day's six picks, the read-back
  passes, and re-running it changes nothing.

### Phase 4 — The daily cycle (scheduler)

The owner chose this shape on 2026-10-19. The 09:16 pick leaves under a minute before the first 09:17
entry, so the strategies must already be in AlgoTest the evening before.

- **Evening, replace:** once the evening result message has gone (`options-rotation-result`, normally
  16:00), the job runs:
  1. Delete every strategy **this tool uploaded** (the ledger, below). Strategies the owner made by hand
     are never touched.
  2. Upload tomorrow's predicted picks (`next_session_picks`, Core and T1), the same list the message
     names.

  It runs after that job, not on a fixed 16:00 clock. When the day's data is late (a Fyers login wait;
  the evening run retries until 20:15), the predicted picks are not ready at 16:00. The upload follows
  whenever they are, and an evening with no complete picks uploads nothing and alerts.
- **Morning, top up:** right after the 09:16 pick is recorded (`pick --with-t1`), compare the recorded
  picks with what was uploaded the evening before:
  - **No change:** nothing to do.
  - **Changed:** upload the new strategies.

  - **Dropped picks:** left in AlgoTest until the evening delete, never deleted in the morning (owner,
    Q8).

  The owner's message gets one line for this, e.g. "AlgoTest: 5 ready from last night, 1 added 09:16:30
  (N_wide-t1s4_0947); not today: N_p150-t1s11_1317". A failed or slow upload never holds back the 09:16 message.
- **Ledger:** `TRADING_DATA_ROOT/rotation/algotest/uploads.jsonl`, insert-only. One row per upload and
  per delete: day, book, variant, AlgoTest strategy id, name, content hash, and why (`evening` / `topup`).
  The evening delete reads its targets from this ledger, and also requires the name prefix (Q3). A strategy
  must pass both checks to be deleted.
- **Tasks:** two scheduler jobs, or steps in the existing two (`apps/scheduler` registry, alert-only on
  failure). Document them in `technical.md` and the scheduler's `CLAUDE.md`.
- **Done when:** five trading days run unattended. Each morning every recorded pick is in AlgoTest by
  09:16:40. No strategy is uploaded twice. No strategy the tool did not create is ever deleted.

### Phase 5 — Check the first week

- **Tasks:** for each traded day of the first week, compare what AlgoTest ran (from its order list or
  the contract note, BL contract-notes) with the strategy file: strike, SL, trail, re-entries, MTM exit.
  Log any difference in AlgoTest's behaviour. It goes to BL-009; this item does not change the engine to
  match.
- **Done when:** five days are compared and logged.

## Risks

- **Undocumented endpoint.** Route (a) relies on an AlgoTest internal call that can change without
  notice. The read-back check catches a silent change, and route (b) is the fallback.
- **Mapping drift.** A field that means something slightly different in AlgoTest (lot unit, trail
  semantics, `WeeklyOldRegime`) gives a strategy that looks right but trades differently. Unmapped fields
  are refused, and Phase 5 checks real fills.
- **Credentials.** The uploader needs `ALGOTEST_PHONE` / `ALGOTEST_PASSWORD` on the laptop (today they
  are GitHub Actions secrets). They are read only by `broker-login` and registered with `@trading/notify`'s
  redaction.
- **Preview vs pick.** A different VIX band at 09:15 can change a pick. The 09:16 top-up covers it, and
  the message says which strategies are ready. A strategy that dropped out stays in AlgoTest until the
  evening delete (owner's choice, Q8), so the 09:16 line also names it as "not today".
- **Deleting the wrong thing.** "Delete all" in AlgoTest would also remove the owner's own strategies (for
  example the range breakout and the Dir 09:24 ITM1 ones from 2026-10-07). Deletes are therefore limited
  to the ledger plus the name prefix, never "everything in the list".
- **Name collisions** with the owner's own saved strategies. Use a prefix (`R-` Core, `T1-`), Q3.

## Open questions

1. ~~Library or daily?~~ **Answered 2026-10-19:** daily. After the evening message, delete the strategies
   from the evening before and upload the predicted picks. At 09:16, add only the picks that changed.
2. ~~Route~~ **Settled 2026-10-19: the website, through Playwright** (AlgoTest support OK'd it by phone). Earlier: first answered "HTTP if possible". AlgoTest's terms forbid reverse
   engineering (BL-138 Log), so the choice waits for AlgoTest support's written reply, sent by the owner
   2026-10-19: website through Playwright, or the Signals API (which would make the upload and delete unneeded).
3. ~~Naming?~~ **Answered 2026-10-19:** a book prefix plus the variant id (`T1 · N_p150-t1s11_0917`, later
   `Core · N_wide_1117`). If AlgoTest refuses `·` the spike picks the nearest allowed separator.
4. **`LotConfig` `LotType.Quantity` `Value: 1`:** is that 1 lot or a quantity of 1? (Check in the UI
   during Phase 2.)
5. **`WeeklyOldRegime: true` and `template: Straddle920`:** keep them as in the sample? What does
   `WeeklyOldRegime` change?
6. ~~Buy add-on?~~ **Answered 2026-10-19:** upload it on the days it is picked, labelled as the add-on.
   The owner decides whether to deploy it.
7. ~~Core too?~~ **Answered 2026-10-19:** T1 only first; Core once the cycle has run clean (Phase 4's five
   days). The exporter supports both from Phase 1.
8. ~~A pick that dropped out at 09:16?~~ **Answered 2026-10-19:** leave it until the evening delete. The
   09:16 message's AlgoTest line names the picks that dropped out, so it is clear which ones not to deploy.

## Log

- 2026-10-19 — created from the owner's request ("export the T1 picks to .algtst and upload them to
  AlgoTest"). A browser import was tried first and stopped at AlgoTest's sign-in; nothing was uploaded.
- 2026-10-19 — owner chose the daily cycle (Q1): at 16:00 delete and upload tomorrow's predicted
  strategies; at 09:16 add any that changed. Recorded as Phase 4. The owner's "delete all strategies" is
  limited to the ones this tool uploaded (ledger + prefix). The evening step follows the result message,
  not a fixed 16:00, so a late-data evening still uploads. Q8 added.
- 2026-10-19 — Q8 answered: picks that dropped out stay until the evening delete; the 09:16 line names them.
- 2026-10-19 — started. Answers: T1 only first, name `T1 · <variant>`, Buy add-on uploaded, HTTP route if
  possible. Q4 / Q5 (lot unit, `WeeklyOldRegime`) are settled by observation in Phase 2. Claude will not type
  the AlgoTest password itself: the owner runs the Phase 2 login, and from Phase 3 the owner's scheduled code
  logs in from `.env` as the 08:00 job does. TODO §3.30 added; Phase 1 begun.

- 2026-10-19 — Phase 1 built: `legwise/algtst.py`, `rotation/algtst_export.py`, `obt rotation
  algotest-export [--day] [--book t1|core] [--preview] [--variants] [--out]`. The owner built three
  strategies by hand in AlgoTest and exported them, settling every inferred mapping. Three guesses
  (also in the 224 files made outside the repo on 2026-10-19, which are therefore wrong) were
  corrected: a closest premium is a bare number in `StrikeParameter`; re-entry at cost is
  `ReentryType.AtCost` with `ReentryCount`; a range breakout is AlgoTest's momentum setting
  `MomentumType.DelayedBreadthHigh` with `Time` in minutes, not a `LegRangeBreakout` key. Buy legs and
  a trail in points were guessed right. The four exports are the test fixtures; all 521 Core-298 and T1
  files export. Not yet known: how AlgoTest encodes a range on the index (`source: underlying`) or
  side low, so both are refused.
- 2026-10-19 — Q2 reopened after reading AlgoTest's terms (BL-138). Phases 2–4 wait for support's reply.
- 2026-10-19 — AlgoTest support said by phone that the automation is fine (BL-138 Log); Q2's route is being settled with the owner.
- 2026-10-19 — Phase 2, website route (owner's choice after AlgoTest's verbal OK), done by Claude in the
  owner's signed-in browser:
  - **Import:** `/backtest` has a hidden `<input type=file accept=".algtst,.json">` behind "Import .algtst";
    setting a file on it (Playwright `setInputFiles`) fills the builder in the page. Nothing is saved yet, and
    the strategy's name comes from the file's `name`. `T1 · TEST · N_p150-t1s11_1317` imported with every
    setting as exported (entry 13:17, exit 15:28, closest premium 150, SL 60%, trail 15/10, MTM ₹4,000).
  - **Save:** the bottom bar's "Save Strategy" opens "Save New Strategy" with the name filled in; "Done"
    sends `api.algotest.in/strategy` and shows "Strategy Saved"; the bar then offers Update / Save As New.
    The `·` in names is accepted. In a window narrower than about 500 px the page switches to a mobile
    layout without the Save button (what the owner saw while recording): the uploader uses 1440 x 900.
  - **List:** Backtest's left sidebar, Saved Strategies › MY STRATEGIES; each row's ⋮ has Add to folder and
    Delete.
  - Not yet seen: the delete request (Delete is the owner's click; Claude does not delete).
- 2026-10-19 — Q2 settled: the website route (Playwright), after AlgoTest support's verbal OK. BL-138 (auto-deploy) dropped by the owner, so this item stops at saved strategies; the owner deploys. Phase 3 begun.
- 2026-10-19 — Phase 3 built: `packages/broker-login/src/strategy-plan.ts` (pure: keep / upload / delete /
  conflicts / deployed-kept / not-today, ledger of its own uploads, read-back comparison; 10 tests) and
  `src/strategy-upload.ts` (Playwright: log in, read the saved list from AlgoTest's own `/strategies` response,
  read `/live`'s "n Deployed" before deleting, import + save + export-back per strategy, ledger
  `TRADING_DATA_ROOT/rotation/algotest/ledger.jsonl`, one Telegram message). `--apply` needs
  `ALGOTEST_UPLOAD=on`; deleting also needs `--allow-delete` until the delete dialog has been seen. The evening
  run refuses anything but a preview for a later day, the top-up anything but today's recorded picks. The export
  gained `--next` and writes `latest-<book>.json` for the uploader. Phase 4: jobs `algotest-evening` (16:40,
  retried hourly to 20:40) and `algotest-topup` (09:18) registered. Not yet run against AlgoTest.

