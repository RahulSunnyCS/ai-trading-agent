import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS } from '../automation.js';
import { History } from '../history.js';
import { JOBS, type Job } from '../jobs.js';
import {
  PAUSE_JOBS,
  nextSession,
  pauseNotice,
  pausedReason,
  sessionFor,
  settingsFile,
} from '../pause.js';
import { runJob } from '../runner.js';
import { STOP_HELD_JOBS } from '../stop-hold.js';
import { morningSummary } from '../summary.js';

const ist = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+05:30`);

describe('pause (BL-140 Phase 4)', () => {
  let dir: string;
  let env: Record<string, string>;
  const save = (pause: unknown) =>
    writeFileSync(settingsFile(env), JSON.stringify({ version: 2, ...DEFAULT_SETTINGS, pause }));
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pause-'));
    env = { SCHEDULER_STATE_DIR: dir };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('stops exactly the jobs that upload, enable or deploy, never the switch-off or a read', () => {
    for (const id of PAUSE_JOBS) expect(JOBS.some((j) => j.id === id)).toBe(true);
    expect([...PAUSE_JOBS]).toEqual([...STOP_HELD_JOBS]);
    for (const kept of [
      'quantiply-disable',
      'algotest-deploy-check',
      'trade-monitor',
      'live-capture',
      'broker-login',
    ])
      expect(PAUSE_JOBS).not.toContain(kept);
  });

  it('reads the file the jobs read, in the state dir', () => {
    expect(settingsFile(env)).toBe(join(dir, 'automation-settings.json'));
  });

  it('an evening job is for the next trading session, a morning job for today', () => {
    // Friday 23 Oct 2026: tomorrow is a weekend, so the next session is Monday
    expect(sessionFor('algotest-evening', '2026-10-23')).toBe('2026-10-26');
    expect(sessionFor('quantiply-evening', '2026-10-21')).toBe('2026-10-22');
    expect(sessionFor('quantiply-deploy', '2026-10-21')).toBe('2026-10-22');
    expect(sessionFor('algotest-topup', '2026-10-23')).toBe('2026-10-23');
    expect(sessionFor('algotest-deploy', '2026-10-23')).toBe('2026-10-23');
  });

  it('no file or no pause holds nothing', () => {
    expect(pausedReason('algotest-evening', env, ist('2026-10-23', '16:40'))).toBeNull();
    save({ until: null });
    expect(pausedReason('algotest-evening', env, ist('2026-10-23', '16:40'))).toBeNull();
  });

  it('a pause covers every session up to its last day, inclusive', () => {
    save({ until: '2026-10-26' }); // through Monday
    // Friday's evening upload prepares Monday: held
    expect(pausedReason('algotest-evening', env, ist('2026-10-23', '16:40'))).toContain(
      'paused until 2026-10-26',
    );
    // Friday's own morning top-up is for Friday, also inside the pause: held
    expect(pausedReason('algotest-topup', env, ist('2026-10-23', '09:18'))).not.toBeNull();
    // Monday morning's deploy is for Monday: held
    expect(pausedReason('algotest-deploy', env, ist('2026-10-26', '09:16'))).not.toBeNull();
    // Monday's evening prepares Tuesday: runs
    expect(pausedReason('quantiply-evening', env, ist('2026-10-26', '16:45'))).toBeNull();
    expect(pausedReason('quantiply-deploy', env, ist('2026-10-26', '16:55'))).toBeNull();
  });

  it('a pause ending on a day leaves the evening before the next session running', () => {
    save({ until: '2026-10-22' }); // through Thursday
    expect(pausedReason('quantiply-topup', env, ist('2026-10-22', '09:19'))).not.toBeNull();
    // Thursday evening prepares Friday, after the pause: runs
    expect(pausedReason('algotest-evening', env, ist('2026-10-22', '16:40'))).toBeNull();
    expect(pausedReason('algotest-topup', env, ist('2026-10-23', '09:18'))).toBeNull();
  });

  it('never holds the switch-off or a read-only job', () => {
    save({ until: '2099-01-01' });
    for (const id of ['quantiply-disable', 'algotest-deploy-check', 'trade-monitor'])
      expect(pausedReason(id, env, ist('2026-10-23', '15:40'))).toBeNull();
  });

  it('settings that cannot be read hold the job and say so, never fail open', () => {
    writeFileSync(settingsFile(env), 'not json');
    expect(pausedReason('algotest-evening', env, ist('2026-10-23', '16:40'))).toContain(
      'cannot be read',
    );
    save({ until: 'soon' });
    expect(pausedReason('quantiply-topup', env, ist('2026-10-23', '09:19'))).toContain(
      'cannot be read',
    );
    expect(pausedReason('quantiply-disable', env, ist('2026-10-23', '15:40'))).toBeNull();
  });

  it('a settings file saved before Phase 4 (no pause field) is no pause', () => {
    const v1 = JSON.parse(
      readFileSync(
        join(
          import.meta.dir,
          '../../../../packages/broker-login/src/fixtures/automation-settings-v1.json',
        ),
        'utf8',
      ),
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(settingsFile(env), JSON.stringify(v1));
    expect(pausedReason('algotest-evening', env, ist('2026-10-23', '16:40'))).toBeNull();
    expect(pauseNotice(env, ist('2026-10-23', '09:00'))).toBeNull();
  });

  it('the morning notice names a pause that still covers today or later', () => {
    save({ until: '2026-10-26' });
    expect(pauseNotice(env, ist('2026-10-23', '09:00'))).toBe('2026-10-26');
    expect(pauseNotice(env, ist('2026-10-26', '09:00'))).toBe('2026-10-26');
    expect(pauseNotice(env, ist('2026-10-27', '09:00'))).toBeNull();
  });

  it('the next session is today until the last morning job has had its time, else the next trading day', () => {
    expect(nextSession(ist('2026-10-23', '08:00'))).toBe('2026-10-23');
    expect(nextSession(ist('2026-10-23', '09:21'))).toBe('2026-10-23');
    expect(nextSession(ist('2026-10-23', '09:22'))).toBe('2026-10-26'); // Friday: Monday next
    expect(nextSession(ist('2026-10-24', '10:00'))).toBe('2026-10-26'); // a Saturday
    expect(nextSession(ist('2026-10-26', '16:50'))).toBe('2026-10-27');
  });

  it('runJob records a paused job as held, whoever started it, and runs nothing', async () => {
    save({ until: '2099-01-01' });
    const marker = join(dir, 'ran');
    const job: Job = {
      id: 'algotest-evening',
      description: 'x',
      schedule: { at: '16:40', on: () => true, label: '' },
      steps: [['/bin/sh', '-c', `touch ${marker}`]],
      cwd: '.',
      timeoutMinutes: 1,
      retries: 0,
      retryDelayMinutes: 0,
      catchUpHours: 0,
      fixHint: '',
    };
    const history = new History(':memory:');
    try {
      const ctx = {
        repoRoot: '/',
        env: { ...env, PATH: process.env.PATH ?? '' },
        logDir: dir,
        history,
        jobs: [job],
      };
      for (const trigger of ['schedule', 'manual'] as const) {
        const r = await runJob(job, ctx, trigger);
        expect(r.ok).toBe(true);
        expect(r.attempts).toBe(0);
        expect(r.error).toContain('paused until 2099-01-01');
      }
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      history.close();
    }
  });

  it('the 09:00 summary says a pause is on, as a notice and not a problem', async () => {
    save({ until: '2099-01-01' });
    const history = new History(':memory:');
    const sent: string[] = [];
    try {
      await morningSummary(
        async (text) => {
          sent.push(text);
        },
        () => [],
      )({
        repoRoot: '/',
        env,
        logDir: dir,
        history,
        now: () => ist('2026-10-23', '09:00'),
        log: () => {},
      } as never);
    } finally {
      history.close();
    }
    expect(sent[0]).toContain('✅ Paused: no uploads or deploys until 2099-01-01');
  });
});
