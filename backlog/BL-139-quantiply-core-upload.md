# BL-139 — Rotation Core picks to Quantiply (Angel One): add them through its algo form, deploy built but off

| | |
|---|---|
| **Priority** | P1 — the owner trades the Core picks with real money every day and sets them up on Quantiply by hand |
| **Status** | Ready — questions answered 2026-10-19; Phase 1 needs the owner to open Quantiply's algo form |
| **Type** | feature |
| **Area** | options + broker-login |
| **Created** | 2026-10-19 |
| **Depends on** | BL-137 (rotation export, picks, the evening/top-up planner and its ledger), BL-138 (deploy, built but off), the Quantiply login (#261, #262) |
| **TODO.md row** | — (filled in when Phase 1 starts) |

## Context

The owner, 2026-10-19: "we also need to automate adding the core adaptive strategies dynamically to
quantiply.angelone also".

- **BL-137** does this for AlgoTest:
  - `obt rotation algotest-export` turns the picks into `.algtst` files;
  - `strategy-upload.ts` uploads them:
    - in the evening it replaces the strategies with tomorrow's predicted picks;
    - at 09:16 it adds only the picks that changed;
    - a dropped pick stays until the evening.
  - It keeps a ledger, so it only ever deletes strategies it uploaded itself.
- **BL-138** deploys them on AlgoTest. It is built, but off until `ALGOTEST_DEPLOY=on`.
- **Quantiply** (`app.quantiply.angelone.in`) is Angel One's algo platform.
  - The daily 08:00 broker-login run already logs in to it through Angel One's SmartAPI page (`src/quantiply.ts`, `QUANTIPLY_LOGIN=on`).
  - Its strategies are built in a form. There is no import file (owner, 2026-10-19).
  - BL-118 records that Quantiply paused algo services on 31 March 2026 for SEBI's retail algo framework. The owner uses it now, so they are back for the owner's account.
- Nothing yet reads or writes Quantiply's algo list or its form.

## Goal

- Every evening after the 16:00 result, the Core book's predicted picks for tomorrow are on Quantiply.
- At 09:16 any changed pick is added.
- Each strategy is named `Core · <variant>` and matches the strategy YAML field by field.
- No strategy the tool did not add is ever touched.
- One Telegram message is sent per run.
- Deploying is built but stays off unless the owner turns it on.

## Out of scope

- The T1 book: T1 stays on AlgoTest (owner, 2026-10-19). Adding it later is just a book choice.
- Placing orders from this repo. Quantiply places them on the owner's own Angel One account once the owner deploys.
- Quantiply's Custom Scripts webhook signals (BL-118 context).

## Answers (owner, 2026-10-19)

| Question | Answer |
|---|---|
| How is a strategy added on Quantiply today? | Built by hand in its form (no import file) |
| When should the picks reach Quantiply? | Same schedule as AlgoTest: evening replace with tomorrow's predicted picks, 09:16 add only what changed; dropped picks stay until the evening |
| Should the tool also deploy them? | Build deploy too, but off (like BL-138) |
| Which lists? | Core only; T1 stays on AlgoTest |

## Plan

### Phase 1 — Map Quantiply's algo pages (with the owner)

- **Tasks:**
  1. The owner opens Quantiply logged in, in the browser pane or under a recorder like BL-137's `scripts/record-strategies.ts` (its HAR redacted, output kept in `_rec/`).
  2. Read the pages, without saving or deploying anything:
     - the algo list;
     - the "create algo" form;
     - an existing algo opened for edit;
     - the delete confirmation;
     - the deploy control.
  3. For each field of the form, note:
     - its label, its control type and the values it accepts;
     - its locator;
     - which YAML field it carries: legs, buy/sell, CE/PE, strike choice (ATM±n, closest premium), expiry, lots, leg SL % and points, trailing, re-entry, entry and exit times, the range-breakout entry, overall MTM SL.
  4. Check whether the form saves through a JSON call to `api-prod.quantiply.angelone.in`. If it does, a saved algo can be read back field by field, which is a stronger check than the screen.
  5. Check Angel One's and Quantiply's terms on automating the website, as was done for AlgoTest, and record the owner's decision.
- **Deliverables:**
  - a section "Quantiply algos through the website" in `docs/algotest-execution.md` (the page contract);
  - locators in `selectors.ts` (`quantiplyAlgoPage`), marked PROVISIONAL until a real run confirms them;
  - the list of Core YAML features the form cannot express.
- **Done when:** for each of the 12 Core-298 shapes, every field the YAML sets has a form field mapped to it, or is listed as unmappable with the reason.

### Phase 2 — Export the Core picks as Quantiply form plans

- **Tasks:**
  1. `to_quantiply(spec) -> FormPlan`: a neutral description of what to type into each field, built from the same `StrategySpec` as `to_algtst`. It raises `Unmappable` for anything Phase 1 found missing; it never guesses.
  2. Add `obt rotation quantiply-export [--day] [--preview] [--next]` (Core only). It reuses BL-137's `recorded_picks` / `preview_picks` and the manifest, written under `TRADING_DATA_ROOT/rotation/quantiply/<day>/core` with a `latest-core.json` pointer.
  3. Tests:
     - every Core-298 variant either maps or refuses with a named reason;
     - fixtures copied from algos the owner built by hand in Phase 1.
- **Done when:** today's Core picks export, and each plan matches the algo the owner built by hand for the same variant.

### Phase 3 — Add and replace on Quantiply (`quantiply-upload.ts`)

- **Tasks:**
  1. Log in the way `src/quantiply.ts` does, in its own browser context.
     - Angel One's TOTP rule holds across processes: two codes are never typed from one 30-second window (`angelTotp`).
     - Never screenshot a logged-in Quantiply page unless the run is local and the owner asked for it. The repo is public.
  2. Reuse `strategy-plan.ts`'s `plan()` for the two modes:
     - evening: keep, delete, upload;
     - top-up: upload only, and report changed and not-today picks.
     It gets its own ledger, `rotation/quantiply/ledger.jsonl`, and the `Core · ` prefix. It deletes only names the ledger says it added, and never a deployed algo.
  3. Fill the form from the plan, save, then read the algo back (from its JSON if Phase 1 found it, else the edit screen).
     - A mismatch is recorded and alerted. It is never deployed.
     - Gate: `--apply` needs `QUANTIPLY_UPLOAD=on`; without it the run is a dry run.
  4. Scheduler jobs `quantiply-evening` (after AlgoTest's 16:40) and `quantiply-topup` (09:18), each with retries like the AlgoTest jobs. One Telegram message per run (`broker.quantiply`).
- **Done when:**
  - a supervised `--apply` evening run and a top-up run leave exactly the Core picks on Quantiply;
  - each read-back matches;
  - the owner's own algos are untouched.

### Phase 4 — Deploy (built, off)

- **Tasks:**
  1. Write `quantiply-deploy.ts` on BL-138's pattern:
     - only today's recorded picks, each deployed once;
     - never once its entry minute has come;
     - the multiplier and product type are checked, not changed;
     - it stops on any popup it has not seen before;
     - it keeps its own deploy ledger.
  2. Gate it behind `QUANTIPLY_DEPLOY=on` and leave it off.
  3. Add a 15:35 check that nothing is left set to run on a later day.
- **Done when:** a dry run against the live page lists the right picks, and the owner has watched one supervised run (only if they choose to turn it on).

## Risks

- **The form is the contract.** A redesign breaks the filler. Every locator lives in `selectors.ts`, and the read-back catches a field that silently kept its old value.
- **Gaps in Quantiply's form.** Range breakout, closest premium, re-entry at cost or overall MTM SL may be missing. An unmappable pick is reported and left for the owner, never uploaded in a near-enough form.
- **Angel One login rate.** The 08:00, 09:18 and 16:4x runs each log in through Angel's TOTP. If Quantiply keeps its session, reuse a stored session instead of logging in again (Phase 1 checks this).
- **Speed at 09:16.** A 09:17 pick changed at 09:16 has about a minute. Filling a form is slower than AlgoTest's file import, so the top-up may miss a 09:17 change. It says so in its message rather than racing.

## Open questions

- How many lots per Core strategy on Quantiply? Today's evidence: the owner trades 3 Core strategies; the AlgoTest uploads are 1 lot each.
- Does Quantiply allow more algos than are deployed at once? The evening upload adds tomorrow's picks while today's may still be listed.

## Log

- 2026-10-19 — created from the owner's request. Questions answered: built in the form, AlgoTest's schedule, deploy built but off, Core only.
