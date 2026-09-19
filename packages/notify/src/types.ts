/** How loud the message is. Maps to an icon; callers do not pick icons. */
export type Severity = 'info' | 'warn' | 'error' | 'action_required';

/**
 * One inline-keyboard button.
 *
 * Deliberately NOT a URL. Telegram pre-fetches links in messages to build
 * previews, so a URL that triggers something server-side fires before the
 * human ever taps it. A callback button sends `callback_query` to the bot
 * instead — no public endpoint, no preview crawler.
 */
export interface Action {
  /** Text on the button. */
  label: string;
  /** Returned verbatim as `callback_query.data`. Telegram caps this at 64 bytes. */
  data: string;
}

export interface Notification {
  /** Which system is speaking, e.g. 'broker-login'. */
  source: string;
  severity: Severity;
  /** First line — this is what shows on a lock screen. Keep it short. */
  title: string;
  /** Optional detail below the title. */
  body?: string;
  /** Link to the CI run or dashboard that produced this. */
  runUrl?: string;
  /**
   * Buttons. Present means the message is asking a human to decide something.
   * Whoever handles the callback must check `callback_query.from.id` — anyone
   * who can reach the chat can otherwise press them.
   */
  actions?: Action[];
}

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}
