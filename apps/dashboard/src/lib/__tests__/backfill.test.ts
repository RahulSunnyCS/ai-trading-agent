import { describe, expect, it } from 'vitest';

import type { BackfillStatus } from '../../types/trading';
import { REPLAYABLE_BY_STATUS, isReplayable } from '../backfill';

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
