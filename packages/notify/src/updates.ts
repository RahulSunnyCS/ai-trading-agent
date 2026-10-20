import { redact } from './secrets.js';

/**
 * Inbound Telegram: the long poll and the callback answer the stop button's listener needs
 * (BL-143 Phase 4, `apps/scheduler/src/stop-button.ts`). Kept here beside `send` so every call to
 * Telegram's API stays in this package, redacted the same way.
 *
 * `getUpdates` has ONE consumer per bot: Telegram answers 409 to a second poller (or while a
 * webhook is set), and each update is handed out once. Nothing else may poll this bot while the
 * stop button is on.
 */

export interface TgUser {
  id: number;
}
export interface TgChat {
  id: number;
  type?: string;
}
export interface TgMessage {
  message_id: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
}
export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export type UpdatesResult =
  | { ok: true; updates: TgUpdate[] }
  | { ok: false; status: number; description: string };

/** One long poll: updates after `offset`, waiting up to `timeoutSeconds`. Never throws. */
export async function getUpdates(
  botToken: string,
  offset: number,
  timeoutSeconds: number,
  fetchImpl: typeof fetch = fetch,
  apiBase = 'https://api.telegram.org',
): Promise<UpdatesResult> {
  try {
    const response = await fetchImpl(`${apiBase}/bot${botToken}/getUpdates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        offset,
        timeout: timeoutSeconds,
        allowed_updates: ['message', 'callback_query'],
      }),
      signal: AbortSignal.timeout((timeoutSeconds + 15) * 1000),
    });
    const body = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: TgUpdate[];
      description?: string;
    };
    if (!response.ok || body.ok !== true || !Array.isArray(body.result)) {
      return {
        ok: false,
        status: response.status,
        description: redact(body.description ?? `HTTP ${response.status}`),
      };
    }
    return { ok: true, updates: body.result };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      description: redact(error instanceof Error ? error.message : String(error)),
    };
  }
}

/** Stops the button's spinner and shows `text` briefly. Never throws. */
export async function answerCallbackQuery(
  botToken: string,
  callbackQueryId: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
  apiBase = 'https://api.telegram.org',
): Promise<void> {
  try {
    await fetchImpl(`${apiBase}/bot${botToken}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text: redact(text).slice(0, 200),
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    console.error(
      `  telegram answerCallbackQuery failed: ${redact(error instanceof Error ? error.message : String(error))}`,
    );
  }
}
