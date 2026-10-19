# BL-140 — Automation settings page: which broker logs in where, and which list each one gets

| | |
|---|---|
| **Priority** | P1 — the owner changes which list runs on which platform by asking for code changes; the daily jobs should follow a setting instead |
| **Status** | In progress — started 2026-10-19; Phase 1 |
| **Type** | feature |
| **Area** | dashboard + scheduler + broker-login + options |
| **Created** | 2026-10-19 |
| **Depends on** | BL-137 (AlgoTest upload), BL-139 (Quantiply upload), BL-012 (scheduler and its API) |
| **TODO.md row** | §3.33 |

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
| Master switches (asked at the start) | **Three, independent of the rows:** "Automated logins" (the 08:00 run and its GitHub backstop), "Automated uploads" (evening and 09:16 top-up uploads) and "Automated deployment" (BL-138 / BL-139 Phase 4). With a master switch off, no row can turn that kind of automation on |
| The 08:15 GitHub backstop | **Save also sets the repository variables** the workflow reads (`BROKER_LOGIN_ONLY`, `QUANTIPLY_LOGIN`, plus a new on/off for logins), through `gh variable set` on the laptop, so the backstop obeys the page too |
| The `.env` switches | **Kept as hard safety:** `ALGOTEST_UPLOAD`, `QUANTIPLY_UPLOAD` and `ALGOTEST_DEPLOY`. The page decides what runs, but nothing changes a platform unless its `.env` switch is also on |
| Quantiply · Shoonya | **Build its login in this item.** Quantiply logs in only through Angel One today; the Shoonya route needs a capture of that login with the owner |

## Goal

- Three master switches on the page: automated logins, automated uploads, automated deployment.
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
  - The master switches `logins`, `uploads` and `deploy` are stored in the same versioned object.
  - Add a CLI, `jobs settings show|set`.
  - **On Save:** sync the GitHub repository variables the 08:15 backstop reads. Variables:
    - `BROKER_LOGIN_ONLY` (finvasia / angelone / empty);
    - `QUANTIPLY_LOGIN` (on / off);
    - a new `BROKER_LOGIN_ENABLED` (on / off), which the workflow checks before logging in at all.

    The sync is done with `gh variable set` on the laptop. A failed sync is shown on the page and alerted; the saved version stands.
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

### Phase 3b — Quantiply login through Shoonya (owner, 2026-10-19)

Captured 2026-10-19 with the owner in the browser pane. Quantiply on Shoonya is the same web app as on Angel One, on
Shoonya's own hosts:

| | Angel One | Shoonya (Finvasia) |
|---|---|---|
| App | `app.quantiply.angelone.in` | `quantiply.shoonya.com` |
| Login start | `/auth?resume=/algos` → "Login / Sign Up" | the same |
| Broker page | `smartapi.angelone.in/publisher-login` (`angelOneForm`) | `api.shoonya.com/OAuthlogin/investor-entry-level/login?…&route_to=QUANTIPLY`: `#lgnusrid`, `#lgnpwd`, `#lgnotp`, `button.lgnBtnClss`, i.e. **exactly `finvasiaForm`** (AlgoTest's Shoonya login) |
| Lands on | `/algos` | `/algos` |
| Token | `localStorage["quantiply-dashboard-local"].token`, a JWT valid 9 h | the same key and claims, 9 h |
| API | `api-prod.quantiply.angelone.in` | `api-prod.quantiply.shoonya.com` (the same paths: `/algos/day-wise`, `/algos/config`, `/brokers`, …) |

- **Tasks:**
  - Make `quantiply-rules.ts` per broker: the app host, the API host, and the broker login page's URL predicate.
  - Add `quantiplyLogin` for Finvasia, reusing `finvasiaForm` and the `SHOONYA_*` secrets (TOTP), including its "Authorize" consent screen. The same rules apply: never screenshot logged-in pages.
  - `QuantiplyApi` takes the API host from the row, so the BL-139 uploader can serve Quantiply · Shoonya with no other change.
  - The 08:00 run logs in Quantiply · Shoonya when its row is on.
- **Done when:** a supervised 08:00 run logs Quantiply in through Shoonya.

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

- 2026-10-19 — Phase 2 built: the Automation card in Settings (`AutomationSettingsCard.tsx`, `lib/automation.ts`).
  - Three master switches and four blocks (login, list, upload). Choosing no list turns upload off.
  - Edits stay a draft until Save, with the changes listed in plain words and a Discard button.
  - The version line shows the GitHub sync outcome (failures in red). History lists each version's changes.
  - The Guide's Settings page has a new Automation section.
  - Checked in the browser against a throwaway scheduler API with a fake `gh`: two saves, history, the master-switch warnings.
  - "Apply now" is left for Phase 3, when the jobs follow the settings.
- 2026-10-19 — Quantiply · Shoonya captured (the owner logged in in the pane). It is the same app, token and API paths, on `quantiply.shoonya.com` / `api-prod.quantiply.shoonya.com`. The broker page is the Shoonya OAuth form AlgoTest already fills (`finvasiaForm`). Phase 3b is now mostly host parameters.
- 2026-10-19 — Phase 1 built:
  - `apps/scheduler/src/automation.ts`: validation, master gating, the versioned store in `scheduler.db`, and the `automation-settings.json` snapshot for jobs.
  - `GET`/`PUT /settings/automation`, which syncs the GitHub variables on save, and `jobs settings show|set`. 13 tests.
  - Nothing reads the settings yet: the workflow and the jobs follow them from Phase 3.
- 2026-10-19 — Started ("Start BL-140"). Answers:
  - three master switches (logins, uploads, deployment);
  - Save also sets the GitHub variables, so the 08:15 backstop follows the page;
  - the `.env` switches stay as hard safety;
  - Quantiply · Shoonya's login is built here (Phase 3b).

  Phase 1 begins.
- 2026-10-19 — Created from the owner's request. Layout and storage answered: one row per platform + broker, in the scheduler's database. Phase 4 lists the extra settings proposed when the owner asked what else would help.
