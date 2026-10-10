// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ANY, DEFAULT_FILTERS, type MatrixFilters } from '../../../lib/rotationMatrixView';
import type { MatrixMeta } from '../../../types/rotationMatrix';
import { RotationMatrixControls } from '../RotationMatrixControls';

const meta = {
  slots: ['0917', '0932', '0947', '1002', '1017'],
  families: [],
  weekdays: ['Mon'],
  dte: [],
  vix_bands: [],
  store: { variants: 5, first: null, last: null, sessions: 0, days_without_attributes: [] },
  lists: { A: '', B: '', C: '', REF: '' },
  journal: { available: false, reason: null, on_time: 0, late: 0 },
} as unknown as MatrixMeta;

function startTime(): HTMLSelectElement {
  return screen.getByLabelText('Start time') as HTMLSelectElement;
}

function optionTexts(el: HTMLSelectElement): string[] {
  return Array.from(el.options).map((o) => o.text);
}

afterEach(cleanup);

describe('RotationMatrixControls: Start time', () => {
  it('shows a start band opened from the Family pulse as one range option', () => {
    const f: MatrixFilters = {
      ...DEFAULT_FILTERS,
      view: 'pulse',
      family: 'widesl',
      slot: '0917,0932,0947,1002',
    };
    render(<RotationMatrixControls filters={f} set={vi.fn()} meta={meta} />);
    const select = startTime();
    expect(select.value).toBe('0917,0932,0947,1002');
    expect(select.options[select.selectedIndex]?.text).toBe('09:17 to 10:02 (4 start times)');
    // the single start times are still offered
    expect(optionTexts(select)).toContain('09:17');
  });

  it('has no range option for a single start time or none', () => {
    render(
      <RotationMatrixControls
        filters={{ ...DEFAULT_FILTERS, slot: '0932' }}
        set={vi.fn()}
        meta={meta}
      />,
    );
    expect(optionTexts(startTime()).some((t) => t.includes('start times'))).toBe(false);
    cleanup();
    render(<RotationMatrixControls filters={DEFAULT_FILTERS} set={vi.fn()} meta={meta} />);
    expect(startTime().value).toBe(ANY);
    expect(optionTexts(startTime()).some((t) => t.includes('start times'))).toBe(false);
  });

  it('choosing Any start time clears the band', () => {
    const set = vi.fn();
    const f: MatrixFilters = { ...DEFAULT_FILTERS, slot: '1017,1032,1047' };
    render(<RotationMatrixControls filters={f} set={set} meta={meta} />);
    fireEvent.change(startTime(), { target: { value: ANY } });
    expect(set).toHaveBeenCalledWith({ slot: ANY });
  });
});
