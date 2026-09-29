# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working in this package.

## What this package does

`@trading/notify` is outbound Telegram notifications plus the never-emit
secret registry, shared across every Node/Bun workspace. Both live together
deliberately: the failure this package exists to prevent is "a credential
left the process," and log masking (`registerSecret`) and message redaction
(`redact`) are the same registry seen from two sides.

## Exported utility functions (the whole public API)

From `src/index.ts`:
- `send(notification)` / `sendText(text, …)` — `send` takes the structured
  `Notification` shape; `sendText` is for a caller that builds its own layout.
  Never call the Telegram API directly — this is the only place that does,
  and it deliberately never sets `parse_mode` (broker names break Telegram's
  Markdown parser and Telegram then drops the whole message silently).
  Buttons must use `callback_data`, never a URL — Telegram pre-fetches link
  previews, which would fire before anyone taps it.
- `istTimestamp()` — the one IST-formatted timestamp helper for notification
  bodies.
- `registerSecret(value)` — adds a value to the redaction registry (used for
  masking GitHub Actions logs too, not just Telegram messages).
- `redact(text)` — strips every registered secret from a string before it's
  logged or sent anywhere.
- Types: `Action`, `Notification`, `Severity`, `TelegramConfig`.

## Cross-package links

- Imported by `packages/broker-identity` and `packages/broker-login`
  (Node/Bun workspaces only).
- `packages/contract-notes` is Node 20 + CommonJS and does **not** import
  this ESM package — it reimplements ~40 lines against the same
  `Notification` shape instead. See that package's `CLAUDE.md`.
- Python callers (`packages/momentum-backtesting`, `packages/option-backtesting`)
  do not import this either — they mirror the `Notification` shape in Python.
  The boundary is the contract (the shape), not a shared service: `broker-login`
  runs in GitHub Actions while `apps/server` runs on Railway, so routing every
  alert through one service would mean losing the alert that says that service
  is down.

## Commands

```bash
bun run typecheck    # tsc --noEmit — no dedicated test script; exercised via its importers' own tests
```
