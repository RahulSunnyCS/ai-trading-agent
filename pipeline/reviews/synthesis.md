# Phase 4 — Synthesis Review Report

**Reviewers run:** architecture-reviewer (frontend lens). Security-auditor and
performance-reviewer NOT run — gating: LOW risk, feature-fast, no auth/PII/payment
risk_flags (payment code untouched). This matches the Phase-4 gate (LOW → architecture only).

**Synthesised verdict: CONDITIONAL PASS**
Counts: 🔴 Critical 0 · 🟡 Medium 1 · 🟢 Low 5

## Medium (the condition)
- **M1 — CumulativeChart rebuilds every 10s poll** (`PnlView.tsx` ~line 248).
  `computePnlSummary` runs each render returning a fresh array; the chart effect
  depends on that reference, so every poll tears down + rebuilds the chart →
  visible flash + lost zoom/scroll each cycle. Fix: `useMemo` the summary on
  `[trades]` and split chart create (`[]`) from `setData` (`[series]`), mirroring
  the correct `TickChart` pattern in LiveView.

## Low
- **L1** — `usePaperTrades` "single source of truth" doc comment is a half-truth
  (per-instance state; safe only because App.tsx renders tabs exclusively). Clarify comment.
- **L2** — `TradesView.tsx:185` uses `React.ReactNode` without importing React.
  NOTE: one-off frontend tsc passed clean (@types/react exposes `React` as a global
  namespace), so this is a style nit, not a current error. Prefer `import type { ReactNode }`.
- **L3** — Frontend excluded from `bun run typecheck` (`tsconfig.json`). No CI type gate
  for frontend. Recommend a `tsconfig.frontend.json` + `typecheck:frontend` script.
  (Touches config/package.json — beyond strict frontend-only literal scope; offer as opt-in.)
- **L4** — Stale `biome.json` `"frontend/node_modules"` ignore entry left after T-05 deletion. One-line removal.
- **L5** — `App.tsx` imports omit `.js` extension while the rest of the tree uses it. Cosmetic; Vite resolves both.

## Positives preserved
StrictMode-safe WS cleanup (detach onclose before close); abort-safe in-flight guard;
discriminated ApiResult separating AbortError from real failures; tick dedup-by-second
before setData; pure, tested `computePnlSummary` with null-skip convention.

## Conflicts between reviewers
None — single reviewer run.

Full report: pipeline/reviews/architecture-report.md
