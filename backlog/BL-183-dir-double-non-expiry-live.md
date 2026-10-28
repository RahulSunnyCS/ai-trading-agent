# BL-183 — Dir ×2 on non-expiry days, live: Telegram, Quantiply, AlgoTest

| | |
|---|---|
| **Priority** | P1 — the owner trades both books with real money and wants the 4th lot from BL-133 live |
| **Status** | Built — off until the owner turns a row on |
| **Type** | feature |
| **Area** | options / broker-login / scheduler / dashboard |
| **Created** | 2026-10-28 |
| **Depends on** | BL-133 (Amendments 2–3), BL-137 / BL-139 (exports and uploaders), BL-140 (automation settings), BL-141 (live vs paper), BL-143 (trade monitor), BL-172 (08:10 MTM SL) |
| **TODO.md row** | 3.10.46 |

## Context

BL-133 Amendment 2 (PR #379) found the picked Dir the best home for a 4th lot on non-expiry days: Core +₹149 a day
over an even spread, T1 +₹96 (in-sample; the edge rests on a few days). Amendment 3: on expiry days 3 lots of the
expiring index beat any 4-lot mix. Angel One's margin calculator (2026-10-28) gives ≈ ₹2.0 lakh a lot for every
shape, so 4 lots (≈ ₹8.1–8.3 lakh) fit the ₹8.54 lakh account on normal days only.

Owner (2026-10-28): "what we found out as an edge is adding dir during non expiry day. so add that in telegram
messages, how quantiply is deploying etc etc".

Today every pick is 1 lot: the strategy YAMLs say `lots: 1`, and the only scaling is the account row's multiplier
(BL-140), which applies to every algo of the row.

## Decisions (owner, 2026-10-28)

- **Books:** Core and T1 both.
- **Rule:** on a non-expiry day (neither index's weekday days-to-expiry is `0`), the picked Dir trades 2 lots. No Dir
  picked (three Widesl) → 3 lots as picked (the owner weighed doubling the top Widesl or adding the best unpicked
  Dir: on those days neither beat an even spread in either book). Expiry day → 3 lots.
- **Book stop:** on a 2-lot day the tool raises the Quantiply clientwise MTM SL by the Dir's own MTM SL (₹8k → ₹11k
  Core, ₹9k → ₹12k T1 for a ₹3,000 Dir). AlgoTest has no tool-set book stop; that stays by hand.
- **Switch:** one toggle per Settings › Automation row ("Dir ×2 on non-expiry days"), off until the owner turns it
  on.
- A strategy's MTM SL is per lot, so a 2-lot Dir carries twice its rupee stop (₹3,000 → ₹6,000).

## Goal

With a row's toggle on: the evening and morning exports for that row's list carry the Dir at 2 lots with a doubled
MTM SL on non-expiry days; the uploaders, deployers and 09:25 check treat that as the expected state; Quantiply's
book stop follows; the 09:16, evening and 16:00 Telegram messages say what is traded; live vs paper counts lots
right. With every toggle off nothing changes, byte for byte.

## Out of scope

- A 4th lot on no-Dir days or on expiry days; 5+ lots.
- The AlgoTest deployer (the owner deploys on /live by hand), the BL-135 forward tracker, `margin.csv` (owner: leave
  it; it now understates a 4-lot day), the trade monitor's loss alert levels.

## Plan

### Phase 1 — Rule, settings, exports

- **Tasks:** `rotation/live_lots.py` (`lots_for_day`, reusing `lot_plans.dir_pick` / `is_expiry`); a `dirBoost` row
  field in the scheduler schema, the dashboard lib, the Python and the broker-login readers; `dir_boost_wanted` /
  `dir_boost_mixed` (every uploading row on → on; mixed → off, said in the manifest); `DayPicks` carries `dte` and
  `lots`; `build()` scales leg lots and the overall MTM SL; manifests record lots; CLI flags.
- **Done when:** unit tests pass; with the toggle off every existing export test is unchanged.

### Phase 2 — Platforms and checks

- **Tasks:** the 08:10 Quantiply morning run sets the row's MTM SL + the extra lots' stops; the 09:21 top-up only
  widens; `checkAlgoTest` compares lots with the export; live vs paper counts copies by captured leg quantity.
- **Done when:** unit tests pass; dry runs show the ₹11k / ₹12k stop and 2-lot bodies.

### Phase 3 — Messages and dashboard

- **Tasks:** the 09:16 picks message, the evening tentative list and the 16:00 result say the lots; the Settings ›
  Automation toggle; Guide pages; `technical.md`.
- **Done when:** message tests pass; dashboard typecheck and tests pass.

## Risks

- Evening preview and 09:16 pick disagree (BL-165: 97 % the same): a Dir picked only at 09:16 is uploaded by the
  morning top-up at 2 lots; the book stop then only widens at 09:21.
- Calendar vs listed days-to-expiry differ on a holiday change: the 09:16 entry's labels decide; the evening upload
  may then be 1 lot where 2 were wanted (the 09:25 check reports the lot mismatch).
- Margin: 4 lots ≈ ₹8.1–8.3 lakh against ₹8.54 lakh; a high-VIX morning can exceed it.

## Log

- 2026-10-28 — Created after BL-133 Amendments 2–3; owner's decisions recorded above; TODO 3.10.46; Phase 1 begun.
- 2026-10-28 — Phases 1–3 built (PR on `feat/bl-183-dir-double`):
  - **Rule and settings:** `rotation/live_lots.py` (`lots_for_day`, `scaled`; `dir_pick` / `is_expiry` moved here
    from `lot_plans`, which imports them, to keep the messages free of a circular import). `dirBoost` row field in
    the scheduler schema, the dashboard, the Python and broker-login readers; old snapshots read as off.
  - **Exports:** `DayPicks` carries `dte` and `lots`; both exports double the picked Dir's leg lots and overall
    MTM SL when every row uploading the list on that platform has it on (`dir_boost_wanted`; mixed rows → 1 lot,
    said). With it off the bodies and manifests are byte-identical to before; on, the manifest records `lots`
    per pick, `dte` and `dir_boost`. CLI `--dir-boost/--no-dir-boost`.
  - **Quantiply book stop:** the 08:10 run sets the row's MTM SL + Σ extra lots × the pick's per-lot stop from the
    export (`bookStopExtra`); the 09:21 top-up only widens (`clientwiseBelow`). **T1's Dir variants mostly carry a
    ₹4,000 stop**, so a T1 Dir ×2 day is ₹9,000 + ₹4,000 = ₹13,000 (Core ₹8,000 + ₹3,000 = ₹11,000).
  - **Checks:** the 09:25 Quantiply check already compares leg lots with the export. No AlgoTest lot check was
    added: AlgoTest's /live shows no leg lots, and the uploader already exports every saved strategy back and
    compares it with the export (lots included).
  - **Live vs paper:** copies count as multiplier × the export manifest's lots for that pick.
  - **Messages:** 09:16 (`🔢 4 lots · Dir ×2` / `3 lots · expiry day` / `3 lots · no Dir picked`, the Dir marked
    `· 2 lots`), the evening tentative list, and the 16:00 result's "As traded (Dir ×2, N lots)" line, for a list
    some platform's export trades the rule on; owner and group alike. Guide pages (Settings, Rotation) and
    `technical.md` updated.
  - **Verified:** unit tests (Python 1,745 pass; the 16 that need the Parquet cache fail in a fresh worktree as
    documented; broker-login 310, scheduler 245, dashboard 2,009). Dry run on the real store into a scratch folder:
    28 Oct (non-expiry) Core `N_ditm1_0947` and T1 `S_ditm1-t1s44_0917` at 2 lots with ₹6,000 / ₹8,000 stops; the
    29 Oct preview (SENSEX expiry) every pick 1 lot. Not run: the uploader and deployer dry runs (they log in to
    the platforms).
  - **To go live:** merge, restart the scheduler (`deploy/launchd/install.sh` or the scheduler restart the owner
    uses), turn "Dir ×2 on non-expiry days" on in Settings › Automation for the rows wanted, then watch the first
    evening upload (16:45), the 08:10 MTM SL line and the 09:25 check on the first non-expiry day.
