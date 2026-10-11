'use client';

import { useCallback, useMemo } from 'react';

import {
  ANY,
  DEFAULT_FILTERS,
  DEFAULT_MIN_N,
  type MatrixFilters,
  VIEW_OPTIONS,
  canCompare,
} from '../lib/rotationMatrixView';
import type {
  MatrixBasis,
  MatrixListId,
  MatrixMetric,
  MatrixPeriodId,
  MatrixView,
} from '../types/rotationMatrix';
import { useQueryState } from './useQueryState';

const METRICS: readonly MatrixMetric[] = ['avg', 'win_rate', 'stop_rate', 'worst', 'selection'];
const PERIODS: readonly MatrixPeriodId[] = ['P1', 'P2', 'P3', 'forward', 'custom'];
const LISTS: readonly MatrixListId[] = ['A', 'B', 'C', 'REF'];
const INDICES = ['both', 'NIFTY', 'SENSEX'] as const;

function pick<T extends string>(allowed: readonly T[], value: string | null, fallback: T): T {
  return allowed.find((a) => a === value) ?? fallback;
}

/**
 * What Options Lab › Matrix is showing, kept in the URL query so a link or a refresh lands on the
 * same view: `?view=vix_family&metric=win_rate&cmp=1&index=NIFTY&family=widesl&minn=30`. An
 * absent key is its default (the family x start-time map, average ₹, P1, both indices).
 */
export function useRotationMatrixFilters() {
  const [view, setView] = useQueryState('view');
  const [metric, setMetric] = useQueryState('metric');
  const [period, setPeriod] = useQueryState('period');
  const [cmp, setCmp] = useQueryState('cmp');
  const [from, setFrom] = useQueryState('from');
  const [to, setTo] = useQueryState('to');
  const [index, setIndex] = useQueryState('index');
  const [family, setFamily] = useQueryState('family');
  const [strategy, setStrategy] = useQueryState('strategy');
  const [slot, setSlot] = useQueryState('slot');
  const [weekday, setWeekday] = useQueryState('weekday');
  const [dte, setDte] = useQueryState('dte');
  const [vix, setVix] = useQueryState('vix');
  const [minN, setMinN] = useQueryState('minn');
  const [list, setList] = useQueryState('list');
  const [basis, setBasis] = useQueryState('basis');

  const filters: MatrixFilters = useMemo(() => {
    const v = pick(
      VIEW_OPTIONS.map((o) => o.value),
      view,
      DEFAULT_FILTERS.view,
    ) as MatrixView;
    const n = Number(minN);
    return {
      view: v,
      metric: pick(METRICS, metric, DEFAULT_FILTERS.metric),
      period: pick(PERIODS, period, DEFAULT_FILTERS.period),
      compare: cmp === '1' && canCompare(v),
      from: from ?? '',
      to: to ?? '',
      index: pick(INDICES, index, DEFAULT_FILTERS.index),
      family: family ?? ANY,
      strategy: strategy ?? DEFAULT_FILTERS.strategy,
      slot: slot ?? ANY,
      weekday: weekday ?? ANY,
      dte: dte ?? ANY,
      vix: vix ?? ANY,
      minN: Number.isInteger(n) && n >= 1 && n <= 1000 ? n : DEFAULT_MIN_N,
      list: pick([ANY, ...LISTS] as const, list, ANY),
      basis: pick(['all', 'selected'] as readonly MatrixBasis[], basis, 'all'),
    };
  }, [
    view,
    metric,
    period,
    cmp,
    from,
    to,
    index,
    family,
    strategy,
    slot,
    weekday,
    dte,
    vix,
    minN,
    list,
    basis,
  ]);

  /** Defaults are stored as an absent key, so the bare page is the default view. */
  const set = useCallback(
    (patch: Partial<MatrixFilters>) => {
      const some = <T>(value: T | undefined, base: T, write: (s: string | null) => void) => {
        if (value !== undefined) write(value === base ? null : String(value));
      };
      some(patch.view, DEFAULT_FILTERS.view, setView);
      some(patch.metric, DEFAULT_FILTERS.metric, setMetric);
      some(patch.period, DEFAULT_FILTERS.period, setPeriod);
      if (patch.compare !== undefined) setCmp(patch.compare ? '1' : null);
      some(patch.from, '', setFrom);
      some(patch.to, '', setTo);
      some(patch.index, DEFAULT_FILTERS.index, setIndex);
      some(patch.family, ANY, setFamily);
      some(patch.strategy, DEFAULT_FILTERS.strategy, setStrategy);
      some(patch.slot, ANY, setSlot);
      some(patch.weekday, ANY, setWeekday);
      some(patch.dte, ANY, setDte);
      some(patch.vix, ANY, setVix);
      some(patch.minN, DEFAULT_MIN_N, setMinN);
      some(patch.list, ANY, setList);
      some(patch.basis, 'all', setBasis);
    },
    [
      setView,
      setMetric,
      setPeriod,
      setCmp,
      setFrom,
      setTo,
      setIndex,
      setFamily,
      setStrategy,
      setSlot,
      setWeekday,
      setDte,
      setVix,
      setMinN,
      setList,
      setBasis,
    ],
  );

  return { filters, set };
}
