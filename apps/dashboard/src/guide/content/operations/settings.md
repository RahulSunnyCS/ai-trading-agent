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
| Telegram alerts | One switch per message type: broker logins, the momentum preview/final/journal, live-money rules status and problems, the options evening summary and problems, the morning summary, the trade monitor's margin check, deploy check and loss warning, the weekly digest and the backup. Scheduler failures, missed runs and the -₹8,000 loss alert always send. |
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
- **Multiplier:** a whole number from 1 to 10 (1 unless you set it): the platform multiplier the strategies would run at. **Saved only for now:** uploads and deploys do not use it yet.
- **Include the Buy add-on:** whether the Buy add-on picks go with the list. **Saved only for now:** uploads and deploys do not use it yet.

A warning badge on a block means its master switch holds it back.

**Pause uploads and deploys.** Below the blocks, pick a day, or press **Skip next session**, to stop every upload, top-up and deploy for each session up to and including that day. **Clear pause** removes it.

- The evening jobs prepare the next trading session; the 09:16–09:21 top-ups and deploys are for today. A pause through Monday therefore also holds Friday's evening jobs.
- Logins, the picks, the results, the live capture and the checks carry on, and the 09:00 morning message says a pause is on.
- A pause removes nothing already uploaded or enabled. The Telegram stop button squares off, and the 15:40 Quantiply switch-off still runs.
- If the saved settings cannot be read, the upload and deploy jobs hold and say so, rather than assume there is no pause.

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

One Telegram button that stops everything the tool trades, and keeps it stopped until you say so. It is not on this page: it lives in your private Telegram chat with the bot, so it works from your phone.

**Where it appears.** Under the 09:00 morning message, and whenever you send `/stop` to the bot.

**Two taps, nothing on the first.**

1. **🛑 Stop everything** only shows what a stop would do now, platform by platform, read from the tool's own records. Nothing changes. Tapping it twice shows the same confirm button again.
2. **Yes, stop and square off** does it. This button works once, and only for 2 minutes. After that, send `/stop` again.

**What the second tap does:**

- **Holds the tool, until you lift it.** From then on the tool uploads, deploys and switches on nothing, on AlgoTest or Quantiply, on any day. The jobs that would do so are refused, including **Apply now** on this page. The 15:40 Quantiply switch-off still runs. If the hold cannot be saved (the data disk unplugged, say), the stop still squares off and switches off, but says **HOLD NOT SAVED** first: the tool could then upload or switch on again after the laptop's scheduler restarts, so stop the scheduler or fix the disk.
- **Quantiply (each account):** the tool's algos with a trade open are squared off and terminated by Quantiply itself. Every enabled algo of the tool's is switched off, whatever its weekday. An algo that enters while this happens is squared off on a second pass.
- **AlgoTest:** every running deploy of the tool's (a strategy it uploaded, or one named `T1 · …` or `Core · …`) is squared off with AlgoTest's own Square Off, whoever deployed it. A deploy that went live meanwhile is squared off on a second pass.
- **Reports back** in the same chat, one section per platform, once each platform shows the result. If the report cannot be sent, a short message says so.

Your own algos and deploys are never touched; the report names any that are still running.

> [!WARNING]
> The square-off sends real exit orders through the platforms. If a platform offers no square-off for something (a paused AlgoTest deploy, for example), the report says **square off by hand**: do that in the platform or your broker's app straight away. If it says **square-off sent, still closing**, or names a square-off **already sent**, do **not** exit at the broker: the platform's own exit orders are going out, and a second exit would open a reverse position. Open the platform and look first. **Square-off may have been sent (no answer)** means the platform did not answer the call: it may have acted anyway. Open it first, and exit at the broker only if it shows no exit pending. A second stop never sends a square-off again that an earlier stop that day already sent, and a stop cannot start while another is still running. A deploy someone switched to manual is reported **check**: its legs may still be open at the broker. The tool never places an order with a broker itself.

**While the hold is on.** The 09:00 message says so every day, with a **Resume** button. Send `/resume` at any time for the same.

**Lifting it.** Tap **Resume**, then **Yes, lift the hold** (again once, for 2 minutes). Uploads, enables and deploys run again from each job's next run. A job the hold refused does not run again by itself: run any you need by hand. Algos the stop switched off stay off; switch on by hand any you want back.

**When it does not answer.** The button is answered by the laptop's scheduler. While the laptop sleeps or is off, nothing happens: stop by hand in Quantiply and on algotest.in/live. It is also off until `STOP_BUTTON=on` is in the `.env` at the top of the repository on the laptop.

## Common questions

**Are these settings shared?** Appearance, defaults and navigation are stored in this browser
only. Telegram alert switches and the Automation settings are stored on the laptop and apply to everyone.
