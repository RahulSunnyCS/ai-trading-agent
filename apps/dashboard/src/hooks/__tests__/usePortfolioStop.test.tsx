// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_SETTING } from '../../lib/portfolioStop';
import { usePortfolioStop } from '../usePortfolioStop';

const KEY = 'ata.rotation.portfolioStop.v1';

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, '', '/optionslab/rotation');
});
afterEach(cleanup);

describe('usePortfolioStop', () => {
  it('starts on the default and only then takes what this browser kept', () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ ...DEFAULT_SETTING, stop: '8000', mode: 'none' }),
    );
    // the server render has no window and must produce the default, so first render == server
    function Probe() {
      const [s] = usePortfolioStop();
      return createElement('span', null, s.stop);
    }
    expect(renderToString(createElement(Probe))).toContain('10000');
    const { result } = renderHook(() => usePortfolioStop());
    expect(result.current[0].stop).toBe('8000'); // after the mount effect
  });

  it('puts a committed setting in the URL and reads it back from there', () => {
    const { result } = renderHook(() => usePortfolioStop());
    act(() => {
      result.current[1]({ ...DEFAULT_SETTING, stop: '8000', mode: 'sl', x: '1000', y: '500' });
    });
    expect(window.location.search).toContain('pfstop=8000');
    expect(decodeURIComponent(window.location.search)).toContain('pftrail=sl:1000,500');
    cleanup();
    window.localStorage.clear(); // a second browser: nothing stored, only the link
    const again = renderHook(() => usePortfolioStop());
    expect(again.result.current[0]).toMatchObject({
      stop: '8000',
      mode: 'sl',
      x: '1000',
      y: '500',
    });
  });

  it('removes the URL keys when the setting goes back to the default', () => {
    const { result } = renderHook(() => usePortfolioStop());
    act(() => result.current[1]({ ...DEFAULT_SETTING, stop: '8000' }));
    expect(window.location.search).toContain('pfstop');
    act(() => result.current[1](DEFAULT_SETTING));
    expect(window.location.search).not.toContain('pfstop');
  });
});
