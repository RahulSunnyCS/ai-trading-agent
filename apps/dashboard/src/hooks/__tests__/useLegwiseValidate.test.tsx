// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newStrategy } from '../../lib/legwiseBuilder';
import type { LegwiseStrategy } from '../../types/legwise';
import { LEGWISE_VALIDATE_DEBOUNCE_MS, useLegwiseValidate } from '../useLegwiseValidate';

type Resolve = (body: unknown, ok?: boolean) => void;

function installFetch(): { calls: { url: string; body: unknown; resolve: Resolve }[] } {
  const calls: { url: string; body: unknown; resolve: Resolve }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (url: string, init?: { body?: string }) =>
        new Promise((done) => {
          calls.push({
            url,
            body: JSON.parse(init?.body ?? 'null') as unknown,
            resolve: (body, ok = true) =>
              done({
                ok,
                status: ok ? 200 : 502,
                statusText: 'Bad Gateway',
                json: async () => body,
              }),
          });
        }),
    ),
  );
  return { calls };
}

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('useLegwiseValidate', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('waits for the debounce, then posts the strategy to the legwise validate endpoint', async () => {
    const { calls } = installFetch();
    const strategy = newStrategy();
    const { result } = renderHook(() => useLegwiseValidate(strategy));
    expect(result.current.status).toBe('checking');
    await tick(LEGWISE_VALIDATE_DEBOUNCE_MS - 1);
    expect(calls).toHaveLength(0);
    await tick(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/api/backtest/legwise/validate');
    expect(calls[0]?.body).toEqual({ strategy });
    await act(async () => calls[0]?.resolve({ valid: true, errors: [] }));
    expect(result.current).toEqual({ status: 'valid', errors: [], error: null });
  });

  it('reports the validator lines when invalid', async () => {
    const { calls } = installFetch();
    const { result } = renderHook(() => useLegwiseValidate(newStrategy()));
    await tick(LEGWISE_VALIDATE_DEBOUNCE_MS);
    await act(async () =>
      calls[0]?.resolve({ valid: false, errors: ['legs.0.lots: Input should be greater than 0'] }),
    );
    expect(result.current.status).toBe('invalid');
    expect(result.current.errors).toEqual(['legs.0.lots: Input should be greater than 0']);
  });

  it('sends one request for a burst of edits and ignores a stale answer', async () => {
    const { calls } = installFetch();
    const first = newStrategy();
    const { result, rerender } = renderHook(
      ({ s }: { s: LegwiseStrategy }) => useLegwiseValidate(s),
      { initialProps: { s: first } },
    );
    await tick(LEGWISE_VALIDATE_DEBOUNCE_MS);
    expect(calls).toHaveLength(1);

    // Two quick edits while the first request is still out.
    rerender({ s: { ...first, id: 'a' } });
    await tick(100);
    const latest = { ...first, id: 'ab' };
    rerender({ s: latest });
    await tick(LEGWISE_VALIDATE_DEBOUNCE_MS);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).toEqual({ strategy: latest });

    await act(async () => calls[0]?.resolve({ valid: false, errors: ['id: stale'] }));
    expect(result.current.status).toBe('checking');
    await act(async () => calls[1]?.resolve({ valid: true, errors: [] }));
    expect(result.current.status).toBe('valid');
  });

  it('does not re-validate when re-rendered with an equal strategy', async () => {
    const { calls } = installFetch();
    const { rerender } = renderHook(({ s }: { s: LegwiseStrategy }) => useLegwiseValidate(s), {
      initialProps: { s: newStrategy() },
    });
    await tick(LEGWISE_VALIDATE_DEBOUNCE_MS);
    rerender({ s: newStrategy() });
    await tick(LEGWISE_VALIDATE_DEBOUNCE_MS);
    expect(calls).toHaveLength(1);
  });

  it('says unknown, not invalid, when the validator cannot be reached', async () => {
    const { calls } = installFetch();
    const { result } = renderHook(() => useLegwiseValidate(newStrategy()));
    await tick(LEGWISE_VALIDATE_DEBOUNCE_MS);
    await act(async () => calls[0]?.resolve({ error: 'upstream down' }, false));
    expect(result.current).toEqual({ status: 'unknown', errors: [], error: 'upstream down' });
  });
});
