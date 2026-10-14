// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newStrategy } from '../../../lib/legwiseBuilder';
import type { SavedStrategy } from '../../../types/legwise';

const mocks = vi.hoisted(() => ({
  saved: [] as unknown[],
  validation: { status: 'valid', errors: [] as string[], error: null as string | null },
  posts: [] as { path: string; body: Record<string, unknown> }[],
  puts: [] as { path: string; body: unknown }[],
  lastDay: '2026-10-14',
}));

vi.mock('../../../hooks/useLegwise', () => ({
  LEGWISE_API: '/api/backtest/legwise',
  useLegwiseStrategies: () => ({
    data: mocks.saved,
    loading: false,
    error: null,
    refetch: () => undefined,
  }),
  useLegwiseResults: () => ({
    data: { results: [] },
    loading: false,
    error: null,
    refetch: () => undefined,
  }),
  useLegwiseData: () => ({
    data: { days: { NIFTY: ['2026-10-13', mocks.lastDay] } },
    loading: false,
    error: null,
    refetch: () => undefined,
  }),
}));
vi.mock('../../../hooks/useLegwiseValidate', () => ({
  useLegwiseValidate: () => mocks.validation,
}));
vi.mock('../../../hooks/usePaymentBalance', () => ({
  usePaymentBalance: () => ({ enabled: false, balance: null, loading: false, error: null }),
}));
vi.mock('../../../hooks/useFavourites', () => ({
  useFavourites: () => ({ set: { lists: [], strategies: [] }, error: null }),
}));
vi.mock('../../../hooks/useAppRoute', () => ({
  useAppRoute: () => ({ navigate: () => undefined, rest: [], tab: 'optionslab' }),
}));
vi.mock('../../../lib/api', () => ({
  apiPost: vi.fn(async (path: string, body: Record<string, unknown>) => {
    mocks.posts.push({ path, body });
    return { ok: true, data: { strategy_id: 'x', run_id: 'adhoc:1', days: [] } };
  }),
  apiPut: vi.fn(async (path: string, body: unknown) => {
    mocks.puts.push({ path, body });
    return { ok: true, data: { name: 'saved_name', sha: 'abc123' } };
  }),
}));

import { StrategyBuilder } from '../StrategyBuilder';

const saved = (name: string): SavedStrategy =>
  ({ name, sha: 'abcdef123456', strategy: { ...newStrategy('NIFTY'), id: name } }) as SavedStrategy;

beforeEach(() => {
  mocks.saved = [saved('nifty_widesl_917_otm1')];
  mocks.validation = { status: 'valid', errors: [], error: null };
  mocks.posts = [];
  mocks.puts = [];
  window.history.replaceState(null, '', '/optionslab/builder');
});
afterEach(cleanup);

function edit(name: string, text: string) {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${name}:`) }));
  const input = screen.getByRole('textbox', { name });
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

describe('StrategyBuilder (the leg grid)', () => {
  it('opens on a short straddle skeleton named for what it does', () => {
    render(<StrategyBuilder />);
    expect(screen.getByRole('heading', { name: /Short straddle · 09:20/ })).toBeTruthy();
    expect((screen.getByLabelText('File name') as HTMLInputElement).value).toBe('my_strategy');
    expect(screen.getByRole('button', { name: 'Strike for leg1: ATM' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Entry time: 09:20' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'In plain words' })).toBeTruthy();
    expect(screen.getByText('Ready to run')).toBeTruthy();
  });

  it('follows an edit: the name, the file and the read-back change together', () => {
    render(<StrategyBuilder />);
    edit('Strike for leg1', 'OTM1');
    // Both legs of the pair move, so it is a strangle now, and the file name follows.
    expect(screen.getByRole('button', { name: 'Strike for leg2: OTM1' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Short strangle OTM1 · 09:20/ })).toBeTruthy();
    expect((screen.getByLabelText('File name') as HTMLInputElement).value).toBe(
      'nifty_short_strangle_otm1_09_20',
    );
    const words = screen.getByRole('region', { name: 'In plain words' });
    expect(within(words).getByText(/one strike out of the money/)).toBeTruthy();
  });

  it('stops following once the file name is typed by hand', () => {
    render(<StrategyBuilder />);
    fireEvent.change(screen.getByLabelText('File name'), { target: { value: 'my_own_name' } });
    edit('Strike for leg1', 'OTM1');
    expect((screen.getByLabelText('File name') as HTMLInputElement).value).toBe('my_own_name');
  });

  it('never auto-names a new strategy after a file that already exists', () => {
    mocks.saved = [saved('nifty_short_strangle_otm1_09_20')];
    render(<StrategyBuilder />);
    edit('Strike for leg1', 'OTM1');
    expect((screen.getByLabelText('File name') as HTMLInputElement).value).toBe(
      'nifty_short_strangle_otm1_09_20_copy',
    );
  });

  it('holds Backtest and Save while a cell still has a value that was refused', () => {
    render(<StrategyBuilder />);
    fireEvent.click(screen.getByRole('button', { name: /^Strike for leg1:/ }));
    const input = screen.getByRole('textbox', { name: 'Strike for leg1' });
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('alert')).toBeTruthy();
    expect((screen.getByRole('button', { name: /Backtest/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect((screen.getByRole('button', { name: /Backtest/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('edits one leg only when "both legs together" is off', () => {
    render(<StrategyBuilder />);
    fireEvent.click(screen.getByRole('checkbox', { name: /Edit both legs together/ }));
    edit('Stop for leg1', '40%');
    expect(screen.getByRole('button', { name: 'Stop for leg1: 40%' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop for leg2: 25%' })).toBeTruthy();
  });

  it('tells what to fix when the validator finds a problem', () => {
    mocks.validation = {
      status: 'invalid',
      errors: ['exit_time: exit_time must be after entry_time'],
      error: null,
    };
    render(<StrategyBuilder />);
    expect(screen.getByRole('region', { name: 'What to fix' })).toBeTruthy();
    expect(screen.queryByText('Ready to run')).toBeNull();
  });

  it('never says ready when the validator could not be reached', () => {
    mocks.validation = { status: 'unknown', errors: [], error: 'HTTP 502' };
    render(<StrategyBuilder />);
    expect(screen.queryByText('Ready to run')).toBeNull();
    expect(screen.getByText('The form could not be checked right now.')).toBeTruthy();
  });

  it('turns a period chip into dates counted back from the last collected day', () => {
    render(<StrategyBuilder />);
    fireEvent.click(screen.getByRole('button', { name: '3 months' }));
    expect((screen.getByLabelText('Backtest from') as HTMLInputElement).value).toBe('2026-07-14');
    expect((screen.getByLabelText('Backtest to') as HTMLInputElement).value).toBe('2026-10-14');
    expect(screen.getByRole('button', { name: '3 months' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: 'All data' }));
    expect((screen.getByLabelText('Backtest from') as HTMLInputElement).value).toBe('');
  });

  it('sends the dates, the bar size and include_excluded with a backtest', async () => {
    render(<StrategyBuilder />);
    fireEvent.click(screen.getByRole('button', { name: '1 year' }));
    fireEvent.change(screen.getByLabelText('Bar size'), { target: { value: '5m' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Include days with bad data/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Backtest/ }));
    await waitFor(() => expect(mocks.posts).toHaveLength(1));
    const { path, body } = mocks.posts[0] ?? { path: '', body: {} };
    expect(path).toBe('/api/backtest/legwise/backtest');
    expect(body).toMatchObject({
      from: '2025-10-14',
      to: '2026-10-14',
      bars: '5m',
      include_excluded: true,
    });
  });

  it('leaves bars and include_excluded out of a default backtest', async () => {
    render(<StrategyBuilder />);
    fireEvent.click(screen.getByRole('button', { name: /^Backtest/ }));
    await waitFor(() => expect(mocks.posts).toHaveLength(1));
    expect(Object.keys(mocks.posts[0]?.body ?? {}).sort()).toEqual(['strategy']);
  });

  it("opens a leg's full settings in a drawer", () => {
    render(<StrategyBuilder />);
    fireEvent.click(screen.getByRole('button', { name: /^All settings for leg1/ }));
    const drawer = screen.getByRole('dialog');
    expect(within(drawer).getByText(/Everything the grid does not show/)).toBeTruthy();
  });

  it('starts a template from the address, unsaved', async () => {
    window.history.replaceState(
      null,
      '',
      '/optionslab/builder?new=short_strangle_premium&index=NIFTY&premium=70',
    );
    render(<StrategyBuilder />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Strike for ce: ₹70' })).toBeTruthy(),
    );
    expect(window.location.search).toBe('');
    expect((screen.getByLabelText('File name') as HTMLInputElement).value).toBe(
      'nifty_short_strangle_premium_70',
    );
    expect(screen.getByText('Not saved yet')).toBeTruthy();
  });

  it('saves under the file name it shows', async () => {
    render(<StrategyBuilder />);
    fireEvent.change(screen.getByLabelText('File name'), { target: { value: 'my_new_one' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save/ }));
    await waitFor(() => expect(mocks.puts).toHaveLength(1));
    expect(mocks.puts[0]?.path).toBe('/api/backtest/legwise/strategies/my_new_one');
    expect((mocks.puts[0]?.body as { strategy: { id: string } }).strategy.id).toBe('my_new_one');
  });
});
