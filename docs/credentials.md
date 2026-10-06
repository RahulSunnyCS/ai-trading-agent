# Credentials

Every credential this repo depends on, where it lives and how to rotate it. **This file
holds no values**, only names and places. Never paste a secret here, into a commit, or
into a chat. The scheduler reminds you to rotate all of them each 1 January
(`credential-rotation-reminder`), and checks daily that `gh` is logged in (`gh-auth-check`).

After rotating any of them, confirm the thing that uses it still works (the "Check" column).

| Credential | Lives in | Used by | Rotate | Check |
|---|---|---|---|---|
| AlgoTest password (`ALGOTEST_PASSWORD`, `ALGOTEST_PHONE`) | GitHub Actions secrets of this repo | `packages/broker-login` daily AlgoTest login | Change it on AlgoTest, then `gh secret set ALGOTEST_PASSWORD` | Trigger the broker-login workflow, or wait for the 08:00 IST run |
| Angel One password / MPIN and TOTP secret (`ANGELONE_MPIN`, `ANGELONE_CLIENT_CODE`, `ANGELONE_TOTP_SECRET`; live feed: `ANGEL_ONE_PASSWORD`, `ANGEL_ONE_TOTP_SECRET`, `ANGEL_ONE_API_KEY`) | GitHub Actions secrets (login job); repo `.env` (live feed) | `packages/broker-login`; `apps/server` Angel One adapter | Reset the MPIN in the Angel One app; to rotate the TOTP secret, re-enrol 2FA and copy the new base32 secret. Update both places | Broker-login run succeeds; `bun run jobs status` shows no failed login |
| Finvasia (Shoonya) password and TOTP secret (`SHOONYA_CLIENT_ID`, `SHOONYA_PASSWORD`, `SHOONYA_TOTP_SECRET`) | GitHub Actions secrets | `packages/broker-login` | Change the password in Finvasia's portal; re-enrol TOTP for a new secret; `gh secret set` each. The names keep the old "SHOONYA" spelling on purpose | Broker-login run succeeds |
| Gmail app password | `packages/contract-notes` environment (`.env` / its CI secrets) | Contract-note emails over IMAP | Google Account > Security > App passwords: revoke the old one, create a new one, update the setting | Run the contract-notes job once |
| Google service-account key (`GOOGLE_CREDENTIALS`, plus `GOOGLE_SHEET_ID`) | GitHub Actions secrets; local key file if used | `packages/contract-notes` Sheets writes | Google Cloud console > IAM > Service accounts > Keys: create a new JSON key, update the secret, delete the old key | Contract-notes run updates the sheet |
| Telegram bot token (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`) | Repo `.env`; GitHub Actions secrets | `@trading/notify`, scheduler alerts | In Telegram, message @BotFather: `/revoke` then use the new token; update `.env` and `gh secret set TELEGRAM_BOT_TOKEN` | `bun run jobs run morning-summary` delivers a message |
| Cloudflare Access service token (`UPSTREAM_ACCESS_CLIENT_ID`, `UPSTREAM_ACCESS_CLIENT_SECRET`) | Dashboard host environment | Dashboard to the tunnelled research APIs | Cloudflare Zero Trust > Access > Service Auth: create a new token, update both variables together (setting only one makes every request 503), delete the old token. See `docs/remote-dashboard.md` | Dashboard loads Momentum and Options Lab data |
| `FYERS_APP_SECRET` | Repo `.env`; GitHub Actions secrets for the headless Fyers login | Fyers OAuth **and** the encryption passphrase for `broker_tokens` | Regenerate in the Fyers API dashboard. **It also encrypts `broker_tokens`, so rows written under the old secret become unreadable**: rotate, then log in to Fyers again so the token is re-stored | `uv run mbt token-status` shows a valid token |
| `gh` CLI login | `gh` keychain on the scheduler laptop | Dispatching the AlgoTest login workflow | `gh auth login` | `gh auth status`; the `gh-auth-check` job checks it daily |

## Rotation routine

1. Rotate at the provider first, then update every place in the table.
2. Never write the value to a file in the repo; use `gh secret set NAME` (it prompts) and your `.env`.
3. Run the "Check" for that row.
4. The yearly reminder fires once, on 1 January; nothing else is needed until the next one.
