// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SavedStrategy } from '../../../types/legwise';
import { NewStrategyDialog, copyOptions, parsePremium } from '../NewStrategyDialog';

const saved = (name: string) =>
  ({
    name,
    sha: 'abc',
    strategy: { id: name, underlying: 'NIFTY', legs: [] },
  }) as unknown as SavedStrategy;

afterEach(cleanup);

function open(props: Partial<Parameters<typeof NewStrategyDialog>[0]> = {}) {
  const onStart = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <NewStrategyDialog
      open
      onOpenChange={onOpenChange}
      saved={[saved('nifty_widesl_917_otm1'), saved('nifty_buy_range_breakout')]}
      starred={new Set(['nifty_widesl_917_otm1'])}
      onStart={onStart}
      {...props}
    />,
  );
  return { onStart, onOpenChange };
}

describe('NewStrategyDialog helpers', () => {
  it('lists starred strategies first, each group by name', () => {
    const rows = copyOptions([saved('b'), saved('a'), saved('d'), saved('c')], new Set(['d', 'b']));
    expect(rows).toEqual([
      { name: 'b', starred: true },
      { name: 'd', starred: true },
      { name: 'a', starred: false },
      { name: 'c', starred: false },
    ]);
  });

  it('counts a strategy as starred by its id as well as its file name', () => {
    const renamed = {
      name: 'file_name',
      sha: 'abc',
      strategy: { id: 'the_id', underlying: 'NIFTY', legs: [] },
    } as unknown as SavedStrategy;
    const rows = copyOptions([saved('zzz'), renamed], new Set(['the_id']));
    expect(rows).toEqual([
      { name: 'file_name', starred: true },
      { name: 'zzz', starred: false },
    ]);
  });

  it('reads a premium only when it is a positive amount', () => {
    expect(parsePremium('65')).toBe(65);
    expect(parsePremium(' 72.5 ')).toBe(72.5);
    for (const bad of ['', ' ', '0', '-3', 'abc', '1e999'])
      expect(parsePremium(bad), bad).toBeNull();
  });
});

describe('NewStrategyDialog opening', () => {
  function Host({ underlying }: { underlying: 'NIFTY' | 'SENSEX' }) {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          reopen
        </button>
        <NewStrategyDialog
          open={open}
          onOpenChange={setOpen}
          saved={[saved('a_strategy')]}
          starred={new Set()}
          onStart={() => undefined}
          initialUnderlying={underlying}
        />
      </>
    );
  }

  it('opens on the index of the strategy in hand, and starts afresh each time', () => {
    const { rerender } = render(<Host underlying="NIFTY" />);
    expect((screen.getByLabelText('Index') as HTMLSelectElement).value).toBe('NIFTY');
    fireEvent.change(screen.getByLabelText('Index'), { target: { value: 'BANKNIFTY' } });
    fireEvent.click(screen.getByRole('radio', { name: /Blank/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    // The strategy in hand is now a SENSEX one; reopening shows SENSEX and the first choice.
    rerender(<Host underlying="SENSEX" />);
    fireEvent.click(screen.getByRole('button', { name: 'reopen' }));
    expect((screen.getByLabelText('Index') as HTMLSelectElement).value).toBe('SENSEX');
    expect(
      (screen.getByRole('radio', { name: /^Short strangle —/ }) as HTMLInputElement).checked,
    ).toBe(true);
  });
});

describe('NewStrategyDialog', () => {
  it('names the three templates, a copy and a blank', () => {
    open();
    for (const label of [
      'Short strangle',
      'Buy range breakout',
      'Short strangle at a premium',
      'Copy a saved strategy',
      'Blank',
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByText('Nothing is saved until you press Save in the Builder.')).toBeTruthy();
  });

  it('starts the first template for NIFTY by default', () => {
    const { onStart, onOpenChange } = open();
    fireEvent.click(screen.getByRole('button', { name: 'Open in Builder' }));
    expect(onStart).toHaveBeenCalledWith({
      kind: 'template',
      id: 'short_strangle',
      underlying: 'NIFTY',
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('asks for the premium on the premium template and passes it', () => {
    const { onStart } = open();
    fireEvent.click(screen.getByRole('radio', { name: /Short strangle at a premium/ }));
    const premium = screen.getByLabelText('Premium') as HTMLInputElement;
    expect(premium.value).toBe('65'); // the NIFTY default
    fireEvent.change(premium, { target: { value: '80' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open in Builder' }));
    expect(onStart).toHaveBeenCalledWith({
      kind: 'template',
      id: 'short_strangle_premium',
      underlying: 'NIFTY',
      premium: 80,
    });
  });

  it('blocks the premium template until another index is given a premium', () => {
    const { onStart } = open();
    fireEvent.click(screen.getByRole('radio', { name: /Short strangle at a premium/ }));
    fireEvent.change(screen.getByLabelText('Index'), { target: { value: 'SENSEX' } });
    expect((screen.getByLabelText('Premium') as HTMLInputElement).value).toBe('');
    const go = screen.getByRole('button', { name: 'Open in Builder' }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    expect(screen.getByText('Enter the premium in rupees, above 0.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Premium'), { target: { value: '120' } });
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    expect(onStart).toHaveBeenCalledWith({
      kind: 'template',
      id: 'short_strangle_premium',
      underlying: 'SENSEX',
      premium: 120,
    });
  });

  it('copies the first starred strategy unless another is picked', () => {
    const { onStart } = open();
    fireEvent.click(screen.getByRole('radio', { name: /Copy a saved strategy/ }));
    // The index does not apply to a copy: it takes the saved strategy's own.
    expect(screen.queryByLabelText('Index')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open in Builder' }));
    expect(onStart).toHaveBeenCalledWith({ kind: 'copy', name: 'nifty_widesl_917_otm1' });
  });

  it('cannot copy when nothing is saved', () => {
    open({ saved: [] });
    fireEvent.click(screen.getByRole('radio', { name: /Copy a saved strategy/ }));
    expect(
      (screen.getByRole('button', { name: 'Open in Builder' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('starts a blank for the chosen index', () => {
    const { onStart } = open();
    fireEvent.change(screen.getByLabelText('Index'), { target: { value: 'BANKNIFTY' } });
    fireEvent.click(screen.getByRole('radio', { name: /Blank/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Open in Builder' }));
    expect(onStart).toHaveBeenCalledWith({ kind: 'blank', underlying: 'BANKNIFTY' });
  });
});
