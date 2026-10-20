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

**Apply now.** **Apply now: AlgoTest** and **Apply now: Quantiply** run that platform's evening upload straight away, with the saved settings. Use them after a change saved later than the evening run. They are disabled while there are unsaved changes.

**What follows these settings:**

- **The 08:00 login:**
  - With logins off, or no block logging in, the laptop does not start the login run, and the 08:15 GitHub backstop does nothing.
  - With neither AlgoTest block on, the run skips the AlgoTest brokers.
  - Quantiply · Shoonya logs in after the AlgoTest logins, when its block is on.
- **The evening and 09:16 uploads:** AlgoTest gets every list its blocks choose. Each Quantiply account (Angel One, Shoonya) gets its own block's list. A block with upload off is left untouched.
- **Deploying:** it also needs Automated deployment on.
  - AlgoTest deploys the day's T1 picks after 09:16.
  - Quantiply switches on each account's picks at 16:55 for the next day, and at 09:21 any that changed. It only does this for an account whose block uploads a list.
  - At 15:40 the tool's Quantiply algos are switched off again; otherwise they would run on the same weekday next week. This always runs, even with Automated deployment or `QUANTIPLY_DEPLOY` off.
  - Switching an algo off by hand after the tool switched it on is final for that day: the 09:21 run does not switch it back on.

**The `.env` switches still have the last word.** `ALGOTEST_UPLOAD`, `QUANTIPLY_UPLOAD`, `ALGOTEST_DEPLOY` and `QUANTIPLY_DEPLOY` must also be on for the tool to change a platform. The one exception is switching the tool's Quantiply algos off at 15:40, which always runs.

## The stop button (Telegram)

One Telegram button that stops everything the tool trades for the rest of the day. It is not on this page: it lives in your private Telegram chat with the bot, so it works from your phone.

**Where it appears.** Under the 09:00 morning message, and whenever you send `/stop` to the bot.

**Two taps, nothing on the first.**

1. **🛑 Stop everything** only shows what a stop would do now, platform by platform, read from the tool's own records. Nothing changes.
2. **Yes, stop and square off** does it. This button works once, and only for 2 minutes. After that, send `/stop` again.

**What the second tap does:**

- **Holds today.** Until midnight, the tool uploads, deploys and switches on nothing, on AlgoTest or Quantiply. The jobs that would do so are paused. The 15:40 Quantiply switch-off still runs.
- **Quantiply (each account):** the tool's algos with a trade open are squared off and terminated by Quantiply itself. Every enabled algo of the tool's is switched off, whatever its weekday.
- **AlgoTest:** every running deploy named `T1 · …` or `Core · …` is squared off with AlgoTest's own Square Off, whoever deployed it.
- **Reports back** in the same chat, one section per platform, once each platform shows the result.

Your own algos and deploys are never touched; the report names any that are still running.

> [!WARNING]
> The square-off sends real exit orders through the platforms. If a platform offers no square-off for something (a paused AlgoTest deploy, for example), the report says **square off by hand**. Do that in the platform or your broker's app straight away. The tool never places an order with a broker itself.

**When it does not answer.** The button is answered by the laptop's scheduler. While the laptop sleeps or is off, nothing happens: stop by hand in Quantiply and on algotest.in/live. It is also off until `STOP_BUTTON=on` is in the laptop's `.env`.

**After a stop.** The hold ends at midnight. But this evening's uploads and switch-ons were held as well, so tomorrow's picks are not set up the evening before. The 09:18–09:21 jobs add what they can, which is too late for a 09:17 entry. Set up by hand what you want to trade tomorrow. Or lift the hold the same evening on the laptop and run the held jobs by hand: a held job does not run again by itself.

## Common questions

**Are these settings shared?** Appearance, defaults and navigation are stored in this browser
only. Telegram alert switches and the Automation settings are stored on the laptop and apply to everyone.
