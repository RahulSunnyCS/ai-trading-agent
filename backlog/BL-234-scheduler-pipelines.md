# BL-234 — Scheduler pipelines: merge the clock-chained jobs into a few ordered chains

| | |
|---|---|
| **Priority** | P2 — fewer things to watch and no more jobs started on a guess of how long the one before takes; the morning chain touches real money, so it is last and careful |
| **Status** | In progress — Phases 1, 2 and 3 built, not merged; Phase 2b and Phase 4 next |
| **Type** | improvement |
| **Area** | scheduler / infra |
| **Created** | 2026-11-18 |
| **Depends on** | none. Interacts with BL-231 (if the session collects option data, the evening chain loses its first step) |
| **TODO.md row** | 1.14 |

## Context

`apps/scheduler` runs 53 jobs (BL-012). Many are one process chained to another by
**clock time**, not by a real dependency:

- Morning: `angel-login-check` 08:00 → `broker-login` 08:02 → `quantiply-deploy` 08:10 →
  `algotest-activate` 08:11 → `options-rotation-pick` 08:45. The `quantiply` group already makes
  the first four run one after another; the times only say when each may start. The login waits for
  AlgoTest's 08:16 broker window and ends about 08:20, so `quantiply-deploy` in fact starts then
  (on 18 Nov it ran at 08:17, not 08:10).
- Evening: `options-evening` 15:45 → `options-rotation-result` 16:00 (retried to 16:35) →
  `algotest-evening` 16:40 → `quantiply-evening` 16:45 → `options-rotation-t1-update` 21:00. The
  16:40 and 16:45 slots exist only so the two uploads never log in at once, and each has its own
  retry ladder to wait for results that may not be ready.
- About a dozen alert-only checks (`check-*`, `calendar-upkeep`, `gh-auth-check`, the reminders),
  the contract-notes run plus three retries at 07:30, 10:30 and 15:30, the Friday momentum jobs
  from 19:30 to 22:00, and the 15:30–15:55 close-out jobs.

The runner already supports a job with several `steps` run in order, stopping at the first failure
(`options-evening` is five steps). What it lacks is what the morning chain needs: a per-step
failure policy, resume after a failure or a sleep without redoing finished steps, and a per-step
status on the Jobs page.

Last list of jobs and the groups they sit in: the scheduler's `jobs status` and `apps/scheduler/src/jobs.ts`.

## Goal

Roughly 18–20 jobs instead of 53 (33 after Phase 3), with these true:

- A chain starts its next step when the one before it **ends**, not at a guessed clock time; a step
  that must not run early declares `notBefore`.
- A failed step does not stop the steps that do not depend on it, and a re-run or catch-up after a
  sleep resumes at the first unfinished step.
- The Jobs page shows each step's result, so one red chain never hides which step failed.
- Nothing that today waits for the exchange, a mailbox or the owner's phone moves off its time.

## Out of scope

- The MCX jobs (`mcx-forward-spread` 18:00 quotes, `mcx-collect` waiting for the close,
  `mcx-forward-score`), `backup`, `weekly-digest`, the Kite reminders.
- The fixed-time jobs: `trade-monitor`, `rotation-live-board`, Friday `momentum-orders` /
  `momentum-preview` / `momentum-final`, the 08:05 Fyers reminder, `morning-summary`.
- Changing what any job does. Only when and in what order they start.
- Logging in to any platform more often, or retrying a login that was refused.

## Plan

### Phase 1 — Merge what needs no runner change (revised 2026-11-18)
Reading the code showed that only two of the planned merges are safe before the runner has a
per-step failure policy. The rest moved to Phase 2 (below).
- **Done (built 2026-11-18, branch `bl-234-scheduler-pipelines`, not yet merged or restarted):**
  - `morning-checks` (trading days 08:30): `check-nifty50-membership`, `calendar-upkeep`,
    `check-blocked-dates`, `gh-auth-check`, `universe-refresh-reminder`,
    `check-stock-ca-baseline-age`, `check-stock-review-queue`. `evening-checks` (17:00):
    `check-lot-sizes`, `check-expiry-calendar`. A suite runs every member and never stops at a problem;
    a member with retries (the three network checks, 2 × 30 min) is retried alone; the alert is ONE
    message naming each problem with its own fix. Nine jobs become two.
  - `contract-notes`: one job at 00:00, 07:30, 10:30 and 15:30 (`Schedule.at` may now be a list; the
    loop serves the latest slot only). Four jobs become one.
  - 53 jobs → 43. Tests: the suite's behaviour, multi-time schedules, the registry.
- **Moved out of Phase 1, and why:**
  - `momentum-friday-evening`: `momentum-journal-check`, `momentum-live-rules` and `momentum-history`
    `alertsItself` and write their own `logFile`s that the Momentum dashboard reads; `live-rules` and
    `history` are independent safety checks that a failed `journal-score` must not skip. Needs
    per-step `alertsItself`, `logFile` and failure policy (Phase 2).
  - `close-out`: `quantiply-disable` is the safety net that must run even when `live-capture` fails;
    a chain that stops at the first failure would skip it. Needs the failure policy (Phase 2).
  - `morning-topup`: `quantiply-topup` has `retries: 1` (not on exit 3) and a 0.5 h catch-up;
    `quantiply-deploy-topup` has `retries: 0` and 3 h. A whole-job retry would re-run an enable, which
    must never repeat. Needs per-step retries and catch-up (Phase 2).
- **Done when:** `jobs status` lists the merged jobs, and one week of trading days runs with the same
  Telegram messages and alerts as before (one message per bad morning where there were several),
  and `jobs run morning-checks` runs by hand. The scheduler must be restarted to read `jobs.ts`
  (`launchctl kickstart -k gui/$(id -u)/com.ai-trading-agent.scheduler`).

### Phase 2 — Runner: step failure policy, resume, per-step status
- **Done (built 2026-11-18, same branch, not merged or restarted):**
  - **Chains.** A `Job` may carry `chain: ChainStep[]` instead of `steps`. Each step has its own timeout,
    retries and delay, `noRetryExitCodes`, `onFail` (`stop` or `continue`), `requires` (skipped when a step
    it needs did not pass; held when that step was held), `notBefore` / `notAfter` (wait for a time, or
    record the step `late`, which is no failure), `alertsItself`, `logFile`, `holdId` and `fixHint`. A chain
    has no job-level retries. (`chain.ts`, `step.ts`.)
  - **Step rows.** `run_steps` in `scheduler.db`: `ok`, `failed`, `skipped`, `held`, `late`, `carried`,
    `running`, `unknown`. `GET /runs/:id/steps`; `GET /jobs` lists a chain's step ids.
  - **Resume.** The loop restarting a slot whose run was cut off (`restartIfInterruptedUntil`) resumes the
    earlier run of that slot by itself; a hand run resumes with `jobs run <chain> --resume` (or the API's
    `{"resume": true}`), starts at a step with `--from <step>`, or ignores the past with `--fresh`. A step
    that passed is `carried`, never run again. A step that was `running` when the run was cut off is
    `unknown`, and a resume refuses (exit 4) rather than repeat it: a login sent or an algo enabled must not
    repeat; `--from` runs it or skips it on purpose.
  - **Alerts.** One message per chain failure naming each failed or skipped step with its own fix, what
    passed, and the resume command; a step that alerts itself and really ran is left out.
  - **Holds per step.** The stop button's hold and the settings pause check a step's `holdId`, so the held
    lists keep the old job ids (`quantiply-topup`, `quantiply-deploy-topup`); `quantiply-disable` has none.
  - **Jobs page.** A chain's latest run opens a Steps panel (result, tries, time, note) and a Resume button
    behind a confirmation.
  - **The trade monitor** (`packages/broker-login/src/monitor-plan.ts`) names `close-out` and
    `morning-topup` for its "does a login job run now" test; the pause's "next session" cutoff moved from
    09:22 to 09:52, the end of the top-up chain.
  - **Merged by it:** `close-out` (15:30: `fyers-login-recheck`, `algotest-deploy-check`, `live-capture`,
    `quantiply-disable`, `contract-notes-capital`, `live-capture-retry`; every step `continue`, so the
    switch-off always runs) and `morning-topup` (09:19: `quantiply-export`, `quantiply-topup`,
    `quantiply-deploy-topup`; a failed top-up does not stop the enable, as before). Eight jobs become
    two: 43 → 37 jobs.
- **Not done, and why:** `momentum-friday-evening`. The Momentum API reads those jobs' run rows by job id
  and labels them with fixed clock times (`api.py` `_SCHEDULED_RUNS`, `_SCHEDULER_JOB_IDS`,
  `_scheduler_last_runs`), and their own log files for "ran late". Merging them needs that panel changed to
  read step rows and a different "when" per step, in another package (**Phase 2b**).
- **Tested:** 22 chain tests (order, stop, continue, requires, retries, `notBefore`, holds, resume,
  unknown step refusal, `--from`, alerts), API, registry, the monitor's lists, the dashboard panel; typecheck,
  Biome, scheduler 303, broker-login 358, dashboard 2098 tests.
- **Done when:** a simulated failure in each kind of step gives the expected result and resumes correctly
  (tested), a login step is never sent twice on a resume (tested: no retries, `unknown` refusal), and one
  week of live runs of `close-out` and `morning-topup` match the old jobs' messages and uploads.
- **Before the live restart:** restart the scheduler outside 09:19–12:19 and 15:30–21:30 on a trading day, or
  the first start will catch up the new chain slot at once (the new job ids count as new).

### Phase 2b — `momentum-friday-evening`
- **Tasks:** make the Momentum panel read `run_steps` (step ids `momentum-stock-ingest`,
  `momentum-journal-check`, `momentum-live-rules` kept as step ids), drop its fixed "Fri 21:00" labels for a
  chain, then merge `momentum-stock-ingest` → `momentum-journal-score` → `momentum-journal-check` →
  `momentum-live-rules` → `momentum-history` (the three `alertsItself` steps and their `logFile`s kept;
  `journal-score` requires the ingest; the rest independent).
- **Done when:** the Momentum "scheduled runs" panel shows the same four runs from the chain's steps.
- **Watch:** a chain holds the `catalog` group for its whole run, so the 21:00 T1 update on Fridays waits
  behind it.

### Phase 3 — `evening` chain
- **Done (built 2026-11-19, same branch, not merged or restarted):** one chain `evening` (15:45 trading days)
  replaces `options-evening`, `options-rotation-result`, `options-rotation-t1-update`, `algotest-evening` and
  `quantiply-evening`: 37 → 33 jobs. Steps, each starting when the one before ends:
  `collect` → `rotation-update` → `derived-rebuild` (retried 17:15 / 18:45 / 20:15 as before; a failure stops
  the chain) → `t1-update` (`--soft-fail`) → `result` (never before 16:00, retried every 5 minutes to 16:35;
  a failure does not stop the uploads) → `algotest-export`, `algotest-upload`, `algotest-setup` → 
  `quantiply-export`, `quantiply-upload` (each platform's steps `continue` past the other's failure; `requires`
  inside a platform; retried 4 × 1 h, never on exit 3; held under the old job ids) → `t1-catch-up` (strict,
  retried twice an hour apart) → `t1-result`. The 16:40 / 16:45 slots and the retry ladders that waited for the
  results are gone: the uploads cannot start before the data is in.
- **Runner additions it needed:**
  - **Step groups, taken lazily.** A step may name a `group` (`catalog` for the data steps, `quantiply` for the
    Quantiply steps; AlgoTest has none). A chain takes a group when it reaches that step and holds it to the
    end, so the chain starts at 15:45 without waiting for the 15:30 close-out's `quantiply` group, which it
    meets only at its first Quantiply step (about 16:40), after the switch-off. Without this the whole evening
    would have started about 40 minutes late. `groupsOf(job, only)` is every group a run holds.
  - **`only`.** `jobs run evening --only a,b` and `{"only": [...]}` run just those steps; the others count as
    done, leave no rows and never resume. The dashboard's **Apply now** buttons (Settings › Automation) now run
    `algotest-export`, `algotest-upload`, `algotest-setup` or `quantiply-export`, `quantiply-upload`, not a
    whole chain; they used to start the two upload jobs.
- **What else moved with it:** `monitor-plan.ts` (the monitor's login-job list names `evening`), the Options Lab
  evening run bar (`EVENING_JOB_ID = 'evening'`, so its status now includes the uploads), the Python overview's
  wording, the Guide, the launchd README and the project docs. The stop hold and the pause keep their old ids
  (`algotest-evening`, `quantiply-evening`) as step hold ids, so a pause still counts the evening upload as for
  the next session.
- **Tested:** the chain's shape and order, holds, groups and `only` in `chain.test.ts` and `schedule.test.ts`;
  the API's `only` and `groups`; the dashboard's Apply now body. Scheduler 313, dashboard 2098, broker-login
  monitor plan 34 tests; typecheck and Biome clean.
- **Done when:** three evenings run end to end with the same messages and the same AlgoTest and Quantiply
  uploads as the old jobs, including one evening where the data is late.
- **Risks found:**
  - On a bad evening the chain is long: data retries run to about 20:15, then each upload retries up to four
    times an hour apart, one platform after the other, so a worst case ends after midnight and holds the
    `catalog` and `quantiply` groups meanwhile. The old jobs ran in parallel, so one platform's failure did not
    delay the other's. Both uploads are only needed by 08:02 / 08:11, so I kept the old retry counts.
  - The Options Lab run bar reads the chain as the evening run, so an upload failure shows there as failed.
  - A group held by a lazily taking chain can in principle deadlock with a job that needs both groups; none does.

### Phase 4 — `morning-open` chain (real money; last)
- **Tasks:**
  - Order: `angel-login-check` → Quantiply login and `quantiply-deploy` → AlgoTest login (waits for
    08:16) → `algotest-activate` → `options-rotation-pick`. Start 08:00. Quantiply first, since it has
    no 08:16 window and can switch on around 08:05 instead of about 08:20.
  - Failure policy: a failed Angel One check does not stop the logins; a failed Quantiply login skips
    only Quantiply's deploy; a failed AlgoTest login skips only the activation; the pick always runs.
  - `broker-login` is split so Quantiply and AlgoTest logins are separate steps; the hand-off to
    GitHub's "Daily broker login" and `LOCAL_LOGIN_DONE` keep their behaviour.
  - A step past its latest useful time (the 09:15 entries) is skipped and alerted, not waited on.
  - Retire the 08:00, 08:02, 08:10, 08:11 and 08:45 jobs and the `quantiply` group.
- **Deliverables:** the chain and its tests, a dry-run mode that prints the order and waits without
  logging in, the Guide and Settings text changed.
- **Done when:** a dry run over a week of recorded timings matches the old order; then two live
  mornings with the old jobs switched off by `jobs settings` one at a time, no refused PIN, no
  double activation, the 08:10 Telegram message and the 09:00 summary unchanged.

## Risks

- **A resend of a refused PIN locks an account.** The old jobs avoid it with `retries: 0`; a chain
  that re-ran from the top after a late failure would resend it. Phase 2's resume record is the guard;
  Phase 4 does not start without it.
- **Double activation.** `algotest-activate` is never retried for the same reason. A resume must
  treat a step that started but did not record its end as unknown and stop for the owner, not repeat it.
- **One stuck step delays everything after it** and the 09:17 entries with it. Per-step timeouts and
  the "too late" skip.
- **Catch-up windows differ** per job today (login 7 h, activation 4.5 h, Angel check 70 min). A
  chain needs one rule per step, kept from the old values.
- **Losing the old run history** the Jobs page and alerts read. Keep old ids readable, map them.
- **A merged check job hides a quiet failure**, because the alert is per step only if Phase 2 is done
  first.

## Open questions

Answered by the owner on 2026-11-18 (the start of the item):

- Order: **Phase 1 first**, with the checks as one job that runs every check and exits non-zero at the
  end naming each problem; Phase 2's failure policy is not needed for them.
- Quantiply and AlgoTest: **Quantiply first**, switched on before AlgoTest's 08:16 window opens.
- `options-rotation-pick` **stays at 08:45** as its own fixed-time job, not a step of the morning chain.
- `morning-summary` **stays a fixed 09:00 job**, not a step of the chain.
- BL-231 (collect during the session) is not waited for: the evening chain is built so its collection
  step can be dropped when BL-231 lands.

Found when reading the code on 2026-11-18, to settle in the phase that meets each:

- The stop button's hold (`STOP_HELD_JOBS`) and the settings pause (`PAUSE_JOBS`) hold jobs **by id**.
  A chain that mixes held steps (uploads, deploys, enables) with read-only ones needs the hold per
  step, not per chain (Phases 3 and 4).
- A check is an in-process builtin and a job has one `builtin` or its `steps`, so Phase 1's merged
  checks need a composite builtin.
- The alert and notification catalogue, the 09:00 summary's slot list, the dashboard Jobs page and the
  Guide's jobs page all key on job ids; merging retires ids.
- The trade monitor reads `GET /jobs` before every login to see whether a login job is due or running;
  a chain widens that window and must still be seen as logging in to its platforms.

## Log

- 2026-11-18 — created from the owner's question whether the 08:00–08:11 jobs and the evening jobs
  could run as one chain. Read of `jobs.ts`: the morning is already ordered by the `quantiply` group;
  the clock times only start each job.
- 2026-11-18 — started. Owner answers recorded above (Phase 1 first, Quantiply first, 08:45 pick and
  09:00 summary stay fixed). Branch `bl-234-scheduler-pipelines` in `~/Projects/ata-bl234`, cut from
  origin/main, so the launchd checkout is not touched.
- 2026-11-18 — Phase 1 built and revised. The code showed `close-out`, `morning-topup` and the
  Friday-evening chain cannot merge safely before Phase 2, so Phase 1 is the two check suites and the
  one contract-notes job: 53 → 43 jobs. Typecheck, Biome and 273 scheduler tests pass; nothing committed,
  scheduler not restarted.
- 2026-11-18 — Phase 2 built: chains (per-step policy, resume, step rows, alerts, holds, Jobs page), and
  `close-out` and `morning-topup` on them: 43 → 37 jobs. `momentum-friday-evening` split out as Phase 2b
  because the Momentum panel reads those jobs by id and fixed time. Nothing committed; scheduler not restarted.
- 2026-11-19 — Phase 3 built: the `evening` chain replaces five jobs (37 → 33), with step groups taken lazily
  and `only` runs for Apply now. Nothing committed; scheduler not restarted.
