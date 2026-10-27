import { describe, expect, it } from 'vitest';

import {
  firstSentence,
  needsConfirmation,
  runDurationMs,
  runNowError,
  runStatus,
} from '../scheduler';
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

describe('firstSentence', () => {
  it('cuts a job description after its first sentence', () => {
    expect(
      firstSentence(
        'The morning broker login, on the Mac (BL-172): what Settings › Automation logs in (AlgoTest brokers from 08:16, Quantiply · Angel One and · Shoonya at once), credentials from the repo .env. A part that fails is handed to GitHub.',
      ),
    ).toBe(
      'The morning broker login, on the Mac (BL-172): what Settings › Automation logs in (AlgoTest brokers from 08:16, Quantiply · Angel One and · Shoonya at once), credentials from the repo .env.',
    );
    expect(firstSentence('Deploy the picks. Built ready but OFF: does nothing.')).toBe(
      'Deploy the picks.',
    );
  });

  it('keeps a description with one sentence, or no full stop, whole', () => {
    expect(firstSentence('Momentum weekly final signal')).toBe('Momentum weekly final signal');
    expect(firstSentence('Copy the database.')).toBe('Copy the database.');
  });

  it('does not split inside brackets or before a lower-case word', () => {
    expect(firstSentence('Check (one. Two) things, e.g. this one. Next part')).toBe(
      'Check (one. Two) things, e.g. this one.',
    );
  });
});
