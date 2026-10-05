import { describe, expect, it } from 'vitest';

import type { BackfillStatus } from '../../types/trading';
import {
  BACKFILL_RESOLUTIONS,
  BACKFILL_SYMBOLS,
  REPLAYABLE_BY_STATUS,
  backfillProgress,
  defaultBackfillRange,
  isReplayable,
  replayCommand,
  resolutionLabel,
  rowReplayCommand,
  shiftDay,
  shouldPollBackfill,
  symbolLabel,
  validateBackfillRange,
} from '../backfill';
import { istToday } from '../format';

// Pinned to the status union: adding or renaming a status in types/trading.ts makes this
// object literal fail typecheck until the expectation here is updated.
const EXPECTED = {
  completed: true,
  in_progress: false,
  failed: false,
} satisfies Record<BackfillStatus, boolean>;

describe('isReplayable', () => {
  it.each(Object.entries(EXPECTED) as Array<[BackfillStatus, boolean]>)(
    'status %s -> replayable %s',
    (status, expected) => {
      expect(isReplayable({ status })).toBe(expected);
    },
  );

  it('covers exactly the statuses the API returns', () => {
    expect(Object.keys(REPLAYABLE_BY_STATUS).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it('treats the pre-normalisation names the view used to filter on as not replayable', () => {
    for (const status of ['complete', 'gapped']) {
      expect(isReplayable({ status: status as BackfillStatus })).toBe(false);
    }
  });
});

describe('shouldPollBackfill', () => {
  it('polls while any row is in progress', () => {
    expect(shouldPollBackfill([{ status: 'completed' }, { status: 'in_progress' }], null, 0)).toBe(
      true,
    );
  });

  it('stops once every row has settled and no queued job is being watched', () => {
    expect(shouldPollBackfill([{ status: 'completed' }, { status: 'failed' }], null, 0)).toBe(
      false,
    );
    expect(shouldPollBackfill([], null, 0)).toBe(false);
  });

  it('keeps watching for a just-queued job until the watch window ends', () => {
    expect(shouldPollBackfill([], 10_000, 9_999)).toBe(true);
    expect(shouldPollBackfill([], 10_000, 10_000)).toBe(false);
  });
});

describe('backfillProgress', () => {
  const range = { from_ts: '2026-09-01T00:00:00.000Z', to_ts: '2026-09-11T00:00:00.000Z' };

  it('places the checkpoint between from and to', () => {
    expect(backfillProgress({ ...range, checkpoint_ts: '2026-09-06T00:00:00.000Z' })).toBe(0.5);
  });

  it('clamps a checkpoint outside the range', () => {
    expect(backfillProgress({ ...range, checkpoint_ts: '2026-08-01T00:00:00.000Z' })).toBe(0);
    expect(backfillProgress({ ...range, checkpoint_ts: '2026-10-01T00:00:00.000Z' })).toBe(1);
  });

  it('is null without a usable checkpoint or range', () => {
    expect(backfillProgress({ ...range, checkpoint_ts: null })).toBeNull();
    expect(backfillProgress({ ...range, checkpoint_ts: 'not a date' })).toBeNull();
    expect(
      backfillProgress({
        from_ts: range.to_ts,
        to_ts: range.to_ts,
        checkpoint_ts: range.to_ts,
      }),
    ).toBeNull();
  });
});

describe('backfill form dates', () => {
  it('defaults to the seven days up to yesterday, counted from the IST date', () => {
    // 04 Oct 2026 22:00 UTC is already 05 Oct in IST: the defaults follow IST, not UTC.
    const today = istToday(new Date('2026-10-04T22:00:00Z'));
    expect(today).toBe('2026-10-05');
    expect(defaultBackfillRange(today)).toEqual({ from: '2026-09-28', to: '2026-10-04' });
  });

  it('shifts across month and year ends', () => {
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDay('2026-12-31', 1)).toBe('2027-01-01');
  });

  it.each([
    ['2026-09-01', '2026-09-30', null],
    ['2026-10-05', '2026-10-05', null],
    ['2026-09-30', '2026-09-01', 'From must be on or before To'],
    ['2026-10-01', '2026-10-06', 'To cannot be in the future'],
    ['', '2026-10-01', 'Choose a valid From date'],
    ['2026-09-01', '2026-02-31', 'Choose a valid To date'],
  ])('validates %s -> %s', (from, to, expected) => {
    expect(validateBackfillRange(from, to, '2026-10-05')).toBe(expected);
  });
});

describe('label maps', () => {
  it('labels every symbol and resolution the form offers', () => {
    expect(BACKFILL_SYMBOLS.map(symbolLabel)).toEqual(['NIFTY', 'Sensex']);
    expect(BACKFILL_RESOLUTIONS.map(resolutionLabel)).toEqual([
      '1-min',
      '5-min',
      '15-min',
      'Daily',
      'Weekly',
    ]);
  });

  it('labels other Fyers resolutions a row may carry, and passes unknowns through', () => {
    expect(resolutionLabel('60')).toBe('1-hour');
    expect(resolutionLabel('240')).toBe('4-hour');
    expect(resolutionLabel('M')).toBe('Monthly');
    expect(resolutionLabel('X')).toBe('X');
    expect(symbolLabel('NSE:FOO-INDEX')).toBe('NSE:FOO-INDEX');
  });
});

describe('replay commands', () => {
  it('formats the how-to and a coverage row the same way, with the underlying name', () => {
    const row = {
      symbol: 'NSE:NIFTY50-INDEX',
      from_ts: '2026-09-01T03:45:00.000Z',
      to_ts: '2026-09-26T10:00:00.000Z',
    };
    expect(rowReplayCommand(row)).toBe(
      'bun run replay --from 2026-09-01T03:45:00.000Z --to 2026-09-26T10:00:00.000Z --underlying NIFTY --dry-run',
    );
    expect(
      replayCommand({ from: '<ISO>', to: '<ISO>', underlying: 'NIFTY', mode: 'dry-run' }),
    ).toBe('bun run replay --from <ISO> --to <ISO> --underlying NIFTY --dry-run');
    expect(rowReplayCommand({ ...row, symbol: 'BSE:SENSEX-INDEX' })).toContain(
      '--underlying SENSEX',
    );
  });

  it('has no command for a symbol the replay CLI does not know', () => {
    expect(rowReplayCommand({ symbol: 'NSE:FOO-INDEX', from_ts: 'a', to_ts: 'b' })).toBeNull();
  });
});
