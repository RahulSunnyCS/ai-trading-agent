# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working in this package.

## What this package does

`@trading/broker-identity` is the canonical `BrokerId` type and the one RFC
6238 TOTP implementation in the repo. It exists so a broker identifier and a
TOTP generator are each defined exactly once — before this package existed,
`apps/server` depended on `otplib` for its own TOTP generation and
`packages/broker-login` used `shoonya` as an internal key for what is
actually Finvasia (Shoonya was Finvasia's old product name).

## Exported utility functions (the whole public API)

From `src/index.ts`:
- `generateTotp(secret)` — RFC 6238, SHA-1 / 30s / 6-digit. **The** TOTP
  generator for this repo — never add a second one.
- `freshTotp(secret)` / `waitForNextWindow()` — used by callers that need a
  guaranteed-fresh code (e.g. retry-on-stale-code flows), not just the
  current window's code.
- Type: `BrokerId = 'angelone' | 'finvasia'` — the canonical broker
  identifier. Note it's `'finvasia'`, not `'shoonya'` — see the root
  `technical.md`'s Key Patterns section for why that rename happened and
  which already-configured env vars deliberately were **not** renamed to
  match.

## Cross-package links

- Depends on `@trading/notify` (`src/totp.ts`) — for redacting the secret
  itself out of any error path, consistent with that package's never-emit
  registry.
- Imported by `apps/server` (`src/ingestion/brokers/angelone.ts`, live Angel
  One WebSocket auth) and `packages/broker-login` (Playwright AlgoTest
  automation, which also uses `freshTotp`/`waitForNextWindow` for its
  retry-on-stale-code flow) — see both packages' own `CLAUDE.md`.

## Commands

```bash
bun run typecheck
bun run test    # vitest run — RFC 6238 test vectors
```
