// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CORE_STOP_KEYS,
  DEFAULT_SETTING,
  DEFAULT_T1_SETTING,
  T1_STOP_KEYS,
} from '../../lib/portfolioStop';
import { usePortfolioStop } from '../usePortfolioStop';

const KEY = CORE_STOP_KEYS.storageKey;

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, '', '/optionslab/rotation');
});
afterEach(cleanup);

describe('usePortfolioStop', () => {
  it('starts on the default and only then takes what this browser kept', () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ ...DEFAULT_SETTING, stop: '7000', mode: 'none' }),
    );
    // the server render has no window and must produce the default, so first render == server
    function Probe() {
      const [s] = usePortfolioStop();
      return createElement('span', null, s.stop);
    }
    expect(renderToString(createElement(Probe))).toContain('8000');
    const { result } = renderHook(() => usePortfolioStop());
    expect(result.current[0].stop).toBe('7000'); // after the mount effect
  });

  it('ignores a setting kept under the old key, so the new 8,000 default applies', () => {
    window.localStorage.setItem(
      'ata.rotation.portfolioStop.v1',
      JSON.stringify({ ...DEFAULT_SETTING, stop: '10000' }),
    );
    const { result } = renderHook(() => usePortfolioStop());
    expect(result.current[0].stop).toBe('8000');
  });

  it('puts a committed setting in the URL and reads it back from there', () => {
    const { result } = renderHook(() => usePortfolioStop());
    act(() => {
      result.current[1]({ ...DEFAULT_SETTING, stop: '7000', mode: 'sl', x: '1000', y: '500' });
    });
    expect(window.location.search).toContain('pfstop=7000');
    expect(decodeURIComponent(window.location.search)).toContain('pftrail=sl:1000,500');
    cleanup();
    window.localStorage.clear(); // a second browser: nothing stored, only the link
    const again = renderHook(() => usePortfolioStop());
    expect(again.result.current[0]).toMatchObject({
      stop: '7000',
      mode: 'sl',
      x: '1000',
      y: '500',
    });
  });

  it('removes the URL keys when the setting goes back to the default', () => {
    const { result } = renderHook(() => usePortfolioStop());
    act(() => result.current[1]({ ...DEFAULT_SETTING, stop: '7000' }));
    expect(window.location.search).toContain('pfstop');
    act(() => result.current[1](DEFAULT_SETTING));
    expect(window.location.search).not.toContain('pfstop');
  });

  it("keeps Adaptive Tuned's setting apart: its own default, URL keys and storage", () => {
    const core = renderHook(() => usePortfolioStop());
    const tuned = renderHook(() => usePortfolioStop(T1_STOP_KEYS));
    expect(core.result.current[0]).toEqual(DEFAULT_SETTING);
    expect(tuned.result.current[0]).toEqual(DEFAULT_T1_SETTING);
    act(() => tuned.result.current[1]({ ...DEFAULT_T1_SETTING, stop: '9500' }));
    expect(window.location.search).toContain('pfstop_t1=9500');
    expect(new URLSearchParams(window.location.search).get('pfstop')).toBeNull();
    expect(tuned.result.current[0].stop).toBe('9500');
    expect(core.result.current[0].stop).toBe('8000');
    expect(window.localStorage.getItem(T1_STOP_KEYS.storageKey)).toContain('9500');
    expect(window.localStorage.getItem(KEY)).toBeNull();
    // back to Tuned's own default: its keys leave the URL
    act(() => tuned.result.current[1](DEFAULT_T1_SETTING));
    expect(window.location.search).not.toContain('pfstop_t1');
  });
});
