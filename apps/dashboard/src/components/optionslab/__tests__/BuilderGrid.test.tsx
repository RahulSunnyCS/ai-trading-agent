// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PlacedIssues } from '../../../lib/legwiseBuilder';
import { newLeg, newStrategy } from '../../../lib/legwiseBuilder';
import type { Leg, LegwiseStrategy } from '../../../types/legwise';
import { EditableCell } from '../builder/EditableCell';
import { LegGrid } from '../builder/LegGrid';
import { ReadBack } from '../builder/ReadBack';
import { StrategyTokens, parseRupees, parseTime } from '../builder/StrategyTokens';

afterEach(cleanup);

const noIssues: PlacedIssues = { bySlot: {}, byLeg: {}, unplaced: [], count: 0 };

const leg = (over: Partial<Leg> = {}): Leg => ({
  ...newLeg('ce', 'CE'),
  strike: { strike_type: 'OTM1' },
  stop_loss: { percent: 115 },
  ...over,
});

describe('EditableCell', () => {
  function setup(onCommit = vi.fn<(t: string) => string | null>(() => null), display = '115%') {
    render(<EditableCell display={display} ariaLabel="Stop" onCommit={onCommit} />);
    return onCommit;
  }

  it('shows its value, opens on a click, and keeps what was typed on Enter', () => {
    const onCommit = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Stop: 115%' }));
    const input = screen.getByRole('textbox', { name: 'Stop' });
    expect((input as HTMLInputElement).value).toBe('115%');
    fireEvent.change(input, { target: { value: '25%' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('25%');
    expect(screen.getByRole('button', { name: 'Stop: 115%' })).toBeTruthy(); // closed again
  });

  it('opens an off value empty, and gives a change up on Esc', () => {
    const onCommit = setup(undefined, '—');
    fireEvent.click(screen.getByRole('button', { name: 'Stop: off' }));
    const input = screen.getByRole('textbox', { name: 'Stop' }) as HTMLInputElement;
    expect(input.value).toBe('');
    fireEvent.change(input, { target: { value: '10' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Stop: off' })).toBeTruthy();
  });

  it('stays open and says why when the value is refused', () => {
    const onCommit = setup(vi.fn(() => 'Use a number with % or pts.'));
    fireEvent.click(screen.getByRole('button', { name: 'Stop: 115%' }));
    const input = screen.getByRole('textbox', { name: 'Stop' });
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('abc');
    expect(screen.getByRole('alert').textContent).toBe('Use a number with % or pts.');
    expect(screen.getByRole('textbox', { name: 'Stop' }).getAttribute('aria-invalid')).toBe('true');
    // Typing again clears the message.
    fireEvent.change(screen.getByRole('textbox', { name: 'Stop' }), { target: { value: '25%' } });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows what the validator said, without opening', () => {
    render(
      <EditableCell
        display="0"
        ariaLabel="Lots"
        errors={['Lots must be 1 or more']}
        onCommit={() => null}
      />,
    );
    const button = screen.getByRole('button', { name: 'Lots: 0' });
    expect(button.getAttribute('aria-invalid')).toBe('true');
    expect(button.getAttribute('title')).toBe('Lots must be 1 or more');
  });
});

describe('LegGrid', () => {
  function Harness({
    initial,
    issues = noIssues,
    onDetails = vi.fn(),
  }: { initial: Leg[]; issues?: PlacedIssues; onDetails?: (i: number) => void }) {
    const [legs, setLegs] = useState(initial);
    const [together, setTogether] = useState(false);
    return (
      <>
        <LegGrid
          legs={legs}
          issues={issues}
          together={together}
          onTogetherChange={setTogether}
          onChange={setLegs}
          onDetails={onDetails}
          onCopy={(i) => setLegs([...legs, { ...(legs[i] as Leg), id: `${legs[i]?.id}2` }])}
          onRemove={(i) => setLegs(legs.filter((_, j) => j !== i))}
          onAdd={() => setLegs([...legs, newLeg(`leg${legs.length + 1}`)])}
          onAddPair={() =>
            setLegs([...legs, newLeg(`a${legs.length}`, 'CE'), newLeg(`b${legs.length}`, 'PE')])
          }
        />
        <output data-testid="legs">{JSON.stringify(legs)}</output>
      </>
    );
  }
  const legsOf = () => JSON.parse(screen.getByTestId('legs').textContent ?? '[]') as Leg[];
  const strangle = () => [leg({ id: 'ce' }), leg({ id: 'pe', option_type: 'PE' })];

  function edit(name: string, text: string) {
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${name}:`) }));
    const input = screen.getByRole('textbox', { name });
    fireEvent.change(input, { target: { value: text } });
    fireEvent.keyDown(input, { key: 'Enter' });
  }

  it('shows one row per leg with its cells written the short way', () => {
    render(<Harness initial={strangle()} />);
    expect(screen.getByRole('button', { name: 'Strike for ce: OTM1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop for pe: 115%' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Trail for ce: off' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Re-entry after a stop for ce: off' })).toBeTruthy();
  });

  it('edits one leg in place by default', () => {
    render(<Harness initial={strangle()} />);
    edit('Stop for ce', '25%');
    expect(legsOf().map((l) => l.stop_loss)).toEqual([{ percent: 25 }, { percent: 115 }]);
  });

  it('edits both legs of a pair when asked, but never their id or type', () => {
    render(<Harness initial={strangle()} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /Edit both legs together/ }));
    edit('Strike for ce', 'ATM');
    expect(legsOf().map((l) => l.strike)).toEqual([{ strike_type: 'ATM' }, { strike_type: 'ATM' }]);
    expect(legsOf().map((l) => l.id)).toEqual(['ce', 'pe']);
    expect(legsOf().map((l) => l.option_type)).toEqual(['CE', 'PE']);
  });

  it('cannot link legs that are not a pair', () => {
    render(
      <Harness initial={[leg({ id: 'ce' }), leg({ id: 'pe', option_type: 'PE', lots: 2 })]} />,
    );
    expect(
      (screen.getByRole('checkbox', { name: /Edit both legs together/ }) as HTMLInputElement)
        .disabled,
    ).toBe(true);
  });

  it('turns a cell off with an empty value, and refuses nonsense', () => {
    render(<Harness initial={strangle()} />);
    edit('Stop for ce', '');
    expect(legsOf()[0]?.stop_loss).toBeUndefined();
    edit('Strike for ce', 'banana');
    expect(screen.getByRole('alert').textContent).toContain('ATM');
    expect(legsOf()[0]?.strike).toEqual({ strike_type: 'OTM1' }); // unchanged
  });

  it('switches a leg between sell and buy', () => {
    render(<Harness initial={strangle()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Side for ce: sell/ }));
    expect(legsOf().map((l) => l.position)).toEqual(['buy', 'sell']);
  });

  it('requires lots to be a whole number of one or more', () => {
    render(<Harness initial={strangle()} />);
    edit('Lots for ce', '0');
    expect(screen.getByRole('alert').textContent).toContain('whole number');
    fireEvent.change(screen.getByRole('textbox', { name: 'Lots for ce' }), {
      target: { value: '3' },
    });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Lots for ce' }), { key: 'Enter' });
    expect(legsOf()[0]?.lots).toBe(3);
  });

  it('adds a leg or a CE + PE pair, copies and removes', () => {
    render(<Harness initial={strangle()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add leg' }));
    expect(legsOf()).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Add CE + PE pair' }));
    expect(legsOf()).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: 'Copy ce' }));
    expect(legsOf()).toHaveLength(6);
    fireEvent.click(screen.getByRole('button', { name: 'Remove pe' }));
    expect(legsOf().map((l) => l.id)).not.toContain('pe');
  });

  it("flags a leg's problems and opens its full settings", () => {
    const onDetails = vi.fn();
    const issues: PlacedIssues = {
      bySlot: { 'legs.0.stop_loss': ['Stop loss must be above 0'] },
      byLeg: { 0: 1 },
      unplaced: [],
      count: 1,
    };
    render(<Harness initial={strangle()} issues={issues} onDetails={onDetails} />);
    const stop = screen.getByRole('button', { name: 'Stop for ce: 115%' });
    expect(stop.getAttribute('aria-invalid')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /All settings for ce, 1 problem/ }));
    expect(onDetails).toHaveBeenCalledWith(0);
  });

  it('marks a range breakout on the row', () => {
    render(
      <Harness
        initial={[leg({ range_breakout: { until: '09:45', side: 'high', source: 'instrument' } })]}
      />,
    );
    expect(screen.getByText('RB 09:45')).toBeTruthy();
  });
});

describe('StrategyTokens', () => {
  function Harness({ initial = newStrategy('NIFTY') }: { initial?: LegwiseStrategy }) {
    const [s, setS] = useState(initial);
    return (
      <>
        <StrategyTokens strategy={s} slots={{}} onChange={setS} />
        <output data-testid="s">{JSON.stringify(s)}</output>
      </>
    );
  }
  const read = () => JSON.parse(screen.getByTestId('s').textContent ?? '{}') as LegwiseStrategy;
  function edit(name: string, text: string) {
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${name}:`) }));
    const input = screen.getByRole('textbox', { name });
    fireEvent.change(input, { target: { value: text } });
    fireEvent.keyDown(input, { key: 'Enter' });
  }

  it('edits the times, accepting 9:20 as 09:20 and refusing 25:00', () => {
    render(<Harness />);
    edit('Entry time', '9:20');
    expect(read().entry_time).toBe('09:20');
    fireEvent.click(screen.getByRole('button', { name: /^Exit time:/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Exit time' }), {
      target: { value: '25:00' },
    });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Exit time' }), { key: 'Enter' });
    expect(screen.getByRole('alert').textContent).toContain('HH:MM');
    expect(read().exit_time).toBe('15:15');
  });

  it('sets and clears the overall loss and profit', () => {
    render(<Harness />);
    edit('Overall max loss in rupees', '₹2,500');
    expect(read().overall.stop_loss_inr).toBe(2500);
    edit('Overall max profit in rupees', '5000');
    expect(read().overall.target_inr).toBe(5000);
    edit('Overall max loss in rupees', '');
    expect(read().overall.stop_loss_inr).toBeUndefined();
  });

  it('changes what a stopped leg does and the index', () => {
    render(<Harness />);
    fireEvent.change(screen.getByRole('combobox', { name: 'When a leg stops out' }), {
      target: { value: 'complete' },
    });
    expect(read().square_off).toBe('complete');
    fireEvent.change(screen.getByRole('combobox', { name: 'Index' }), {
      target: { value: 'SENSEX' },
    });
    expect(read().underlying).toBe('SENSEX');
  });

  it('keeps costs and the last entry out of the row until asked, then until set', () => {
    render(<Harness />);
    expect(screen.queryByRole('button', { name: /^Slippage percent:/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /more: costs, last entry/ }));
    edit('Slippage percent', '0.5');
    expect(read().execution.slippage_pct).toBe(0.5);
    edit('No re-entry after', '13:00');
    expect(read().no_reentry_after).toBe('13:00');
    edit('No re-entry after', '');
    expect('no_reentry_after' in read()).toBe(false);
  });

  it('shows costs straight away when the strategy already has them', () => {
    const s = {
      ...newStrategy('NIFTY'),
      execution: { slippage_pct: 0.25, cost_per_order_inr: 20 },
    };
    render(<Harness initial={s} />);
    expect(screen.getByRole('button', { name: 'Slippage percent: 0.25' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cost per order in rupees: 20' })).toBeTruthy();
  });
});

describe('token parsers', () => {
  it('reads times and rupee amounts', () => {
    expect(parseTime('9:20')).toEqual({ ok: true, value: '09:20' });
    expect(parseTime('15:30')).toEqual({ ok: true, value: '15:30' });
    for (const bad of ['', '24:00', '9:60', 'abc', '930'])
      expect(parseTime(bad).ok, bad).toBe(false);
    expect(parseRupees('₹2,500')).toEqual({ ok: true, value: 2500 });
    expect(parseRupees('')).toEqual({ ok: true, value: undefined });
    expect(parseRupees('off')).toEqual({ ok: true, value: undefined });
    for (const bad of ['0', '-5', 'abc']) expect(parseRupees(bad).ok, bad).toBe(false);
  });
});

describe('ReadBack', () => {
  it('reads the strategy back and says it is ready', () => {
    render(<ReadBack strategy={newStrategy('NIFTY')} problems={[]} checking={false} />);
    const words = screen.getByRole('region', { name: 'In plain words' });
    expect(within(words).getByText(/Every trading day, enter at 09:20\./)).toBeTruthy();
    expect(screen.getByText('Ready to run')).toBeTruthy();
  });

  it('lists what to fix, and does not claim ready while checking', () => {
    const { rerender } = render(
      <ReadBack
        strategy={newStrategy('NIFTY')}
        problems={['Exit must be after entry']}
        checking={false}
      />,
    );
    expect(screen.getByText('1 thing to fix')).toBeTruthy();
    expect(screen.getByText('Exit must be after entry')).toBeTruthy();
    rerender(<ReadBack strategy={newStrategy('NIFTY')} problems={[]} checking />);
    expect(screen.getByText('Checking…')).toBeTruthy();
    expect(screen.queryByText('Ready to run')).toBeNull();
  });
});
