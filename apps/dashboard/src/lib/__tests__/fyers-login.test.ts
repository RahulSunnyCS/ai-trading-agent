// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { startFyersLogin } from '../fyers-login';

describe('startFyersLogin', () => {
  afterEach(() => vi.restoreAllMocks());

  it('opens the server OAuth redirect without putting a secret in the browser URL', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    startFyersLogin();
    expect(open).toHaveBeenCalledWith('/api/auth/fyers/start', '_blank', 'noopener,noreferrer');
  });
});
