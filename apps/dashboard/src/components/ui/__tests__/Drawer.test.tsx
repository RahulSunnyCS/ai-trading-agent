// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Drawer } from '../Drawer';

afterEach(cleanup);

function setup(open = true) {
  const onOpenChange = vi.fn();
  render(
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title="Strategy settings"
      subtitle="ETF Rotation · dataset defaults"
      closeLabel="Close settings"
      actions={<button type="button">Defaults</button>}
      footer={<div>Run bar</div>}
    >
      <p>Body text</p>
    </Drawer>,
  );
  return onOpenChange;
}

describe('Drawer', () => {
  it('shows the title, subtitle, actions, body and footer', () => {
    setup();
    expect(screen.getByRole('dialog', { name: 'Strategy settings' })).toBeTruthy();
    expect(screen.getByText('ETF Rotation · dataset defaults')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Defaults' })).toBeTruthy();
    expect(screen.getByText('Body text')).toBeTruthy();
    expect(screen.getByText('Run bar')).toBeTruthy();
  });

  it('renders nothing while closed', () => {
    setup(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes from its labelled close button', () => {
    const onOpenChange = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('closes on Escape', () => {
    const onOpenChange = setup();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
