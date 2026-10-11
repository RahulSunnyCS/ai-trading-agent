# BL-089 — Backlog restructure: three tracks, a generated index, and a GitHub Projects board as the owner's dashboard

| | |
|---|---|
| **Priority** | P0 — set by the owner (2026-10-10): the backlog has outgrown a hand-kept table (50 open rows, 8 of them finished); one place that shows what needs doing comes before more items are added |
| **Status** | Ready (questions 1–3 and 5 answered 2026-10-10; not started: the owner will say when) |
| **Type** | chore |
| **Area** | cross-cutting |
| **Created** | 2026-10-10 |
| **Depends on** | none (a fine-grained GitHub token with Projects access, from the owner, before Phase 3) |
| **TODO.md row** | — (filled in when started) |

## Context

The owner (2026-10-10) asked to restructure the backlog: separate the research items from the
application items and from the technical ones (performance, security, infrastructure), move
finished items out of the open list, and have a dashboard that shows "what all things I need to
do". Jira and Notion were weighed; **the owner chose GitHub Issues plus a GitHub Projects board**
(2026-10-10), because the repo already has the GitHub connector, issues link to pull requests on
their own, and the board gives the kanban view without a second product.

Measured on 2026-10-10 (`backlog/INDEX.md`):

| Fact | Number |
|---|---|
| Rows in the Open table | 50 |
| Of which already finished (BL-053 to BL-061, the options POCs) | 8 |
| Research items among the open rows | 19 of 50 |
| Items "In progress" at once | 12 |
| Edits to `INDEX.md` in the last five days | 69 |

The "update `INDEX.md` in the same change" rule (`backlog/README.md`) has not held: the finished
rows prove it, and 69 edits in five days is more than a person can read. The fix is structural:
the item file becomes the only thing anyone edits, and the index, the done list and the board are
**generated** from it. That is the "one fact, one file" rule applied to the backlog itself.

**Design decisions recorded:**
- **Git is the master.** The item file holds the plan, the pre-registration and the log (the
  research gate needs them in version control). The issue and the board card are views with a
  link back. Nobody edits status in GitHub; the sync overwrites it.
- **One-way sync, idempotent.** Item file → issue (create or update) → project card fields.
  Re-running changes nothing when nothing changed. A closed item closes its issue.
- **Tracks are defined by what "done" means**, not by backend or frontend (most product items
  touch both; BL-051 is API and dashboard). Proposed:

  | Track | Done means | Examples today |
  |---|---|---|
  | `research` | a pre-registered verdict: adopted / killed / inconclusive / descriptive | BL-010, BL-050, BL-088, BL-053–061 |
  | `product` | a screen, job, signal or document someone uses | BL-051, BL-058, BL-041, BL-087, BL-038 |
  | `platform` | the system is faster, safer, cheaper or more reliable to run | BL-012, BL-014, BL-044, BL-045, BL-046, BL-021 |

  `area` (momentum, options, dashboard, …) stays as the second axis.
- **"What do I need to do" is a field, not a view.** The owner's real question is not "what is
  open" but "what is waiting on me". Every item gets a `Waiting on` value: `owner` (a question
  or a decision), `claude` (work in progress or ready), `external` (CI, a vendor, a token,
  data), or `none`. The board's first view filters on `owner`. Today those are hidden inside
  prose: BL-010's pending owner decisions, 3.9.23's four decisions, BL-025's money gate, BL-040's
  "ask the vendor", BL-088's six questions.

## Goal

The owner opens one GitHub Projects board and sees, without reading any file: what is waiting on
them, what is in progress per track, what is next by priority, and every research verdict. The
files under `backlog/` stay the source of truth and are never out of step with the board by more
than one push.

## Out of scope

- Jira, Notion or any second board (decided against, 2026-10-10).
- Editing items from the board (one-way only).
- Moving or renaming item files (every `TODO.md` and `docs/` link keeps working).
- Merging `TODO.md` into the backlog. Its 3.13.x rows now mirror backlog items one to one, so a
  generated "In progress" view could replace it; that is a separate decision after Phase 2
  (open question 4).

## Plan

### Phase 1 — Tracks and the done split (files only)
- **Tasks:**
  - Add a `Track` row to `_TEMPLATE.md`'s header table and to every item file (research /
    product / platform), and a `Waiting on` row (owner / claude / external / none).
  - Split the status column: `Status` keeps the workflow word only (Idea, Planned, Ready, In
    progress, Blocked, Done, Dropped); a new `Outcome` row carries the verdict ("killed: 0 of 30
    cells pass", "built; live migration pending"), so a status is always one word a board can
    group on.
  - Move the eight finished rows and every future one to `backlog/DONE.md`, grouped by track,
    one line each with the outcome and the closing date.
  - `INDEX.md` becomes three Open tables (one per track), each sorted by priority then ID, with
    a `Waiting on` column and a `Last touched` date (the file's last commit date).
  - Update `backlog/README.md` and the Backlog section of `CLAUDE.md` in the same change.
- **Deliverables:** the edited item files, `DONE.md`, the new `INDEX.md` shape, the rule text.
- **Done when:** no finished item is in an Open table and every item file has the four new rows.

### Phase 2 — Generate the index instead of hand-editing it
- **Tasks:**
  - `scripts/backlog.py index`: reads every `BL-*.md` header table, writes `INDEX.md` and
    `DONE.md`. `--check` exits non-zero if the committed files differ from what it would write.
  - A lefthook pre-push step runs `--check` (same pattern as BL-014's checks), so a push cannot
    carry a stale index. The "update `INDEX.md` in the same change" rule is deleted from
    `README.md` and `CLAUDE.md`: the generator does it.
  - A WIP line at the top of each track's table: how many items are In progress. No hard limit,
    just visible.
- **Deliverables:** the script, its unit test on a fixture of three item files, the hook step.
- **Done when:** `scripts/backlog.py index --check` passes on `main` and the hook refuses a
  push with a hand-edited index.

### Phase 3 — GitHub Issues and the Projects board (the dashboard)
- **Prerequisite from the owner:** create a user-level GitHub Project (v2) named "AI Trading
  Agent backlog" in the GitHub UI (two minutes; the API cannot create one on a personal account
  without a token that also has that scope), and a fine-grained personal access token with
  `issues: write` on the repo and `projects: read/write` on the user, stored as the repository
  secret `BACKLOG_PROJECT_TOKEN` and in the repo `.env` as the same name, registered with the
  notify package's secret registry like every other credential.
- **Tasks:**
  - `scripts/backlog.py sync`: for every item, upsert one issue titled `BL-NNN — <title>`, body
    = the Context's first paragraph, the Goal, the open questions, and a link to the file on
    `main`; labels `track:<track>`, `area:<area>`, `prio:P<n>`, `waiting:<who>`; the issue
    number written back into the item's header (`**Issue** | #123`), the one write the sync
    makes to the files. Done or Dropped → close the issue with the outcome as the last comment.
  - Add every issue to the project and set its single-select fields over GraphQL: Status
    (= the item's status), Track, Priority, Waiting on, Area, plus Last touched (date).
  - Board views, created once by hand and documented in `backlog/README.md`:
    1. **Needs me** — `Waiting on = owner`, grouped by track, sorted by priority. The view the
       owner opens first.
    2. **Now** — Status in (In progress, Ready), grouped by track, with the WIP count per group.
    3. **Next** — Status in (Planned, Idea), sorted by priority then last touched.
    4. **Research verdicts** — track = research, Status = Done, showing Outcome.
  - A workflow `.github/workflows/backlog-sync.yml` on push to `main` touching `backlog/**`
    runs `backlog.py sync` with the secret; `workflow_dispatch` for a manual run. A sync failure
    never blocks CI (it is a view, not a gate) but posts the run's log line to Telegram through
    the notify package.
  - Pull requests that name an item (`BL-NNN` in the title or body) are linked from the issue by
    GitHub's own cross-references; nothing to build.
- **Deliverables:** the sync command, the workflow, the four views, the README section that
  says "the board is generated; edit the file".
- **Done when:** every open item has an issue and a card with the right fields, a status change
  in a file appears on the board after one push, and the owner can answer "what needs me" from
  the Needs-me view alone.

### Phase 4 — Review after four weeks
- **Tasks:** record in the Log whether the owner used the board, which view, and what was
  missing; decide open question 4 (`TODO.md` as a generated view).
- **Done when:** the Log entry is written and any follow-up is its own item.

## Risks

- **Drift through the back door.** Someone changes a label or status on GitHub and expects it
  to stick. The sync overwrites it on the next push; the README says so, and the first "why did
  my change vanish" is the moment to repeat it, not to make the sync two-way.
- **The token.** A fine-grained token with project write on the user account is a credential
  that can edit every project the owner has. Scope it to the one project where GitHub allows
  it, register it as a secret so it never appears in a log, and rotate it with the others.
- **Issue noise.** Fifty issues appear on day one and every finished one closes; GitHub will
  send email for each. Create them in one run with notifications paused, or accept one noisy
  afternoon.
- **The header table as a schema.** It is Markdown, parsed by a script: a stray pipe breaks it.
  The generator reports the file and row it could not read and refuses to write a partial index.
- **Track is a judgement for a few items** (BL-049 is a product screen that serves research;
  BL-016 shows validation status). The rule: the track of the deliverable, not of the motive.

## Open questions

Answered by the owner on 2026-10-10 (1, 2, 3, 5); 4 stays open until after Phase 3.

1. **Tracks: by definition of done** — research / product / platform, as proposed. Area stays
   the second axis.
2. **Generated index: yes** — Phase 2 as planned, with the pre-push check.
3. **User-level project**, created by the owner, with the fine-grained token stored as the
   repository secret `BACKLOG_PROJECT_TOKEN` (the Phase 3 prerequisite; not yet done).
4. After Phase 3: should `TODO.md`'s 3.13.x rows be replaced by the generated "Now" view, with
   `TODO.md` keeping only the frozen-engine history (§3.1–3.7)? **Open.**
5. **Visibility: private**, the owner only; can be opened to the friends later.

## Log

- 2026-10-10 — created from the owner's request to restructure the backlog. Jira weighed
  (no connector, a second source of truth, research pre-registration must stay in git) and
  Notion weighed (better fit than Jira, still a second copy); **owner chose GitHub Issues plus a
  Projects board.** Facts measured and recorded in Context. Status `Planned`, P2.
- 2026-10-10 — owner answered the questions (tracks by definition of done; generated index;
  user-level private project with the `BACKLOG_PROJECT_TOKEN` secret), re-prioritised P2 → P0
  and asked for it to be pushed, **not started yet**: "we will take it up later". Status `Ready`.
  When started: add the `TODO.md` row, then Phases 1–2 can run without the token; Phase 3 waits
  for the project and the secret.
