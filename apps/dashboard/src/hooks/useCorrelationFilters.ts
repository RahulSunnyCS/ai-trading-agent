'use client';

import { useCallback, useMemo } from 'react';

import {
  ANY,
  type CorrelationFilters,
  DEFAULT_FILTERS,
  DEFAULT_NAMES,
} from '../lib/correlationView';
import type { CorrelationMeasure } from '../types/legwise';
import { useQueryState } from './useQueryState';

const MEASURES: readonly CorrelationMeasure[] = ['pearson', 'spearman', 'loss'];

/**
 * What Options Lab › Correlation is showing, kept in the URL query so a link or a refresh lands
 * on the same comparison: `?slot=0917&family=wide&index=N&kind=legwise&names=a,b&from=…&to=…`.
 * An absent key is its default ("any" for the filters; for `names` the starred favourites, else
 * the three NIFTY 09:17 strategies), so the bare page is those; an emptied list is stored as
 * `names=-`.
 *
 * `favouriteNames` is what the favourites say the bare page opens on: undefined means "use the
 * built-in three" (no favourites to wait for), null means "the favourites have not loaded yet",
 * and `waiting` is then true so the caller can hold its request until they have. An empty list of
 * favourites falls back to the built-in three.
 */
export function useCorrelationFilters(favouriteNames?: readonly string[] | null) {
  const [slot, setSlot] = useQueryState('slot');
  const [family, setFamily] = useQueryState('family');
  const [index, setIndex] = useQueryState('index');
  const [kind, setKind] = useQueryState('kind');
  const [names, setNames] = useQueryState('names');
  const [from, setFrom] = useQueryState('from');
  const [to, setTo] = useQueryState('to');
  const [measure, setMeasure] = useQueryState('measure');

  const defaultNames: readonly string[] =
    favouriteNames && favouriteNames.length > 0 ? favouriteNames : DEFAULT_NAMES;
  const waiting = names === null && favouriteNames === null;

  const filters: CorrelationFilters = useMemo(
    () => ({
      slot: slot ?? DEFAULT_FILTERS.slot,
      family: family ?? ANY,
      index: index ?? ANY,
      kind: kind ?? ANY,
      names:
        names === null ? [...defaultNames] : names === '-' ? [] : names.split(',').filter(Boolean),
    }),
    [slot, family, index, kind, names, defaultNames],
  );

  const setFilters = useCallback(
    (patch: Partial<CorrelationFilters>) => {
      if (patch.slot !== undefined)
        setSlot(patch.slot === DEFAULT_FILTERS.slot ? null : patch.slot);
      if (patch.family !== undefined) setFamily(patch.family === ANY ? null : patch.family);
      if (patch.index !== undefined) setIndex(patch.index === ANY ? null : patch.index);
      if (patch.kind !== undefined) setKind(patch.kind === ANY ? null : patch.kind);
      if (patch.names !== undefined) {
        const same =
          patch.names.length === defaultNames.length &&
          patch.names.every((n, i) => n === defaultNames[i]);
        setNames(same ? null : patch.names.length ? patch.names.join(',') : '-');
      }
    },
    [setSlot, setFamily, setIndex, setKind, setNames, defaultNames],
  );

  const picked = MEASURES.find((m) => m === measure) ?? 'pearson';
  return {
    filters,
    setFilters,
    /** True while the bare page is waiting for the favourites it opens on. */
    waiting,
    /** True when the names are the page's own defaults (no `?names=` in the address). */
    usingDefaults: names === null,
    /** What the bare page opens on, for a "Reset to favourites" action. */
    defaultNames,
    range: { from: from ?? undefined, to: to ?? undefined },
    setRange: (next: { from?: string | null; to?: string | null }) => {
      if (next.from !== undefined) setFrom(next.from || null);
      if (next.to !== undefined) setTo(next.to || null);
    },
    measure: picked,
    setMeasure: (m: CorrelationMeasure) => setMeasure(m === 'pearson' ? null : m),
  };
}
