// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NumberField, parseDraft, settleDraft } from '../Input';
import { SegmentedControl, nextEnabled } from '../SegmentedControl';

afterEach(cleanup);

describe('NumberField drafts', () => {
  it('parseDraft commits only complete, in-range numbers', () => {
    expect(parseDraft('12')).toBe(12);
    expect(parseDraft('1.5')).toBe(1.5);
    expect(parseDraft('')).toBeNull();
    expect(parseDraft('-')).toBeNull();
    expect(parseDraft('abc')).toBeNull();
    expect(parseDraft('0', 1, 20)).toBeNull();
    expect(parseDraft('21', 1, 20)).toBeNull();
    expect(parseDraft('20', 1, 20)).toBe(20);
  });

  it('settleDraft clamps, and falls back when the draft is empty', () => {
    expect(settleDraft('', 5, 1, 20)).toBe(5);
    expect(settleDraft('abc', 5, 1, 20)).toBe(5);
    expect(settleDraft('0', 5, 1, 20)).toBe(1);
    expect(settleDraft('99', 5, 1, 20)).toBe(20);
    expect(settleDraft('7', 5, 1, 20)).toBe(7);
  });

  function Harness({ onChange }: { onChange: (value: number) => void }) {
    const [value, setValue] = useState(5);
    return (
      <NumberField
        aria-label="lots"
        value={value}
        min={1}
        max={20}
        onChange={(next) => {
          onChange(next);
          setValue(next);
        }}
      />
    );
  }

  it('clearing the field does not commit 0, and blur restores the last value', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = screen.getByLabelText('lots') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    expect(input.value).toBe('');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(input.value).toBe('5');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('commits a valid value as it is typed and clamps an out-of-range one on blur', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = screen.getByLabelText('lots') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '12' } });
    expect(onChange).toHaveBeenLastCalledWith(12);
    fireEvent.change(input, { target: { value: '99' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith(20);
    expect(input.value).toBe('20');
  });
});

describe('SegmentedControl keyboard', () => {
  const options = [
    { value: 'a', label: 'A' },
    { value: 'b', label: 'B', disabled: true },
    { value: 'c', label: 'C' },
  ] as const;

  it('nextEnabled skips disabled options and wraps', () => {
    expect(nextEnabled(options, 0, 1)).toBe(2);
    expect(nextEnabled(options, 2, 1)).toBe(0);
    expect(nextEnabled(options, 0, -1)).toBe(2);
  });

  function Harness() {
    const [value, setValue] = useState<'a' | 'b' | 'c'>('a');
    return (
      <SegmentedControl ariaLabel="Pick" value={value} options={options} onChange={setValue} />
    );
  }

  it('is a radiogroup with one tab stop on the checked option', () => {
    render(<Harness />);
    expect(screen.getByRole('radiogroup', { name: 'Pick' })).toBeTruthy();
    const radios = screen.getAllByRole('radio');
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'false',
    ]);
    expect(radios.map((radio) => radio.tabIndex)).toEqual([0, -1, -1]);
  });

  it('arrow keys move the selection past a disabled option; Home returns', () => {
    render(<Harness />);
    const [a, , c] = screen.getAllByRole('radio') as [HTMLElement, HTMLElement, HTMLElement];
    fireEvent.keyDown(a, { key: 'ArrowRight' });
    expect(c.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(c);
    fireEvent.keyDown(c, { key: 'Home' });
    expect(a.getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(a, { key: 'ArrowLeft' });
    expect(c.getAttribute('aria-checked')).toBe('true');
  });
});
