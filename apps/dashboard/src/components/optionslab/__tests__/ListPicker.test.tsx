// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { listWithUniverse } from '../../../lib/rotationListNames';
import { ListPicker } from '../rotation/ListPicker';

afterEach(cleanup);

describe('ListPicker', () => {
  it('renders no control for the one shown list (Adaptive)', () => {
    const { container } = render(
      <ListPicker value="C" onChange={() => undefined} ariaLabel="List" label="Focus" />,
    );
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByText('Focus')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('names the one list as plain text, with its universe, when asked to', () => {
    render(
      <ListPicker
        value="C"
        onChange={() => undefined}
        ariaLabel="Focus list"
        format={listWithUniverse}
        single="text"
      />,
    );
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.getByText('Adaptive · Core (298 variants)')).toBeTruthy();
  });

  it('is a segmented control when it is given more than one list', () => {
    const onChange = vi.fn();
    render(
      <ListPicker value="C" onChange={onChange} ariaLabel="List" keys={['A', 'C']} label="List" />,
    );
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual(['Steady', 'Adaptive']);
    fireEvent.click(screen.getByRole('radio', { name: 'Steady' }));
    expect(onChange).toHaveBeenCalledWith('A');
  });

  it('renders nothing with no list to offer', () => {
    const { container } = render(
      <ListPicker value="C" onChange={() => undefined} ariaLabel="List" keys={[]} single="text" />,
    );
    expect(container.textContent).toBe('');
  });
});
