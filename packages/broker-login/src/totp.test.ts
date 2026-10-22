import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { angelTotp, generateTotp, resetAngelTotpWindow, totpWindow } from './totp.js';

const SEED = 'JBSWY3DPEHPK3PXP';
// 10 s into a 30-second window, so freshTotp itself never waits.
const START = 1_800_000_000_000 + 10_000;

describe('angelTotp', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['Date', 'setTimeout'], now: START });
    resetAngelTotpWindow();
  });
  afterEach(() => mock.timers.reset());

  it('the first code of a run is today’s code, with no wait', async () => {
    assert.equal(await angelTotp(SEED), generateTotp(SEED, START));
  });

  it('a second Angel One login in the same window waits for the next one', async () => {
    const first = await angelTotp(SEED);
    const firstWindow = totpWindow();

    let second: string | null = null;
    const pending = angelTotp(SEED).then((code) => {
      second = code;
    });
    await Promise.resolve();
    mock.timers.tick(10_000);
    await Promise.resolve();
    assert.equal(second, null, 'must not reuse the window it already typed a code from');

    mock.timers.tick(11_000); // past the 20 s left in the window (+0.5 s margin)
    await pending;
    assert.equal(totpWindow(), firstWindow + 1);
    assert.equal(second, generateTotp(SEED, Date.now()));
    assert.notEqual(second, first);
  });

  it('a later window needs no wait', async () => {
    await angelTotp(SEED);
    mock.timers.tick(30_000);
    assert.equal(await angelTotp(SEED), generateTotp(SEED, START + 30_000));
  });
});
