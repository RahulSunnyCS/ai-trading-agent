import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { disabledTypes, isEnabled } from '../prefs.js';
import { send } from '../telegram.js';

function prefsFile(contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'notify-prefs-')), 'notifications.json');
  writeFileSync(path, contents);
  return path;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('notification preferences', () => {
  it('sends everything when the file is missing', () => {
    expect(isEnabled('momentum.preview', '/nonexistent/notifications.json')).toBe(true);
  });

  it('skips a switched-off type and keeps the rest', () => {
    const path = prefsFile('{"disabled": ["momentum.preview"]}');
    expect(isEnabled('momentum.preview', path)).toBe(false);
    expect(isEnabled('momentum.final', path)).toBe(true);
  });

  it('always sends an untagged message', () => {
    expect(isEnabled(undefined, prefsFile('{"disabled": ["momentum.preview"]}'))).toBe(true);
  });

  it('fails open on a broken file, so it never silences an alert', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(disabledTypes(prefsFile('{not json')).size).toBe(0);
    expect(disabledTypes(prefsFile('{"disabled": "momentum.final"}')).size).toBe(0);
  });

  it('send() does not call Telegram for a switched-off type', async () => {
    vi.stubEnv('NOTIFY_PREFS_FILE', prefsFile('{"disabled": ["options.daily"]}'));
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const config = { botToken: 'token-1234', chatId: '1' };
    await send(config, { source: 't', severity: 'info', title: 'x', type: 'options.daily' });
    expect(fetchMock).not.toHaveBeenCalled();
    await send(config, { source: 't', severity: 'info', title: 'x', type: 'momentum.final' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
