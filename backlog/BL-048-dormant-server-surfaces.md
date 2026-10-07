# BL-048 — Dormant surfaces: the test-only server, broken personality edit, regime tags, the YAML engine

| | |
|---|---|
| **Priority** | P3: frozen or dormant areas; mostly decisions, plus one visible bug |
| **Status** | Planned |
| **Type** | chore |
| **Area** | server (+ options) |
| **Created** | 2026-10-07 |
| **Depends on** | none. Frozen-area rule: bug fixes and deletions only (`overview.md` → Frozen) |
| **TODO.md row** | none yet (filled in when started) |

## Context

The 2026-10-07 audit found four things that are either dead or half-wired:

1. **A second Fastify server used only by tests** (about 1,300 lines). It is made up of:
   - `apps/server/src/api/server.ts`;
   - `websocket.ts`;
   - `routes/{dashboard,paper-trades,personalities,status,trades}.ts`.

   Production (`src/server/index.ts:289-589`) re-implements `/api/trades`, `/api/personalities`
   and `/ws/ticks` inline. The two copies can drift, and the next item shows they already have.
2. **Saving a personality edit returns 404 in production.**
   `apps/dashboard/src/components/EditPersonalityDialog.tsx:121` sends `PUT /api/personalities/:id`.
   That route exists only on the test-only server (`api/routes/personalities.ts:268`).
3. **Nothing writes `daily_regime_tags`.** The only writer is
   `apps/server/src/trading/regime-tagging.ts` (982 lines, `INSERT` at line 685), and only tests
   import it. The readers will never see new rows:
   - `/api/regime-tags`;
   - the EOD job;
   - `backtest-runner.ts:317`;
   - the options `/anatomy` T-33 overlay;
   - obt's `regime_source.py`.
4. **The old YAML engine.** It lives in `engine/`, `features/`, `strategy/`, `analytics/` and
   `mcp/` of `option-backtesting`. It is still wired to the Builder's YAML mode and to MCP, but it
   runs on 23 AlgoTest raw files last changed on 6 Sep, not on the Fyers or vendor lake that the
   leg-wise engine uses.

## Goal

Each of the four has an explicit decision recorded, and the decided action is done.

## Out of scope

- Unfreezing the personality engine. That needs a validated edge (`overview.md`).

## Plan

### Phase 1 — Decide (with the owner)
- **Tasks:** ask the open questions below and record the answers.
- **Done when:** the answers are in the Log.

### Phase 2 — Act
- **Tasks**, according to the answers:
  - Personality edit: either register `PUT /api/personalities/:id` in `server/index.ts`
    (bug fix, allowed under the freeze), or hide the Edit button.
  - Test-only server: make the integration tests run against `server/index.ts`'s app factory,
    then delete `src/api/`.
  - Regime tags:
    - either schedule `regime-tagging.ts` as an EOD scheduler job,
    - or delete the readers' expectation and the T-33 overlay,
    - or compute regime tags in `trading-data` from the lake (which fits BL-034's derived tables).
  - YAML engine:
    - either freeze it as a golden demo and label it in the UI,
    - or point it at the lake,
    - or retire the AlgoTest ingest path and the Builder's YAML mode.
- **Done when:** no route the dashboard calls returns 404, and no module exists only for tests.

## Risks

- Deleting `src/api/` loses integration coverage if the tests are not moved first. Move them first.

## Open questions

1. Is editing personalities still wanted while the engine is frozen?
2. Regime tags: revive them (in `trading-data`, from the lake), or drop the overlay?
3. YAML engine: freeze it as a demo, port it to the lake, or retire it?

## Log

- 2026-10-07: created from the whole-repo audit.
