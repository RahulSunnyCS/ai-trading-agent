// @vitest-environment happy-dom
import { act, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useWidgetActivation } from '../useWidgetActivation';

let observed: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];

class FakeObserver {
  constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
    observed.push(callback);
  }
  observe(): void {}
  disconnect(): void {}
}

function Probe({ prefetchAfterMs }: { prefetchAfterMs?: number | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const active = useWidgetActivation(ref, { prefetchAfterMs: prefetchAfterMs ?? null });
  return <div ref={ref}>{active ? 'active' : 'waiting'}</div>;
}

describe('useWidgetActivation', () => {
  beforeEach(() => {
    observed = [];
    vi.useFakeTimers();
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    vi.stubGlobal('requestIdleCallback', undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('waits until the widget comes near the screen', () => {
    const view = render(<Probe />);
    expect(view.container.textContent).toBe('waiting');
    act(() => vi.advanceTimersByTime(60_000));
    expect(view.container.textContent).toBe('waiting');
    act(() => observed[0]?.([{ isIntersecting: true }]));
    expect(view.container.textContent).toBe('active');
  });

  it('activates in the background after its prefetch delay', () => {
    const view = render(<Probe prefetchAfterMs={800} />);
    act(() => vi.advanceTimersByTime(799));
    expect(view.container.textContent).toBe('waiting');
    act(() => vi.advanceTimersByTime(1));
    expect(view.container.textContent).toBe('active');
  });

  it('is active at once without IntersectionObserver', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const view = render(<Probe />);
    expect(view.container.textContent).toBe('active');
  });
});
