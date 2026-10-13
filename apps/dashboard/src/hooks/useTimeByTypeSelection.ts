'use client';

import { useMemo } from 'react';

import type { TimeByTypeInput } from '../lib/heatmapTimeByTypeView';
import { useQueryState } from './useQueryState';

/**
 * The "Entry time by strategy type" chart's date selection, kept in the URL query beside the
 * straddle table's own keys (`view`, `date`, `from`, `to`, ...; these all start with `tt` so the
 * two never clash): `?ttp=last21`, `?ttd=2026-10-09`, or `?ttf=2026-09-01&ttt=2026-09-30`.
 * All absent is the latest scored session.
 */
export function useTimeByTypeSelection() {
  const [preset, setPreset] = useQueryState('ttp');
  const [day, setDay] = useQueryState('ttd');
  const [from, setFrom] = useQueryState('ttf');
  const [to, setTo] = useQueryState('ttt');

  const input: TimeByTypeInput = useMemo(
    () => ({ preset, day, from, to }),
    [preset, day, from, to],
  );

  return {
    input,
    /** A preset replaces any day or range; the default (latest) is the absent key. */
    pickPreset: (value: string) => {
      setPreset(value === 'latest' ? null : value);
      setDay(null);
      setFrom(null);
      setTo(null);
    },
    pickDay: (value: string) => {
      setPreset(null);
      setFrom(null);
      setTo(null);
      setDay(value || null);
    },
    pickRange: (next: { from?: string; to?: string }) => {
      setPreset(null);
      setDay(null);
      if (next.from !== undefined) setFrom(next.from || null);
      if (next.to !== undefined) setTo(next.to || null);
    },
  };
}
