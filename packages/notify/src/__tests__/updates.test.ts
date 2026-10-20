import { describe, expect, it } from 'vitest';
import { registerSecret } from '../secrets.js';
import { TELEGRAM_MAX_TEXT, sendTextChecked, splitText } from '../telegram.js';
import { answerCallbackQuery, getUpdates } from '../updates.js';

/** A stand-in for Telegram's API: never the real one. */
function stub(status: number, body: unknown, seen: Array<{ url: string; body: unknown }>) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

describe('getUpdates', () => {
  it('long-polls from the offset for messages and button taps only', async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    const r = await getUpdates(
      'tok',
      42,
      50,
      stub(200, { ok: true, result: [{ update_id: 42 }] }, seen),
    );
    expect(r).toEqual({ ok: true, updates: [{ update_id: 42 }] });
    expect(seen[0]?.url).toBe('https://api.telegram.org/bottok/getUpdates');
    expect(seen[0]?.body).toEqual({
      offset: 42,
      timeout: 50,
      allowed_updates: ['message', 'callback_query'],
    });
  });

  it('reports a second poller (409) without throwing, redacted', async () => {
    registerSecret('sekret-token-123');
    const r = await getUpdates(
      'sekret-token-123',
      0,
      1,
      stub(409, { ok: false, description: 'Conflict: sekret-token-123' }, []),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.description).not.toContain('sekret-token-123');
    }
  });

  it('a network error is a result, not a throw', async () => {
    const failing = (async () => {
      throw new Error('offline');
    }) as typeof fetch;
    const r = await getUpdates('tok', 0, 1, failing);
    expect(r).toEqual({ ok: false, status: 0, description: 'offline' });
  });
});

describe('answerCallbackQuery', () => {
  it('answers the tap by its id', async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    await answerCallbackQuery('tok', 'cb-1', 'Stopping', stub(200, { ok: true }, seen));
    expect(seen[0]?.url).toBe('https://api.telegram.org/bottok/answerCallbackQuery');
    expect(seen[0]?.body).toEqual({ callback_query_id: 'cb-1', text: 'Stopping' });
  });
});

describe('sendTextChecked / splitText', () => {
  it('splits a long report into numbered parts under the limit, on line breaks', () => {
    const text = Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
    const parts = splitText(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(TELEGRAM_MAX_TEXT);
    expect(parts[0]?.startsWith(`(1/${parts.length})\n`)).toBe(true);
    expect(splitText('short')).toEqual(['short']);
    // one line longer than the limit is cut, not lost
    expect(
      splitText('y'.repeat(9000))
        .join('')
        .replace(/\(\d\/\d\)\n/g, ''),
    ).toHaveLength(9000);
  });

  it('is true only when Telegram took every part', async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    const cfg = { botToken: 'tok', chatId: '1' };
    expect(await sendTextChecked(cfg, 'hi', stub(200, { ok: true }, seen))).toBe(true);
    expect(await sendTextChecked(cfg, 'hi', stub(400, { ok: false }, seen))).toBe(false);
    expect(await sendTextChecked(null, 'hi')).toBe(false);
  });
});
