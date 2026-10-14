// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useToastStore } from '../../components/ui/Toast';
import { useFavourites } from '../useFavourites';
import { clearPolledResourceCache } from '../usePolledResource';

interface Served {
  lists: string[];
  strategies: string[];
}

/** A fetch that serves GET from `state` and applies PUT, unless `failPut` makes it answer 422. */
function installServer(initial: Served, opts: { failPut?: boolean } = {}) {
  const state: Served = { ...initial };
  const puts: Served[] = [];
  const respond = (body: unknown, status = 200) => ({
    ok: status < 400,
    status,
    statusText: status < 400 ? 'OK' : 'Unprocessable',
    json: async () => body,
  });
  const body = () => ({
    ...state,
    updated_at: '2026-10-14T22:00:00+05:30',
    is_default: false,
    warning: null,
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'PUT') {
        const sent = JSON.parse(String(init.body)) as Served;
        puts.push(sent);
        if (opts.failPut) return respond({ error: 'unknown list' }, 422);
        state.lists = sent.lists;
        state.strategies = sent.strategies;
        return respond(body());
      }
      return respond(body());
    }),
  );
  return { puts, state };
}

beforeEach(() => {
  clearPolledResourceCache();
  useToastStore.setState({ toasts: [] });
});
afterEach(() => vi.unstubAllGlobals());

describe('useFavourites', () => {
  it('has no set until the server has answered, then the starred items', async () => {
    installServer({ lists: ['A', 'B', 'C'], strategies: ['x'] });
    const { result } = renderHook(() => useFavourites());
    expect(result.current.set).toBeNull();
    await waitFor(() => expect(result.current.set).not.toBeNull());
    expect(result.current.set).toEqual({ lists: ['A', 'B', 'C'], strategies: ['x'] });
    expect(result.current.isListStarred('B')).toBe(true);
    expect(result.current.isStrategyStarred('y')).toBe(false);
  });

  it('shows a toggle at once and saves the whole set', async () => {
    const server = installServer({ lists: ['A'], strategies: [] });
    const { result } = renderHook(() => useFavourites());
    await waitFor(() => expect(result.current.set).not.toBeNull());

    act(() => result.current.toggleStrategy('nifty_buy_range_breakout'));
    expect(result.current.isStrategyStarred('nifty_buy_range_breakout')).toBe(true); // before the PUT
    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(server.puts[0]).toEqual({ lists: ['A'], strategies: ['nifty_buy_range_breakout'] });
  });

  it('keeps two quick toggles in order, each from the one before', async () => {
    const server = installServer({ lists: ['A'], strategies: [] });
    const { result } = renderHook(() => useFavourites());
    await waitFor(() => expect(result.current.set).not.toBeNull());

    act(() => {
      result.current.toggleList('B');
      result.current.toggleStrategy('x');
    });
    await waitFor(() => expect(server.puts).toHaveLength(2));
    expect(server.puts[0]).toEqual({ lists: ['A', 'B'], strategies: [] });
    expect(server.puts[1]).toEqual({ lists: ['A', 'B'], strategies: ['x'] });
    await waitFor(() => expect(server.state.strategies).toEqual(['x']));
  });

  it('puts the star back and says so when the save fails', async () => {
    installServer({ lists: ['A'], strategies: [] }, { failPut: true });
    const { result } = renderHook(() => useFavourites());
    await waitFor(() => expect(result.current.set).not.toBeNull());

    act(() => result.current.toggleList('C'));
    expect(result.current.isListStarred('C')).toBe(true);
    await waitFor(() => expect(result.current.isListStarred('C')).toBe(false));
    expect(
      useToastStore
        .getState()
        .toasts.map((t) => t.message)
        .join(' '),
    ).toContain('could not be saved');
  });

  it('ignores a toggle made before the server has answered', async () => {
    const server = installServer({ lists: ['A'], strategies: [] });
    const { result } = renderHook(() => useFavourites());
    act(() => result.current.toggleList('B'));
    expect(server.puts).toHaveLength(0);
    expect(result.current.set).toBeNull();
    await waitFor(() => expect(result.current.set).not.toBeNull()); // let the GET settle
  });
});
