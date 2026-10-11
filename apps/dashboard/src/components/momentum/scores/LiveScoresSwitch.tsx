'use client';

import { useEffect } from 'react';

import { useNow } from '../../../hooks/useNow';
import { isLiveScoresWindow } from '../../../lib/market';
import { SegmentedControl } from '../../ui/SegmentedControl';

/**
 * The Scores page's "Closing | Live" switch (BL-051), shown only on Fridays 09:15–15:30 IST.
 * Owns the clock, so the page itself re-renders only when the window opens or closes.
 */
export function LiveScoresSwitch({
  live,
  onLive,
  onWindow,
}: {
  live: boolean;
  onLive: (live: boolean) => void;
  onWindow: (open: boolean) => void;
}) {
  const now = useNow(60_000);
  const open = now !== null && isLiveScoresWindow(now);
  useEffect(() => onWindow(open), [open, onWindow]);
  if (!open) return null;
  return (
    <SegmentedControl
      ariaLabel="Score prices"
      size="sm"
      value={live ? 'live' : 'close'}
      options={[
        { value: 'close', label: 'Last close' },
        { value: 'live', label: 'Live (provisional)' },
      ]}
      onChange={(next) => onLive(next === 'live')}
    />
  );
}
