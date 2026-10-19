# BL-140 — Automation settings page: which broker logs in where, and which list each one gets

| | |
|---|---|
| **Priority** | P1 — the owner changes which list runs on which platform by asking for code changes; the daily jobs should follow a setting instead |
| **Status** | Planned — layout and storage answered 2026-10-19 |
| **Type** | feature |
| **Area** | dashboard + scheduler + broker-login + options |
| **Created** | 2026-10-19 |
| **Depends on** | BL-137 (AlgoTest upload), BL-139 (Quantiply upload), BL-012 (scheduler and its API) |
| **TODO.md row** | — (filled in when started) |

## Context

The owner, 2026-10-19:
- A settings page should say what runs:
  - whether the Shoonya (Finvasia) login is done on Quantiply or AlgoTest, and the same for Angel One;
  - which list each of them gets.
- **Today:**
  - Quantiply · Angel One gets **Core** (Adaptive Classic);
  - AlgoTest · Shoonya gets **T1** (Adaptive Tuned).
- On "Save" the choice goes to a database, and the jobs follow it.

Today all of this is fixed in code and in switches:
- `BROKER_LOGIN_ONLY` and `QUANTIPLY_LOGIN` (GitHub variables) choose the 08:00 logins.
- The `algotest-*` jobs are hard-coded to `--book t1`.
- The `quantiply-*` jobs are hard-coded to Core, and `quantiply-export` refuses T1.
- `ALGOTEST_UPLOAD`, `QUANTIPLY_UPLOAD` and `ALGOTEST_DEPLOY` are `.env` switches.

## Answers (owner, 2026-10-19)

| Question | Answer |
|---|---|
| Layout | **One row per platform + broker**: AlgoTest · Shoonya, AlgoTest · Angel One, Quantiply · Angel One, Quantiply · Shoonya. Each row has its own on/off and its own list |
| Storage | **The scheduler's database** (its SQLite), through its loopback API, which the dashboard's Jobs page already uses. Every job reads the settings when it runs |

## Goal

- A dashboard page, Settings › Automation, where the owner sets, for each platform + broker row:
  - log in at 08:00 (on/off);
  - list: none, Adaptive Classic (Core) or Adaptive Tuned (T1);
  - upload the picks (on/off).
- **Save** stores a new version, with the time and every field. Older versions stay, as a history the page shows.
- Every job that logs in, exports or uploads reads the current settings when it starts. It writes the version it used into its ledger rows and its Telegram line.
- A change takes effect from the next run. An **Apply now** button re-runs that platform's evening upload for tomorrow's picks.
- The `.env` switches stay as master safety switches: with `QUANTIPLY_UPLOAD` off, no setting can make the tool change Quantiply.

## Out of scope

- Deploying (enabling) from the settings: BL-138 and BL-139 Phase 4 stay off. The page only shows their state.
- New brokers or platforms.

## Plan

### Phase 1 — Settings store and API (scheduler)
- **Tasks:**
  - Add a table `automation_settings` with one row per saved version: `version`, `saved_at`, and a JSON object of rows keyed `<platform>.<broker>`.
  - Add a pydantic-like validator in TS:
    - known platforms and brokers only;
    - list ∈ none / core / t1;
    - one list per row;
    - Quantiply · Shoonya allowed: Quantiply supports Shoonya as a paid plan (BL-118).
  - Add `GET /settings/automation` (current version plus history) and `PUT /settings/automation`, which validates and writes a new version, on the scheduler API.
  - Add a CLI, `jobs settings show|set`.
  - The first version is seeded from today's setup: Quantiply · Angel One = Core, upload on; AlgoTest · Shoonya = T1, upload on; AlgoTest · Angel One login on, no list; Quantiply · Shoonya off.
- **Done when:** the API round-trips and refuses bad input (tests), and the history is append-only.

### Phase 2 — The page (dashboard)
- **Tasks:**
  - Settings › Automation:
    - a table of the four rows: login, list, upload, with the deploy state shown read-only;
    - Save, and a diff of the change before saving;
    - the version history;
    - Apply now for each platform.
  - Built from `components/ui/` and tokens (no new controls), plus a Guide page.
  - Reached through the `/api/scheduler/*` rewrite.
- **Done when:** the owner changes a row, saves, and sees it in the history. Verified in the preview.

### Phase 3 — The jobs follow the settings
- **Tasks:**
  - **08:00 dispatch:** pass the logins from the settings as workflow inputs, replacing `BROKER_LOGIN_ONLY` / `QUANTIPLY_LOGIN`. If the settings cannot be read, fall back to the variables and alert.
  - **Exports:**
    - `algotest-export` and `quantiply-export` take the book from the settings for their platform;
    - `quantiply-export` accepts T1;
    - a platform with two rows on different lists exports both, named `Core · …` and `T1 · …`.
  - **Uploaders:** `--latest` takes the platform's settings rather than a fixed book. They plan per list and refuse a list the settings do not give that platform, so a stale export cannot upload the wrong list.
  - **Changing a row's list:** the next evening deletes the old list's finished algos, on the usual rules.
  - **Records:** each ledger row and Telegram message records the settings version used.
- **Done when:** switching Quantiply · Angel One from Core to T1 in the page makes the next evening run replace Core's algos with T1's. Checked in a dry run.

### Phase 4 — More settings that help the automation (the owner asked what else; proposed)
- **Lots multiplier per row:** written into each strategy's quantity, or Quantiply's `multiplier`. Today it is 1 and the owner changes it by hand when deploying.
- **Buy add-on per row:** on/off. Today it is always included.
- **Pause:**
  - "no uploads until <date>" for holidays and travel;
  - a one-click "skip tomorrow".
- **Portfolio stop per row:** ₹8,000 for Classic and ₹9,000 for Tuned, matching the dashboard cards. On Quantiply this could become the client-wise daily stop (`/brokers/:id/config`, seen in the web app's code; capture it before use).
- **Notifications per job:** on/off. This already exists for message types in Settings › Notifications; link it from here.
- **Morning check:** at 09:20, compare what is on each platform with the settings and the 09:16 picks, and alert on any gap. This catches a missed upload before the first entry.

## Risks

- **A setting changed late:** after 16:45 it does not reach tomorrow unless Apply now is pressed. The page says so, next to Save.
- **Settings unreadable** (the scheduler is down): jobs use the last version they wrote into their own ledger and say so. They never fall back to "everything on".
- **Two lists on one platform:** names keep them apart (`Core ·` / `T1 ·`), and the uploaders' ledgers already key ownership by name or id.

## Open questions

- Should the page also hold the times (16:40, 16:45, 09:18, 09:19)? Proposed: no, schedules stay in `jobs.ts`.

## Log

- 2026-10-19 — Created from the owner's request. Layout and storage answered: one row per platform + broker, in the scheduler's database. Phase 4 lists the extra settings proposed when the owner asked what else would help.
