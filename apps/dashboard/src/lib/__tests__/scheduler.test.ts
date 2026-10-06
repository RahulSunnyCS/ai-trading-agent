import { describe, expect, it } from 'vitest';

import { needsConfirmation, runDurationMs, runNowError, runStatus } from '../scheduler';
import type { SchedulerRun } from '../scheduler';

const run = (patch: Partial<SchedulerRun> = {}): SchedulerRun => ({
  id: 1,
  job: 'x',
  trigger: 'manual',
  scheduled_for: null,
  started_at: '2026-10-07T10:00:00.000Z',
  ended_at: '2026-10-07T10:00:42.000Z',
  exit_code: 0,
  attempts: 1,
  error: null,
  ...patch,
});

describe('scheduler helpers', () => {
  it('reads a run as running, completed or failed', () => {
    expect(runStatus(null)).toBeNull();
    expect(runStatus(run({ ended_at: null, exit_code: null }))).toBe('running');
    expect(runStatus(run())).toBe('completed');
    expect(runStatus(run({ exit_code: 2 }))).toBe('failed');
  });

  it('measures a finished run only', () => {
    expect(runDurationMs(run())).toBe(42_000);
    expect(runDurationMs(run({ ended_at: null }))).toBeNull();
    expect(runDurationMs(null)).toBeNull();
  });

  it('asks before jobs that need the laptop session', () => {
    expect(needsConfirmation({ needs: ['home'] })).toBe(true);
    expect(needsConfirmation({ needs: ['postgres', 'gui'] })).toBe(true);
    expect(needsConfirmation({ needs: ['postgres'] })).toBe(false);
    expect(needsConfirmation({ needs: [] })).toBe(false);
  });

  it('words a busy job kindly', () => {
    expect(runNowError(409, 'x still running')).toContain('Not started');
    expect(runNowError(404, 'unknown')).toContain('does not know');
    expect(runNowError(undefined, 'boom')).toContain('boom');
  });
});
