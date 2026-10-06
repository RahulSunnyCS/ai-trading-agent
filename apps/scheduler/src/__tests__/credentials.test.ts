import { describe, expect, it } from 'bun:test';
import { checkGhAuth, firstOfJanuary, jobs, rotationReminder } from '../checks/credentials.js';
import { previousDue } from '../schedule.js';

describe('checkGhAuth', () => {
  it('passes when gh auth status succeeds, and runs exactly that command', () => {
    const calls: string[][] = [];
    const r = checkGhAuth((cmd, args) => {
      calls.push([cmd, ...args]);
      return { code: 0, output: 'Logged in' };
    });
    expect(r.ok).toBe(true);
    expect(calls).toEqual([['gh', 'auth', 'status']]);
  });

  it('fails with the first line of gh output when logged out', () => {
    const r = checkGhAuth(() => ({
      code: 1,
      output: 'You are not logged into any GitHub hosts.\nTo log in, run: gh auth login',
    }));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('not logged into any GitHub hosts');
  });

  it('fails when gh is missing', () => {
    expect(checkGhAuth(() => ({ code: 127, output: 'spawn gh ENOENT' })).ok).toBe(false);
  });
});

describe('rotation reminder', () => {
  it('fails on 1 January only', () => {
    expect(rotationReminder('2027-01-01').ok).toBe(false);
    expect(rotationReminder('2027-01-01').detail).toContain('docs/credentials.md');
    expect(rotationReminder('2027-01-02').ok).toBe(true);
    expect(firstOfJanuary('2027-06-01')).toBe(false);
  });

  it('is scheduled for 1 January even though it is a holiday', () => {
    const job = jobs.find((j) => j.id === 'credential-rotation-reminder');
    if (!job) throw new Error('missing job');
    const due = previousDue(job.schedule, new Date('2027-03-01T00:00:00Z'));
    expect(due?.toISOString()).toBe('2027-01-01T03:06:00.000Z');
  });
});
