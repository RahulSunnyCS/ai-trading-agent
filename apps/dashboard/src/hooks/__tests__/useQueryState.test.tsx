// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readQueryParam, useQueryState, withQueryParam } from '../useQueryState';

describe('query-string helpers', () => {
  it('reads a key, treating empty as absent', () => {
    expect(readQueryParam('?status=open&to=2026-09-30', 'status')).toBe('open');
    expect(readQueryParam('status=', 'status')).toBeNull();
    expect(readQueryParam('', 'status')).toBeNull();
  });

  it('sets, replaces and removes a key, keeping the others', () => {
    expect(withQueryParam('', 'range', '30d')).toBe('?range=30d');
    expect(withQueryParam('?a=1&range=7d', 'range', '30d')).toBe('?a=1&range=30d');
    expect(withQueryParam('?a=1&range=7d', 'range', null)).toBe('?a=1');
    expect(withQueryParam('?range=7d', 'range', '')).toBe('');
  });
});

describe('useQueryState', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/trades?status=open#top');
  });
  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('reads the key from the URL', () => {
    const { result } = renderHook(() => useQueryState('status'));
    expect(result.current[0]).toBe('open');
  });

  it('writes with replaceState, keeping the path and hash, and updates every reader', () => {
    const lengthBefore = window.history.length;
    const status = renderHook(() => useQueryState('status'));
    const personality = renderHook(() => useQueryState('personality'));

    act(() => personality.result.current[1]('p1'));
    expect(personality.result.current[0]).toBe('p1');
    expect(window.location.pathname).toBe('/trades');
    expect(window.location.search).toBe('?status=open&personality=p1');
    expect(window.location.hash).toBe('#top');
    expect(window.history.length).toBe(lengthBefore);

    act(() => status.result.current[1](null));
    expect(status.result.current[0]).toBeNull();
    expect(window.location.search).toBe('?personality=p1');
  });

  it('follows back/forward (popstate)', () => {
    const { result } = renderHook(() => useQueryState('status'));
    act(() => {
      window.history.replaceState(null, '', '/trades?status=closed');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(result.current[0]).toBe('closed');
  });
});
