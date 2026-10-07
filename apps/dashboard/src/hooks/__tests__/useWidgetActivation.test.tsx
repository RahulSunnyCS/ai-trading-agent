// @vitest-environment happy-dom
import { act, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useWidgetActivation } from '../useWidgetActivation';

let observed: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];
let margins: Array<string | undefined> = [];
let disconnects = 0;

class FakeObserver {
  constructor(
    callback: (entries: Array<{ isIntersecting: boolean }>) => void,
    options?: { rootMargin?: string },
  ) {
    observed.push(callback);
    margins.push(options?.rootMargin);
  }
  observe(): void {}
  disconnect(): void {
    disconnects += 1;
  }
}

function Probe({
  prefetchAfterMs,
  ready,
  expensive,
  margin,
}: {
  prefetchAfterMs?: number | null;
  ready?: boolean;
  expensive?: boolean;
  margin?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const active = useWidgetActivation(ref, {
    prefetchAfterMs: prefetchAfterMs ?? null,
    ...(ready === undefined ? {} : { ready }),
    ...(expensive === undefined ? {} : { expensive }),
    ...(margin === undefined ? {} : { margin }),
  });
  return <div ref={ref}>{active ? 'active' : 'waiting'}</div>;
}

describe('useWidgetActivation', () => {
  beforeEach(() => {
    observed = [];
    margins = [];
    disconnects = 0;
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

  it('holds everything back until the hero chart has painted', () => {
    const view = render(<Probe prefetchAfterMs={100} ready={false} />);
    act(() => vi.advanceTimersByTime(10_000));
    expect(observed).toHaveLength(0);
    expect(view.container.textContent).toBe('waiting');
    view.rerender(<Probe prefetchAfterMs={100} ready />);
    expect(observed).toHaveLength(1);
    act(() => vi.advanceTimersByTime(100));
    expect(view.container.textContent).toBe('active');
  });

  it('uses the margin it is given, and stops observing once active', () => {
    const view = render(<Probe margin="0px 0px 120px 0px" />);
    expect(margins).toEqual(['0px 0px 120px 0px']);
    act(() => observed[0]?.([{ isIntersecting: true }]));
    expect(view.container.textContent).toBe('active');
    expect(disconnects).toBeGreaterThan(0);
  });

  it('never loads an expensive section in the background', () => {
    const view = render(<Probe expensive />);
    act(() => vi.advanceTimersByTime(60_000));
    expect(view.container.textContent).toBe('waiting');
    act(() => observed[0]?.([{ isIntersecting: true }]));
    expect(view.container.textContent).toBe('active');
  });

  it('keeps an expensive section inactive when nothing can tell it was scrolled to', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const view = render(<Probe expensive />);
    expect(view.container.textContent).toBe('waiting');
  });

  it('uses requestIdleCallback for the background load when the browser has it', () => {
    const callbacks: Array<() => void> = [];
    vi.stubGlobal('requestIdleCallback', (callback: () => void) => callbacks.push(callback));
    const view = render(<Probe prefetchAfterMs={50} />);
    act(() => vi.advanceTimersByTime(50));
    expect(view.container.textContent).toBe('waiting');
    act(() => callbacks[0]?.());
    expect(view.container.textContent).toBe('active');
  });
});
