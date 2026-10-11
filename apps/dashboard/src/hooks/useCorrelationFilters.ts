'use client';

import { useCallback, useMemo } from 'react';

import { ANY, type CorrelationFilters, DEFAULT_FILTERS } from '../lib/correlationView';
import type { CorrelationMeasure } from '../types/legwise';
import { useQueryState } from './useQueryState';

const MEASURES: readonly CorrelationMeasure[] = ['pearson', 'spearman', 'loss'];

/**
 * What Options Lab › Correlation is showing, kept in the URL query so a link or a refresh lands
 * on the same comparison: `?slot=0917&family=wide&index=N&kind=legwise&names=a,b&from=…&to=…`.
 * An absent key is its default (09:17 for the slot, "any" for the rest), so the bare page is the
 * 09:17 strategies; "any slot" is stored as `slot=any`.
 */
export function useCorrelationFilters() {
  const [slot, setSlot] = useQueryState('slot');
  const [family, setFamily] = useQueryState('family');
  const [index, setIndex] = useQueryState('index');
  const [kind, setKind] = useQueryState('kind');
  const [names, setNames] = useQueryState('names');
  const [from, setFrom] = useQueryState('from');
  const [to, setTo] = useQueryState('to');
  const [measure, setMeasure] = useQueryState('measure');

  const filters: CorrelationFilters = useMemo(
    () => ({
      slot: slot ?? DEFAULT_FILTERS.slot,
      family: family ?? ANY,
      index: index ?? ANY,
      kind: kind ?? ANY,
      names: names ? names.split(',').filter(Boolean) : [],
    }),
    [slot, family, index, kind, names],
  );

  const setFilters = useCallback(
    (patch: Partial<CorrelationFilters>) => {
      if (patch.slot !== undefined)
        setSlot(patch.slot === DEFAULT_FILTERS.slot ? null : patch.slot);
      if (patch.family !== undefined) setFamily(patch.family === ANY ? null : patch.family);
      if (patch.index !== undefined) setIndex(patch.index === ANY ? null : patch.index);
      if (patch.kind !== undefined) setKind(patch.kind === ANY ? null : patch.kind);
      if (patch.names !== undefined) setNames(patch.names.length ? patch.names.join(',') : null);
    },
    [setSlot, setFamily, setIndex, setKind, setNames],
  );

  const picked = MEASURES.find((m) => m === measure) ?? 'pearson';
  return {
    filters,
    setFilters,
    range: { from: from ?? undefined, to: to ?? undefined },
    setRange: (next: { from?: string | null; to?: string | null }) => {
      if (next.from !== undefined) setFrom(next.from || null);
      if (next.to !== undefined) setTo(next.to || null);
    },
    measure: picked,
    setMeasure: (m: CorrelationMeasure) => setMeasure(m === 'pearson' ? null : m),
  };
}
