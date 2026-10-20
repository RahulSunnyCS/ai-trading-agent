import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendText } from '../telegram.js';

// BL-143: a caller that must not lose a message needs to know whether Telegram took it.
describe('sendText outcome', () => {
  const config = { botToken: 'bot-token-x', chatId: '1' };
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('is sent only when Telegram answers ok', async () => {
    vi.stubEnv('NOTIFY_PREFS_FILE', '/nonexistent/prefs.json');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 })),
    );
    expect(await sendText(config, 'hello')).toBe('sent');
  });

  it('is failed on an HTTP error or a network error, never thrown', async () => {
    vi.stubEnv('NOTIFY_PREFS_FILE', '/nonexistent/prefs.json');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 502 })),
    );
    expect(await sendText(config, 'hello')).toBe('failed');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    expect(await sendText(config, 'hello')).toBe('failed');
  });

  it('is unconfigured without a config', async () => {
    vi.stubEnv('NOTIFY_PREFS_FILE', '/nonexistent/prefs.json');
    expect(await sendText(null, 'hello')).toBe('unconfigured');
  });
});
