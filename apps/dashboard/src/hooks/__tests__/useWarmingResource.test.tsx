// @vitest-environment happy-dom
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearPolledResourceCache } from '../usePolledResource';
import { WARMING_RETRY_MS, isWarming, useWarmingResource } from '../useWarmingResource';

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  clearPolledResourceCache();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('isWarming', () => {
  it('recognises only the warming body', () => {
    expect(isWarming({ status: 'warming' })).toBe(true);
    expect(isWarming({ status: 'ok' })).toBe(false);
    expect(isWarming(null)).toBe(false);
    expect(isWarming([])).toBe(false);
  });
});

describe('useWarmingResource', () => {
  it('shows warming with no data, then asks again until the answer arrives', async () => {
    // asking again starts the retry interval, which re-fetches once at once: two "warming"
    // answers come back before the real one
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      return calls <= 2 ? reply(202, { status: 'warming' }) : reply(200, { rows: [1] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useWarmingResource<{ rows: number[] }>('/api/x/days'));
    await waitFor(() => expect(result.current.warming).toBe(true));
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.data).toEqual({ rows: [1] }), {
      timeout: WARMING_RETRY_MS + 3000,
    });
    expect(result.current.warming).toBe(false);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps data that is complete but still has a part pending', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply(200, { n: 1, pending: true })),
    );
    const { result } = renderHook(() =>
      useWarmingResource<{ n: number; pending: boolean }>('/api/x/dd', {
        pending: (d) => d.pending,
      }),
    );
    await waitFor(() => expect(result.current.data).toEqual({ n: 1, pending: true }));
    expect(result.current.warming).toBe(true);
  });
});
