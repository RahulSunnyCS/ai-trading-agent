// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
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

  it('gives focus back to the button that opened it', async () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Change
          </button>
          <Drawer open={open} onOpenChange={setOpen} title="Settings">
            <p>Body</p>
          </Drawer>
        </>
      );
    }
    render(<Host />);
    const opener = screen.getByRole('button', { name: 'Change' });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    // Radix hands focus back on the next tick, after the content has unmounted.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Change' })),
    );
  });
});
