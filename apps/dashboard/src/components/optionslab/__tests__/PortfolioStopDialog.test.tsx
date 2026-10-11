// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTING } from '../../../lib/portfolioStop';
import { PortfolioStopButton } from '../PortfolioStopButton';

afterEach(cleanup);

function open(setting = DEFAULT_SETTING) {
  const onChange = vi.fn();
  render(<PortfolioStopButton setting={setting} onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: /Portfolio stop/ }));
  return onChange;
}

describe('PortfolioStopButton and its pop-up', () => {
  it('shows the applied setting on the button', () => {
    render(<PortfolioStopButton setting={DEFAULT_SETTING} onChange={() => {}} />);
    expect(screen.getByRole('button').textContent).toBe('Portfolio stop ₹10,000');
    cleanup();
    render(<PortfolioStopButton setting={{ ...DEFAULT_SETTING, stop: '' }} onChange={() => {}} />);
    expect(screen.getByRole('button').textContent).toBe('Portfolio stop off');
  });

  it('opens with 10,000 and no trailing, and applies a cleared stop as none', () => {
    const onChange = open();
    expect((screen.getByLabelText(/Stop loss/) as HTMLInputElement).value).toBe('10000');
    expect(screen.getByText(/No trailing: the stop stays at -₹10,000/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Stop loss/), { target: { value: '' } });
    expect(screen.getByText(/No portfolio stop/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SETTING, stop: '' });
  });

  it('shows only the fields of the chosen trailing mode and says what it will do', () => {
    open();
    fireEvent.click(screen.getByRole('radio', { name: 'Trail SL' }));
    fireEvent.change(screen.getByLabelText(/Every profit of/), { target: { value: '1000' } });
    fireEvent.change(screen.getByLabelText(/Move the stop/), { target: { value: '500' } });
    expect(screen.getByText(/after \+₹1,000 it is -₹9,500/)).toBeTruthy();
    expect(screen.queryByLabelText(/When profit reaches/)).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Lock and trail' }));
    expect(screen.getByLabelText(/When profit reaches/)).toBeTruthy();
    expect(screen.getByLabelText(/Raise the level/)).toBeTruthy();
  });

  it('refuses an incomplete trailing setting and keeps the dialog open', () => {
    const onChange = open();
    fireEvent.click(screen.getByRole('radio', { name: 'Lock profit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/Enter the profit that arms the lock/);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('applies a complete lock with no stop loss', () => {
    const onChange = open();
    fireEvent.change(screen.getByLabelText(/Stop loss/), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Lock profit' }));
    fireEvent.change(screen.getByLabelText(/When profit reaches/), { target: { value: '2000' } });
    fireEvent.change(screen.getByLabelText(/^.*Lock/), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onChange).toHaveBeenCalledWith({
      ...DEFAULT_SETTING,
      stop: '0',
      mode: 'lock',
      a: '2000',
      b: '500',
    });
  });

  it('resets the draft to the default', () => {
    open({ ...DEFAULT_SETTING, stop: '8000', mode: 'sl', x: '1000', y: '500' });
    fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }));
    expect((screen.getByLabelText(/Stop loss/) as HTMLInputElement).value).toBe('10000');
    expect(screen.getByText(/No trailing/)).toBeTruthy();
  });
});
