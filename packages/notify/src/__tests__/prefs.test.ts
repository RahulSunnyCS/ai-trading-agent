import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { disabledTypes, isEnabled, levelOf, looksLikeFailure } from '../prefs.js';
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
    // BL-173: momentum.preview is off by default; a type with no default is on
    expect(isEnabled('momentum.final', '/nonexistent/notifications.json')).toBe(true);
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

describe('levels: all / failures / off (BL-173)', () => {
  it('a failures-only type sends a failure and holds a success', () => {
    const path = prefsFile('{"levels": {"broker.quantiply": "failures"}}');
    expect(isEnabled('broker.quantiply', path, undefined, '✅ switched on')).toBe(false);
    expect(isEnabled('broker.quantiply', path, undefined, '⚠️ check Quantiply')).toBe(true);
    expect(isEnabled('broker.quantiply', path, true)).toBe(true);
    expect(isEnabled('broker.quantiply', path, false)).toBe(false);
  });

  it('the defaults apply when the file says nothing, and the file wins', () => {
    const none = '/nonexistent/notifications.json';
    expect(levelOf('momentum.preview', none)).toBe('off');
    expect(levelOf('options.daily', none)).toBe('failures');
    expect(levelOf('momentum.final', none)).toBe('all');
    const path = prefsFile(
      '{"levels": {"momentum.preview": "all"}, "disabled": ["options.daily"]}',
    );
    expect(levelOf('momentum.preview', path)).toBe('all');
    expect(levelOf('options.daily', path)).toBe('off');
  });

  it('an untagged message always goes, and a broken file falls back to the defaults', () => {
    expect(isEnabled(undefined, '/nonexistent', false, '✅ fine')).toBe(true);
    const broken = prefsFile('{not json');
    expect(levelOf('momentum.final', broken)).toBe('all');
    expect(looksLikeFailure('  ❌ failed')).toBe(true);
    expect(looksLikeFailure('✅ ok')).toBe(false);
  });
});
