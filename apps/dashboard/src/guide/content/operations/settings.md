## What it is for

Personal preferences for this browser, what the daily automation does on AlgoTest and Quantiply, and which Telegram messages are sent.

## The sections

| Section | What you can set |
|---|---|
| Appearance | Light or dark theme, and density (how compact tables and cards are). |
| Defaults | The landing tab, the Momentum dataset that opens first, and the default backtest period. |
| Navigation | Show, hide and reorder sidebar tabs. Settings and this Guide cannot be hidden. |
| Browser alerts | A warning in the dashboard before the Fyers token expires. |
| Automation | What the daily jobs do (below). |
| Telegram alerts | One switch per message type: broker logins, the momentum preview/final/journal, live-money rules status and problems, the options evening summary and problems, the morning summary, the weekly digest and the backup. Scheduler failures and missed runs always send. |
| Account | The dashboard is protected by a single shared password when it runs on your own computer in production mode (`bun run start:prod`); when it is hosted behind Cloudflare Access, signing in is a Google sign-in or an emailed code instead. In local dev mode there is no sign-in. **Log out** ends your session. |
| About | What the dashboard is connected to. **Developer mode** shows each screen's list of unfinished work next to its title. |

> [!TIP]
> If you never use the paused Live screens, hide them under Navigation to keep the sidebar short.

## Automation

Three master switches, then one block per platform and broker.

**Master switches.** Turning one off stops that kind of automation everywhere, whatever the blocks below say:

- **Automated logins:** the 08:00 broker logins and their 08:15 GitHub backstop.
- **Automated uploads:** the evening and 09:16 top-up uploads.
- **Automated deployment:** deploying the uploaded strategies. Deploying also stays off until its `.env` switch is on.

**Blocks.** There are four: AlgoTest · Shoonya, AlgoTest · Angel One, Quantiply · Angel One and Quantiply · Shoonya. Each has:

- **Log in at 08:00:** this broker is logged in on this platform.
- **List:** which picks this platform gets, if any:
  - **Adaptive Classic** is the live Core list;
  - **Adaptive Tuned** is the T1 list.
- **Upload the list's picks:** the evening job puts tomorrow's picks there, and the 09:16 top-up adds any that changed. It needs a list.

A warning badge on a block means its master switch holds it back.

**Saving.** Your edits are a draft until **Save**. The changes are listed above the button, and **Discard changes** puts the saved settings back. Each save:

- becomes a new version, listed under **History**;
- updates the GitHub variables that the 08:15 backstop reads. If that update fails, the page says so in red; the saved version still stands.

**When a change takes effect.** From each job's next run. The evening uploads run at 16:40 (AlgoTest) and 16:45 (Quantiply), so a change saved later than that reaches tomorrow's picks only at the next evening run.

**The `.env` switches still have the last word.** `ALGOTEST_UPLOAD`, `QUANTIPLY_UPLOAD` and `ALGOTEST_DEPLOY` must also be on for the tool to change a platform.

> [!NOTE]
> Built in stages. For now the page stores the settings and updates GitHub. The jobs start following them in a later stage: until then they run as before.

## Common questions

**Are these settings shared?** Appearance, defaults and navigation are stored in this browser
only. Telegram alert switches and the Automation settings are stored on the laptop and apply to everyone.
