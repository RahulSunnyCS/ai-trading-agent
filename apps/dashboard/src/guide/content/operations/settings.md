## What it is for

Personal preferences for this browser, what the daily automation does on AlgoTest and Quantiply, and which Telegram messages are sent.

## The sections

| Section | What you can set |
|---|---|
| Appearance | Light or dark theme, and density (how compact tables and cards are). |
| Defaults | The landing tab, the Momentum dataset that opens first, and the default backtest period. |
| Navigation | Show, hide and reorder sidebar tabs, section by section. Settings and this Guide cannot be hidden. The last section, **Archived engine** (Trades, P&L, Personalities, Regimes, Coverage, Billing), starts hidden; show any of them here. **Reset** puts the default back, archive hidden. |
| Browser alerts | A warning in the dashboard before the Fyers token expires. |
| Automation | What the daily jobs do (below). |
| Telegram alerts | One level per message type: **On**, **Failures only** (its problems are sent, its routine "it worked" reports are not) or **Off**. Every message has a line here: broker logins, Quantiply, the 09:16 pick, the 16:00 result, the momentum messages, the options evening summary, the morning summary, the trade monitor, scheduler failures, missed runs and recoveries, the digest and the backup. Defaults: the momentum preview and "recovered" off; the momentum journal check, live-rules status, options evening summary and the 15:40 Quantiply switch-off failures only; the rest on. The -₹8,000 loss alert and a live-money rule that is hit always send. |
| Account | The dashboard is protected by a single shared password when it runs on your own computer in production mode (`bun run start:prod`); when it is hosted behind Cloudflare Access, signing in is a Google sign-in or an emailed code instead. In local dev mode there is no sign-in. **Log out** ends your session. |
| About | What the dashboard is connected to. **Developer mode** shows each screen's list of unfinished work next to its title. |

> [!TIP]
> The Archived engine holds the paused paper-trading engine's screens and the two that read its
> server (Coverage, Billing). They are kept, not developed, and fail with an error while that
> server is not running. A hidden archived screen still opens by its link (for example `/trades`),
> and the sidebar then shows it while you are on it. The sidebar's other sections are Overview,
> Options Lab (with Live, the replay of a collected day), Momentum, Trade book and Operations
> (Jobs, Broker logins, Settings and this Guide).

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
- **Multiplier:** a whole number from 1 to 10 (1 unless you set it): the platform multiplier, so each strategy runs at that many times its lots.
  - **Quantiply:** the uploader sets it on each algo it creates and reads it back; a different saved value is reported and nothing is enabled. A changed multiplier replaces the algo at the next evening upload.
  - **AlgoTest:** the deployer never sets the sheet's multiplier. With a row above 1 it deploys nothing and says so; you deploy by hand at that multiplier.
  - The 09:25 deploy check expects the row's multiplier instead of 1, and the 09:05 margin check counts it. **Raising it above 1 has not been tried live yet: watch the first upload.**
- **Keep the clientwise MTM SL (Quantiply blocks):** the account's whole-day stop-loss, the "Clientwise P&L" SL in Quantiply, over every algo on that account, your own included. Each trading day at 08:00, after the login, the tool reads it and sets it to this figure only when it differs, then reads it back; the morning message says which. The default is the list's portfolio stop: ₹9,000 for Adaptive Tuned, ₹8,000 for Adaptive Classic. Off leaves whatever you set in Quantiply. A target or trailing option set there by hand is kept.
- **Include the Buy add-on:** whether the Buy add-on picks go with the list. Off leaves them out of the export, so they are not uploaded, deployed or checked, and an add-on already uploaded counts as no longer picked: the evening run deletes it unless it is deployed on /live (then it is kept and reported). On AlgoTest and Quantiply an export serves every account that uploads that list, so the add-on stays in while any of them has it on.
- **Dir ×2 on non-expiry days** (off by default): on a day neither NIFTY nor SENSEX expires, the picked Dir is uploaded at **2 lots** with its MTM SL doubled (₹3,000 → ₹6,000 on Quantiply, which takes the rupee figure as written; AlgoTest doubles it itself), so the list trades 4 lots. On an expiry day, and on a day no Dir is picked, every pick stays at 1 lot. The research behind it: the Dir was the best home for a 4th lot, and on expiry days 3 lots of the expiring index did better than any 4-lot mix.
  - **Quantiply:** on those days the 08:10 run raises the clientwise MTM SL above by the Dir's own stop (₹8,000 → ₹11,000 for Adaptive Classic, ₹9,000 → ₹12,000 for Adaptive Tuned), and sets it back on other days. The 09:21 top-up only ever raises it, for a Dir the 09:16 pick brought.
  - **AlgoTest:** the saved strategy carries the 2 lots and keeps the 1-lot overall MTM SL (₹3,000), because AlgoTest scales the overall stop by the leg lots itself (so it applies ₹6,000). The uploader reads it back, and you deploy it as usual. The tool sets no AlgoTest book stop.
  - One export serves every account that uploads a list on a platform, so the Dir is doubled only while **every** such account has this on; when they disagree it stays at 1 lot and the export says so.
  - The 09:16 and evening messages say the day's lots (`🔢 4 lots · Dir ×2`) and the 16:00 result adds what those lots made. Margin: 4 lots is about ₹8.1–8.3 lakh on a normal day (Angel One, 28 Oct); the 09:05 margin check still uses its older ₹1.4 lakh figure.

A warning badge on a block means its master switch holds it back.

**Capital.** Below the blocks, the money in each broker account: **Angel One** and **Shoonya**, in whole rupees (₹8.5 lakh each until you change them). The page shows their total. They feed the 16:00 result message on Telegram:

- Under each list (Adaptive and Tuned Adaptive), its capital and the month so far on paper, as a share of it (`Capital ₹8.5 L` / `October +₹26,634 (+3.1%)`). A list's capital is the capital of the accounts whose rows upload it, each counted once.
- In your own chat only, the total capital and what you really made this month, from the contract notes (the [Trade book](app:/tradebook/fno)'s figures), per broker, up to the last day with a note. Today's notes arrive after midnight, so the 16:00 message runs to the session before.
  - The month's profit is after the notes' charges (brokerage, STT, exchange and SEBI fees, GST, stamp duty) and the algo fees.
  - It does not take off the collateral interest from the brokers' ledger or the other debits (the Trade book's estimate of about ₹1,000 a year per F&O broker), so the message lists both and the profit **after debits**. Deposits are never counted as profit.
- The friends' group sees the per-list lines, never the real money.

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

- **The 08:00 login (on this Mac, 08:02):**
  - With logins off, or no block logging in, nothing logs in, and GitHub's 08:15 backup does nothing.
  - With neither AlgoTest block on, AlgoTest is left out: no wait for AlgoTest's 08:15 window, Quantiply logs in at once, and the Telegram report names only Quantiply.
  - Quantiply · Shoonya logs in after the AlgoTest logins (straight after Quantiply · Angel One when AlgoTest is off), when its block is on. Its result counts in the report's verdict.
  - A part that fails for a reason another machine could fix is tried again on GitHub, that part only; a refused password or PIN never is. GitHub keeps its own copy of the passwords: when you change one in `.env`, change GitHub's too.
- **The evening upload (16:45):** AlgoTest gets every list its blocks choose. Each Quantiply account (Angel One, Shoonya) gets its own block's list. A block with upload off is left untouched. On Quantiply the evening also deletes every finished, switched-off algo on the account, **your own included**; never one that is switched on or may still run. On Shoonya (a paid plan) it then sets the Subscription's algos a day to what the next session needs (3, or 4 with an add-on): it previews the change, raises it only when your credits cover it, and reads it back. Lowering returns the unused credits. Two algos a day come with the plan, so asking for 2 or fewer is left to you.
- **Deploying:** it also needs Automated deployment on.
  - AlgoTest deploys the day's T1 picks after 09:16, only while an AlgoTest block uploads the T1 list (and Automated uploads is on: with uploads off nothing new is in AlgoTest to deploy). A block uploading Core is not deployed by any job; a Telegram message says so. With none, the deploy and its 15:35 check do not log in to AlgoTest (the check still runs on a day the tool deployed something).
  - Quantiply: at 08:10, after the login, each account whose block uploads a list has its MTM SL kept (above) and last evening's algos for today switched on. One message for both accounts says so every morning.
  - At 09:16 the real pick is recorded. It changes only what starts after 09:17: last evening's 09:17 strategy keeps running and a new 09:17 pick is not made; the rest is chosen again by the 09:16 score (2 Widesl and 1 directional, the highest scorers). At 09:19 the new strategy is created and at 09:21 it is switched on and the one it replaced switched off. You get messages only on a day something changed.
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
