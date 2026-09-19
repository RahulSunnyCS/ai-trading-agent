# Golden Replay Fixture — v1

This directory contains the frozen golden fixture for T-57 deterministic replay tests.

## Files

- `fixture.json` — The complete frozen fixture: metadata + ticks + expectedLedger.
- `README.md` — This file.

## What the fixture contains

The fixture is a self-contained replay scenario for one NIFTY session segment:
- **Underlying**: NIFTY
- **Window**: 2024-01-25T03:45:00Z – 2024-01-25T04:15:00Z (09:15–09:45 IST)
- **Snapshot interval**: 15 000 ms (15 seconds)
- **Ticks**: 8 index ticks + 6 CE ticks + 6 PE ticks = 20 ticks total
- **Calendar gap**: ticks 7-8 are marked `gapMarker: true` to represent an observed
  calendar gap in the historical data (as would be produced by T-55 backfill and
  recorded in backfill_ranges.gaps_json). The feed continues emitting ticks on both
  sides of the gap — gap markers are metadata only.
- **Resolution tags**: all ticks carry `resolution: "1"` (1-minute candle data as
  would be stored by the Fyers historical backfill), satisfying the ≥1 resolution
  tag requirement for M3b backtest input.

## expectedLedger contents

The ledger records the straddle snapshots produced by replaying the fixture through
the pipeline. Each entry is a snapshot, not a paper trade (the position monitor
requires a real DB — the golden oracle tests the snapshot sequence deterministically
without Docker).

The snapshot ledger is compared structurally in the test:
- All numeric fields are compared via `Decimal.js` at 4 decimal places.
- Key ordering is canonicalised (sorted).
- The comparison is NOT byte-for-byte (avoids floating-point accumulation differences).

## Authoring process

The fixture was generated once by running the replay against synthetic in-memory
tick data (no broker, no DB required) and capturing the output. It is committed
as a FROZEN artefact. CI replays the fixture and asserts it produces the same
output — never regenerates the fixture per run.

## How to update

If a correctness-critical change to the snapshot algorithm is made (e.g. a fix to
ROC computation), the fixture MUST be updated by re-generating it from the updated
algorithm and committing the new expected ledger alongside the code change. The test
will fail until the fixture is updated — this is intentional (it forces explicit
acknowledgement of algorithm changes).

To regenerate:
  bun run scripts/replay.ts --regenerate-fixture

(This is a developer command, NOT run in CI.)
