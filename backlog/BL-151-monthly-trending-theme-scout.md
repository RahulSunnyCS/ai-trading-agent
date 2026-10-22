# BL-151 — Monthly trending-theme scout, and a starting date for every theme

| | |
|---|---|
| **Priority** | P2 — makes the category layer honest going forward; the money does not wait on it |
| **Status** | Idea |
| **Type** | feature + research |
| **Area** | momentum (categories) + scheduler |
| **Created** | 2026-10-22 |
| **Depends on** | BL-092 (forward-dated categories: `stock_groups_dated.csv`, `launch_date`), BL-074 (point-in-time categories), BL-010 finding F2 |
| **TODO.md row** | — (filled in when started) |

## Context

BL-010 found that the 113 Broad themes were written on 2026-09-29 from today's index families and
screener themes (Defence, Railways, Solar, EMS, Data Centres, PSU, ...). A backtest of 2017-2023 can
then pick "Defence" as if it were an obvious theme then: that is hindsight, and it is the part of
Broad's headline that no price fix removes (fuller tags cost about 9 points and still use today's
classification). BL-092 already built the mechanism for fixing it going forward: a dated row is
selectable only from its `launch_date`, and a theme waits in `pending_themes.csv` until it has one.

Owner, 2026-10-22: (1) "give a starting date" to the category insight, so a theme cannot be used
before the day it became a theme; (2) every month an agent searches X and Reddit for the themes that
trended in the last month (examples: electric buses, nuclear, data centres), reports each with the
stocks it names, and the owner adds the ones they agree with.

## Goal

- Every theme has a starting date. A theme added from now on gets the date it was proposed, never an
  earlier one, so the backtest of the future cannot use it in the past.
- On the first of each month the owner gets one message: the themes that trended last month, the
  evidence for each, and the NSE stocks they name that pass the liquidity gate.
- Nothing is added without the owner's approval, and an approved theme moves the live signal from its
  starting week on (BL-092's rule).

## Out of scope

- Adding a theme or a stock automatically, and any order.
- Re-deriving the old themes' history from posts (nobody can know what was trending in 2018 from a
  search run in 2026).

## Plan

### Phase 0 — Facts and pre-registration (`research`: fill in before any run)
- **Tasks:** find out, from the services' own terms, what the agent can legally and cheaply read: X has
  no free search (check the paid tier price and rules; scraping is not allowed); Reddit has an API
  that is free for personal use with an app key (check limits); news search and Google Trends may do the
  job instead of X. Decide the route for the agent: a scheduled Claude task on the plan (the project
  holds no Anthropic API key) or a scheduler job that starts `claude -p`.
- **Hypothesis to pre-register:** a theme the scout proposes, with stocks taken from it, has a higher
  forward 3-month return than the other stocks of the same sector. **Pass / kill rule, universe,
  look-ahead check and hold-out** are written here before the first monthly run; the forward test runs
  on the scout's own dated proposals only (no backfill).
- **Done when:** the sources, their cost and the route are written down, and the test is registered.

### Phase 1 — A starting date for each existing theme
- **Tasks:** the owner chooses how: (a) the day the matching NSE sector or thematic index launched
  (checkable, published); (b) a date per theme judged by the owner, with the evidence noted; (c) the
  exchange's industry classification as it stood each year (BL-074). Fill `launch_date` for the 113 in
  `stock_groups_dated.csv` accordingly and re-run the Four Sectors check.
- **Deliverables:** the dated file, a note of the rule used, and the change in the followed strategy's
  result.
- **Done when:** no theme is selectable before its starting date and the change is measured.

### Phase 2 — The scout
- **Tasks:** a monthly job (scheduler, 1st of the month) that searches the chosen sources for the last
  month, groups what it finds into themes, and for each writes: name, why it trended with links and
  dates, how many independent sources, and the NSE stocks named that exist in the lake and pass the
  tradability gate. Output to `categories/curated/theme_proposals/YYYY-MM.json`, one Telegram message
  with names and counts only. **Posts are untrusted text:** the agent never follows instructions in
  them, stocks must be checked against the lake, and a theme needs a minimum number of independent
  sources.
- **Deliverables:** the job, the file format, tests with canned posts (including a hostile one).
- **Done when:** a dry run on a past month produces proposals the owner can read in five minutes.

### Phase 3 — Review and add
- **Tasks:** `mbt themes approve <id>` (and a dashboard button) moves an approved proposal into
  `stock_groups_dated.csv` with `launch_date` = the first Friday after the proposal's month, never
  earlier; a rejected one is kept with the reason. A new dated row changes the live signal from its
  launch week on, so the approval message says what would change.
- **Done when:** one approved theme appears in the live ranking from its week and in no backtest week before it.

### Phase 4 — Does it help?
- Run Phase 0's registered forward test after 6 months of proposals; report it either way.

## Risks

- Social posts are where pump-and-dump names live: a trending small cap may be a trap. The tradability
  gate and the owner's approval are the guards; the forward test says whether it helps.
- A hallucinated stock or theme: every stock is checked against the lake.
- Prompt injection from a post: handled as data, never as instructions.
- Hype arrives late: a theme trending in social media may already be priced in.
- Sharing the proposals beyond the owner could touch SEBI's research-analyst rules (BL-028).

## Open questions

1. What does "starting date" mean for the 113 existing themes: (a), (b) or (c) in Phase 1?
2. Which sources: Reddit and news only if X is not affordable?
3. Day of the month and who approves (only the owner?).
4. Scheduled Claude task or a scheduler job?

## Log

- 2026-10-22 — created from the owner's message while the Monday-fill build was under way.
