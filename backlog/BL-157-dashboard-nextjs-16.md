# BL-157 — Dashboard on Next.js 16, so the hosted dashboard deploys again

| | |
|---|---|
| **Priority** | P0 — the hosted dashboard cannot deploy at all until this lands; friends see Momentum through it |
| **Status** | Planned |
| **Type** | chore |
| **Area** | dashboard / infra |
| **Created** | 2026-10-24 |
| **Depends on** | none |
| **TODO.md row** | — (filled in when started) |

## Context

The release promotion of 2026-10-22 (PR #299) merged, but its `deploy-dashboard.yml` run failed
before building anything:

```
ERROR Next.js version 15.5.26 is not supported by the Next.js team.
Major versions are supported for 2 years from their release date.
```

The check is `isNextVersionSupported()` in `@opennextjs/aws` (`dist/build/helper.js`, pulled in by
`@opennextjs/cloudflare`): release date of the major plus two years. Next.js 15 came out on
2024-10-21, so every OpenNext build has refused it since 2026-10-21 00:00 UTC (the 22 Oct release
was just the first push to hit it). Nothing in the repo changed; the calendar did. `dashboard.codifie.dev` still serves the 2026-10-18 build, and every later
release will fail the same way. Local `next dev` / `bun run start:prod` are unaffected (the check
is OpenNext's, not Next's).

The owner chose (2026-10-24) to upgrade to Next.js 16 rather than pass OpenNext's
`--dangerouslyUseUnsupportedNextVersion` flag, which would keep the dashboard on a major that no
longer gets security fixes.

What the versions say (npm registry, 2026-10-24):

| Package | Now | Target | Why |
|---|---|---|---|
| `next` | 15.5.26 (`^15.5.0`) | 16.4.x (latest 16.4.3) | Next 16 is supported until 2027-10. Its peer range is `react ^18.2.0 \|\| ^19.0.0`, so React can stay at 18 |
| `@opennextjs/cloudflare` | 1.20.9 | 1.20.13 | Its peer range is `next >=15.5.28 <16 \|\| >=16.4.1`. 1.20.9 already wanted `>=15.5.27`, so the installed 15.5.26 was outside its range |
| `react`, `react-dom`, `@types/react*` | 18.3 | unchanged | Not needed for Next 16; a separate, optional phase |
| Node | CI `ubuntu-latest` (20.x), deploy job 22 | unchanged | Next 16 needs `>=20.9.0` |

What in `apps/dashboard` Next 16 touches:

- **Turbopack is the default** for `next dev` and `next build`. `next.config.ts` has a `webpack()`
  hook (the Guide's `?raw` Markdown imports, BL-041), and Next 16 refuses to build with Turbopack
  while a webpack config is present. Every `next build` / `next dev` caller needs `--webpack`, or
  the rule moves to `turbopack.rules`. Callers: `package.json` `dev` / `build` (OpenNext runs the
  package's `build` script; CI's Dashboard job runs it too), and `scripts/dev-stack.mjs`
  (`next dev`, and `next build` for `start:prod`). `next start` has no `--webpack` option, and
  dev-stack builds the `dev` and `start` calls from one argument list, so the flag goes on the
  `dev` branch only.
- **`middleware.ts` is deprecated in favour of `proxy.ts`**, which runs on the Node.js runtime
  only. `middleware.ts` keeps working on the edge runtime in 16. The login gate, the Access-token
  check and the upstream service-token injection all live there (`docs/remote-dashboard.md`), and
  whether OpenNext's Cloudflare adapter runs a Node `proxy.ts` has not been checked. So the file
  stays `middleware.ts` in this item's first phases.
- **Async request APIs only.** Already done: `[[...slug]]/page.tsx` awaits `params` and
  `login/page.tsx` awaits `searchParams`. Nothing calls `cookies()` / `headers()`.
- **`experimental.proxyTimeout`** (180 s for long Momentum runs): still accepted by 16.4.3. It
  applies to Next's own Node server (`next dev`, `next start`), not to the OpenNext Worker, so
  it is checked locally, not on `wrangler dev`.
- **`next dev` writes to `.next/dev`** in 16, so a running dev server no longer clobbers a
  production build. `cf-build.mjs`'s refusal while `next dev` runs and `start:prod`'s separate
  `.next-prod` folder may no longer be needed. Left as they are here; noted for later.
- Not used, so unaffected: AMP, `next/legacy/image`, `next lint` (the repo uses Biome),
  `images.*` options.

## Goal

`bun run cf:deploy` (and the `release` push that runs it) builds and deploys
`dashboard.codifie.dev` on Next.js 16 without the unsupported-version flag, with every screen,
the login gate and the API rewrites behaving as before.

## Out of scope

- React 19 (Phase 3, only if wanted).
- Renaming `middleware.ts` to `proxy.ts` (Phase 3, only once OpenNext's support is confirmed).
- Turbopack builds, the Cache Components model, and removing the `.next-prod` / dev-server
  workarounds.
- Any UI change.

## Plan

### Phase 1 — Next 16 builds locally and in CI
- **Tasks:**
  1. In a worktree: `next@^16.4.1` and `@opennextjs/cloudflare@^1.20.13` in
     `apps/dashboard/package.json`; `bun install` (the root `bun.lock` changes); check that
     `wrangler` still meets OpenNext's `^4.148.0`.
  2. Add `--webpack` to the `dev` and `build` scripts, and in `scripts/dev-stack.mjs` to the
     `dev` branch of the dashboard's argument list (not `start`) and to its `next build` call.
     Keep the `?raw` webpack rule.
  3. Run `next build --webpack` and read every warning: config keys, the middleware deprecation
     notice, and what Next writes into `tsconfig.json` / `next-env.d.ts`. In 16, `next dev` also
     writes types under `.next/dev/types`, rewrites `next-env.d.ts` (dev-stack restores it only
     after a build) and adds `.next/dev/types/**/*.ts` to `tsconfig.json`. Commit the tsconfig
     changes Next needs; keep the tracked `next-env.d.ts` as dev-stack expects.
  4. `bun run --filter @ata/dashboard typecheck` and `test` (Vitest, the Tailwind class test
     included). Then the Playwright e2e suite (not in CI): against `bun run start` with
     `BASE_URL=http://127.0.0.1:5190` (Playwright's default is `localhost:5173`, the `dev`
     script's port).
  5. The proxy timeout: a Broad Momentum run longer than 30 s completes through the dashboard
     under both `bun run start` (`next dev`) and `bun run start:prod` (`next start`).
- **Deliverables:** one PR with the bumps, the lockfile and the script changes; the build log's
  warnings and how each was handled in the PR description.
- **Done when:** CI's four required jobs are green, `next build --webpack` prints no error, the
  e2e suite passes except `e2e/personalities-api.spec.ts` (it fails by design without
  `apps/server`), and task 5's long run completes.

### Phase 2 — Deploy check before it reaches `release`
- **Tasks:**
  1. `bun run cf:build` locally: the version check passes, and `cf-build.mjs`'s check that no env
     value was bundled still passes.
  2. `bun run cf:preview` (wrangler dev on :8787) with the build-time env the deploy job sets
     (`MOMENTUM_DIRECT=1`, `OBT_DIRECT=1`, the tunnel URLs). Check by hand:
     - `/login`: a wrong password counts towards the lock-out, the right one sets the cookie
       and redirects to `next`, `/logout` clears it;
     - Basic auth on `/api/*` and the 503 for a missing `DASHBOARD_PASSWORD`;
     - Access mode if `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` are set;
     - a Momentum page and an Options Lab page load through the rewrites, with the service
       token added upstream (a plain Workers check; the proxy timeout was Phase 1's).
  3. Merge the Phase 1 PR into `main`, then the usual `main` → `release` promotion PR. Watch
     `deploy-dashboard.yml` and open the live site.
- **Deliverables:** the preview checks recorded in this item's Log; a green deploy run.
- **Done when:** `dashboard.codifie.dev` serves the new build (the page source names Next 16)
  and the login gate works there.

### Phase 3 — Optional follow-ups (each its own PR, only if the owner wants it)
- **React 19:** `react`, `react-dom`, `@types/react*` to 19; fix what typecheck finds (`useRef`
  needs an argument, the global `JSX` namespace becomes `React.JSX`, no `defaultProps` on function
  components); check Radix, `react-markdown`, `zustand` and `lucide-react` against 19.
- **`proxy.ts`:** only if OpenNext's Cloudflare adapter runs a Node.js proxy; otherwise keep
  `middleware.ts` until Next removes it, and record that here.
- **Turbopack:** move the `?raw` rule to `turbopack.rules`, drop `--webpack`, compare build time.

## Risks

- **OpenNext and Next 16 edge middleware.** If the adapter mishandles the deprecated
  `middleware.ts`, the login gate could fail open or closed. Phase 2's preview checks are there to
  catch that before `release`; a failure blocks the promotion, nothing reaches the live site.
- **A deploy that half-works.** The Worker bundle could build while a rewrite or a header
  behaves differently on Workers (`docs/remote-dashboard.md` already notes that deleted headers
  still reach rewrite targets). Same mitigation: Phase 2 runs on `wrangler dev` first.
- **The lockfile under bun 1.2 vs 1.3** (hoisting differs). Install and test with CI's 1.2.x too
  before merging.
- **Next 15.5 backports keep coming** (`backport` tag 15.5.28), but OpenNext's check is by major
  and date, so a 15.5 patch does not help.
- Until this lands, every `release` promotion fails at the deploy step. That is harmless (the live
  site stays on the 18 Oct build), but nothing new reaches it.

## Open questions

- Should Phase 3's React 19 bump follow straight after, or wait?
- Is `cf:preview` against the real tunnel hostnames fine to run from the laptop (it needs the
  Access service token in the shell), or should Phase 2 use the local APIs?

## Log

- 2026-10-24 — created after the 2026-10-22 `release` deploy failed on OpenNext's Next.js support
  check. The owner chose the Next 16 upgrade over the unsupported-version flag. Nothing built or
  run yet.
- 2026-10-24 — review (#305) fixes: the proxy-timeout check moved to Phase 1 (it applies to Next's
  Node server, not the Worker); the e2e step names its address and the spec that fails by design;
  `--webpack` goes on dev-stack's `dev` branch only; the cut-off is 2026-10-21; Next 16's
  `.next/dev/types` and `next-env.d.ts` rewrites named.
