# ARCHITECTURE REVIEW REPORT
━━━━━━━━━━━━━━━━━━━━━━━━━━

Verdict: CONDITIONAL PASS

Reviewed files:
- src/frontend/lib/api.ts
- src/frontend/lib/format.ts
- src/frontend/lib/pnl.ts
- src/frontend/types/trading.ts
- src/frontend/hooks/useLiveTicks.ts
- src/frontend/hooks/usePaperTrades.ts
- src/frontend/components/LiveView.tsx
- src/frontend/components/TradesView.tsx
- src/frontend/components/PnlView.tsx

---

## FINDINGS

---

FINDING: CumulativeChart destroys and rebuilds on every poll cycle
Severity: Medium
File or area: src/frontend/components/PnlView.tsx — CumulativeChart, line 248
What it is: `CumulativeChart` receives `series` (a `PnlSeriesPoint[]`) as a prop and
  its `useEffect` depends on `[series]`. `computePnlSummary` is called unconditionally
  on every render of `PnlView` and always returns a freshly-allocated array for
  `cumulativeSeries` (even when the underlying trade data has not changed). Because
  `usePaperTrades` updates its state on every successful poll — including polls that
  return the same logical data — `PnlView` re-renders every ~10 seconds, receives a
  new array reference each time, and the `[series]` dependency fires. The result is
  that the Lightweight Charts instance is fully torn down (`chart.remove()`,
  `observer.disconnect()`) and rebuilt from scratch on each polling cycle, even when
  the data is identical to the previous cycle. There is no `useMemo` guard on
  `computePnlSummary` or `React.memo` on `CumulativeChart`.
Why it matters: Every rebuild flushes the user's scroll/zoom state on the chart and
  produces a visible flash (chart disappears for one paint frame). At a 10-second poll
  interval with a full trading day's worth of closed trades this is a steady rhythm of
  visual disruption. It also does unnecessary DOM work — creating and removing a
  ResizeObserver and a canvas-backed chart every 10 seconds.
Recommendation: Memoize the series array so the reference only changes when the
  underlying data actually changes:

    const summary = useMemo(() => computePnlSummary(trades), [trades]);

  Then wrap `CumulativeChart` in `React.memo` so it only re-renders when the series
  reference changes. Alternatively, keep the `useEffect([series])` approach but
  replace the full teardown/rebuild with a `lineSeries.setData(series)` call inside
  the series-update effect, and keep the chart creation in a separate `[]` effect —
  the same pattern used by `TickChart` in `LiveView.tsx`.

---

FINDING: "Single source of truth" hook creates duplicate polling when both tabs are ever simultaneously mounted
Severity: Low
File or area: src/frontend/hooks/usePaperTrades.ts, src/frontend/components/TradesView.tsx:263, src/frontend/components/PnlView.tsx:277
What it is: Both `TradesView` and `PnlView` call `usePaperTrades()` independently.
  Each call creates its own state, its own `AbortController`, and its own `setInterval`.
  The code comments claim this is a "single source of truth" pattern, but React hooks
  are per-instance — each call site is a separate polling loop. Because `App.tsx` uses
  exclusive conditional rendering (`activeTab === 'trades' && ...`), only one tab is
  mounted at a time, so in practice today there is only one active interval at a time.
  However, the architectural claim in the hook's doc-comment ("Single source of truth:
  both TradesView and PnlView import this hook — no duplicate fetch logic") is
  misleading and would produce double polling if a future layout ever mounts both
  simultaneously (e.g., a split-panel view or a context-provided state wrapper).
Why it matters: The current exclusive-render behaviour saves this from being a real
  bug today, but the misleading comment creates a trap for the next developer who
  changes the layout. If both components are ever rendered at the same time, there
  will be two independent 10-second polling intervals hitting `/api/trades`.
Recommendation: Either (a) note in the hook's doc-comment that "single source of
  truth" means single fetch-logic definition, not shared state — and that shared-state
  requires lifting to a React context or Zustand slice; or (b) if shared state across
  tabs is ever needed, move the polling to a Zustand store or a React context at the
  `App` level. For current usage, a clarifying comment is sufficient.

---

FINDING: React.ReactNode used as a namespace type without importing React
Severity: Low
File or area: src/frontend/components/TradesView.tsx line 185
What it is: The `Th` helper component annotates its `children` prop as
  `{ children: React.ReactNode }`. With the new JSX transform (`react-jsx` in
  tsconfig.json), `React` is not automatically in scope — the JSX runtime is injected
  separately from `react/jsx-runtime` but the `React` namespace object is not. To use
  `React.ReactNode` as a type you must either `import React from 'react'` or write
  `import type { ReactNode } from 'react'` and use `ReactNode` directly. This currently
  escapes detection because `tsconfig.json` excludes `src/frontend/**/*` from the
  standard typecheck path, so `bun run typecheck` never sees this file. In an
  environment where the frontend is type-checked, this would be a compile error under
  strict mode.
Why it matters: Low severity because (a) Vite's bundler resolves it at runtime through
  the React package's ambient declarations, and (b) it is currently invisible to `tsc`.
  If the tsconfig exclusion is ever lifted (see finding below), this becomes a
  compile error that blocks the build.
Recommendation: Replace with `import type { ReactNode } from 'react'` at the top of
  the file and change the annotation to `{ children: ReactNode }`. This is consistent
  with how every other component in the file avoids the `React.*` namespace.

---

FINDING: Frontend code excluded from standard typecheck — no automated type safety gate
Severity: Low
File or area: tsconfig.json line (exclude block) — src/frontend/**/* and src/payment/**/*
What it is: The root `tsconfig.json` explicitly excludes `src/frontend/**/*` from the
  TypeScript compilation unit. `bun run typecheck` therefore never type-checks any
  frontend file. A manual `tsc` invocation (with `--jsx react-jsx` flags, or a
  separate `tsconfig.frontend.json`) is required to get type coverage. The task brief
  notes a one-off manual pass was done and passes (with the caveat above about
  `React.ReactNode`). There is no automated CI step that enforces this.
Why it matters: Every future PR that modifies frontend files can introduce type errors
  that go undetected until runtime or manual testing. The exclusion appears to have
  been a convenience workaround (the backend and frontend share one tsconfig but use
  different module-resolution contexts); it creates a permanent blind spot in the type
  safety gate.
Recommendation: Add a `tsconfig.frontend.json` at the repo root (or in
  `src/frontend/`) that extends the root config, replaces the `exclude` block with one
  that only excludes `src/**` (backend files), and sets `"jsx": "react-jsx"` and
  `"moduleResolution": "bundler"`. Add a `typecheck:frontend` script to `package.json`
  and invoke it alongside `typecheck` in the CI / pre-push hook. This is a two-file
  change and a one-line script addition — low cost, high ongoing value.

---

FINDING: Stale biome ignore entry references a deleted path
Severity: Low
File or area: biome.json line 29
What it is: `biome.json` contains `"frontend/node_modules"` in the `files.ignore`
  array. This path was a reference to the old stale duplicate frontend tree that this
  branch deleted. The path `frontend/node_modules` no longer exists and was never
  under `src/frontend/`. The ignore entry is a no-op but it is confusing to readers
  who wonder what `frontend/node_modules` refers to.
Why it matters: Purely cosmetic / future-confusion risk. No functional impact.
Recommendation: Remove `"frontend/node_modules"` from `biome.json`'s `files.ignore`
  array. The only relevant ignores for the frontend are already covered by the
  top-level `"node_modules"` entry.

---

FINDING: App.tsx uses extensionless component imports inconsistent with rest of codebase
Severity: Low
File or area: src/frontend/App.tsx lines 3-7
What it is: `App.tsx` imports from `'./components/LiveView'` (no `.js` extension),
  while all hooks and lib files use explicit `.js` extensions in their imports
  (e.g. `'../lib/api.js'`, `'../types/trading.js'`). The `.js` convention in
  TypeScript-ESM codebases signals that the file resolves to a compiled JS output and
  is the explicit-extensions convention required by `moduleResolution: "bundler"` for
  non-bundled contexts. For Vite specifically, both forms resolve correctly, so this
  is not a runtime bug. However, it is inconsistent with the rest of `src/frontend/`
  and introduces confusion about the project's import convention.
Why it matters: Low risk — Vite handles both forms. Becomes relevant if the frontend
  is ever run outside Vite (e.g., with Node's native ESM loader or for SSR).
Recommendation: Standardise on `.js` extensions in all frontend imports, or
  document in `CLAUDE.md` that Vite-bundled files may omit the extension. Given that
  the existing hooks and lib files already consistently use `.js`, extending that
  pattern to `App.tsx` is the lower-friction choice.

---

## POSITIVE OBSERVATIONS

The following patterns are architecturally sound and worth preserving:

- `useLiveTicks` StrictMode cleanup (detaching `onclose` before `close()`) is correctly
  implemented and prevents the classic double-mount reconnect storm.
- `inFlightRef` in `usePaperTrades` prevents overlapping requests and survives the
  StrictMode mount/unmount/remount cycle cleanly (the ref is reset to false before the
  AbortError early-return, so the second mount starts with a clean state).
- `apiGet<T>` discriminated-union result type forces callers to handle the error path
  explicitly — the AbortError vs genuine-error distinction is correct.
- `PnlSeriesPoint.time` is in YYYY-MM-DD (IST) rather than UTCTimestamp seconds,
  avoiding the ms/s conversion bug common with Lightweight Charts. The tradeoff
  (multiple same-day trades sharing a time key, last-write-wins) is documented.
- `TickChart` deduplicates by second before calling `setData` — correctly prevents the
  Lightweight Charts duplicate-time-key throw.
- `computePnlSummary` is pure, has no React dependency, and is well-tested with IST
  boundary cases. The null-skip-not-zero convention for missing P&L fields is the right
  default for a trading tool.
- The `[key: string]: unknown` index on `PaperTrade` allows forward-compatible
  extension without breaking existing consumers — correct use of TypeScript's index
  signature for an evolving API contract.

---

## SUMMARY

High  : 0
Medium: 1
Low   : 5

The single medium finding (CumulativeChart rebuild cycle) is a React performance issue
that produces a visible user-facing artifact (chart flash every 10 seconds) and should
be fixed. All low findings are either cleanup items or preventive hygiene. The code is
structurally well-organised: separation between hooks, lib, types, and components is
clean; the usePaperTrades hook is a well-scoped data-fetching boundary; and the
Lightweight Charts lifecycle management is correctly implemented in the new components.
The conditional pass is based on the medium finding.
