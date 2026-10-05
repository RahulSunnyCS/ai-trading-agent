import { describe, expect, it } from 'vitest';

import { parseStoredPreference, resolveTheme } from './theme';

describe('theme preference', () => {
  it('a first-time visitor (nothing stored) gets dark, whatever the OS says', () => {
    const preference = parseStoredPreference(null);
    expect(preference).toBe('dark');
    expect(resolveTheme(preference, 'light')).toBe('dark');
  });

  it('keeps a stored explicit choice', () => {
    expect(parseStoredPreference('light')).toBe('light');
    expect(parseStoredPreference('dark')).toBe('dark');
    expect(resolveTheme('light', 'dark')).toBe('light');
  });

  it("'system' follows the OS", () => {
    expect(parseStoredPreference('system')).toBe('system');
    expect(resolveTheme('system', 'light')).toBe('light');
    expect(resolveTheme('system', 'dark')).toBe('dark');
  });

  it('falls back to dark for an unknown stored value', () => {
    expect(parseStoredPreference('sepia')).toBe('dark');
  });
});
