# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working in this package.

## What this package does

`@trading/market-reference` is effective-dated NSE/BSE lot-size and
strike-step lookups for the TypeScript side. It exists so the live trading
engine and the Python backtest engine can never silently disagree about a lot
size — they did, for months: `apps/server` once hard-coded NIFTY's lot size
at 50 while the real reference data said 65, and every paper P&L was ~30% out
the whole time because nothing compared the two.

## Exported utility functions (the whole public API)

From `src/index.ts`:
- `lotSize(underlying, date)` — effective-dated lot size for `'NIFTY' |
  'BANKNIFTY' | 'SENSEX'`.
- `strikeStep(underlying, date)` — effective-dated strike interval.
- Type: `Underlying`.

**Never hard-code a lot size or strike interval anywhere in the TypeScript
codebase.** NSE has changed both within a single year; a number that was
right last quarter is a wrong answer dressed up as a constant. Always call
through this package.

## Cross-package links — the important, non-obvious one

This package does **not** carry its own copy of the reference CSVs. `src/
loader.ts` reads them directly off disk from
`../../option-backtesting/src/option_backtesting/data/reference/` (a relative
filesystem path into the sibling Python package, resolved at runtime via
`import.meta.dirname`) — because `uv` ships those CSVs as package data inside
that package's own wheel, and a second copy here is exactly the drift this
package exists to prevent.

**Practical consequence:** editing `packages/option-backtesting`'s reference
CSVs (`lot_sizes.csv`, `strike_step.csv`, under `data/reference/`) changes
what this package returns immediately, with no code change or version bump
on either side. Always check both packages' tests when touching those files
— see `packages/option-backtesting/CLAUDE.md` for where they live.

Imported by `apps/server` (`src/trading/paper-trade-executor.ts`, `src/
trading/portfolio-risk.ts`) — see that app's `CLAUDE.md`.

## Commands

```bash
bun run typecheck
bun run test         # vitest run — includes a parity test against apps/server's usage
```
