/**
 * A realistic synthetic rotation log for the daily-log tests and for a manual check: the same
 * shapes the API returns (rotation/daylog.py), covering every state a day can be in.
 * 2026-10-12 is the first registered trading day; 2026-10-20 is Dussehra.
 */

import type {
  PlacementStatus,
  RotationCounters,
  RotationListBlock,
  RotationListKey,
  RotationLog,
  RotationPick,
  RotationRow,
} from '../../types/rotationDailyLog';

const KEYS: RotationListKey[] = ['A', 'B', 'C', 'REF'];

export function pick(
  name: string,
  gross: number | null,
  opts: { role?: 'core' | 'buy'; stop?: boolean; composite?: number } = {},
): RotationPick {
  const [letter, family, tag] = name.split('_') as [string, string, string];
  const kind = family === 'buy' ? 'buy' : family === 'dir' || family === 'ditm1' ? 'dir' : 'wide';
  return {
    name,
    index: letter === 'N' ? 'NIFTY' : 'SENSEX',
    family,
    kind,
    start: `${tag.slice(0, 2)}:${tag.slice(2)}`,
    band: 'A',
    role: opts.role ?? 'core',
    composite: opts.composite ?? 0.9,
    result:
      gross === null
        ? null
        : {
            gross,
            worst_mtm: Math.min(gross, 0) - 200,
            stopped_by: opts.stop ? 'overall SL at 14:46' : '',
            stop: opts.stop ? 'sl' : null,
            n_trades: 2,
          },
  };
}

export function block(
  picks: RotationPick[],
  opts: { overridden?: boolean } = {},
): RotationListBlock {
  const missing = picks.filter((p) => p.result === null).map((p) => p.name);
  const scored = missing.length === 0;
  const total = scored ? picks.reduce((s, p) => s + (p.result?.gross ?? 0), 0) : null;
  return {
    picks,
    overridden: opts.overridden ?? false,
    buy_qualified: picks.some((p) => p.role === 'buy'),
    lots: 2 * picks.length,
    scored,
    missing,
    gross: total === null ? null : 2 * total,
    per_lot_day: total === null ? null : total / picks.length,
    stops: picks.filter((p) => p.result?.stop === 'sl').length,
    targets: 0,
    shared_start_band: false,
  };
}

function groupsOf(lists: Partial<Record<RotationListKey, RotationListBlock>>): string[][] {
  const by = new Map<string, string[]>();
  for (const k of KEYS) {
    const b = lists[k];
    if (!b) continue;
    const id = b.picks
      .map((p) => p.name)
      .sort()
      .join('|');
    by.set(id, [...(by.get(id) ?? []), k]);
  }
  return [...by.values()];
}

export function row(
  day: string,
  weekday: string,
  lists: Partial<Record<RotationListKey, RotationListBlock>>,
  over: Partial<RotationRow> = {},
): RotationRow {
  const groups = groupsOf(lists);
  const hasLists = Object.keys(lists).length > 0;
  return {
    day,
    weekday,
    source: 'recorded',
    status: 'scored',
    status_detail: '',
    collected: true,
    scored: hasLists && Object.values(lists).every((b) => b?.scored),
    lists,
    all_identical: hasLists ? groups.length === 1 && Object.keys(lists).length > 1 : null,
    groups,
    vix: { open: 14.6, band: '13-15', source: 'fyers' },
    dte: { NIFTY: '3', SENSEX: '4', source: 'master' },
    recorded: {
      at: `${day}T09:16:04+05:30`,
      time: '09:16:04',
      on_time: true,
      commit: 'ab12cd3',
      hash: 'f'.repeat(64),
      hash_short: 'ffffffffffff',
      prev_short: '000000000000',
      position: 1,
      chain_ok: true,
    },
    placement: {},
    ...over,
  };
}

const W = pick('N_wide_0917', 1200);
const W2 = pick('N_p80_0932', -450);
const D = pick('N_dir_1202', 300);
const BUY = pick('S_buy_1017', -150, { role: 'buy' });
const S1 = pick('N_wide_1017', -2500, { stop: true });

/** Same basket on all four lists. */
function same(picks: RotationPick[], opts: { overridden?: boolean } = {}) {
  return Object.fromEntries(KEYS.map((k) => [k, block(picks, opts)])) as Record<
    RotationListKey,
    RotationListBlock
  >;
}

export const ROWS: RotationRow[] = [
  // Mon 12 Oct: all four identical, scored
  row('2026-10-12', 'Mon', same([W, W2, D])),
  // Tue 13 Oct: the lists differ, Buy qualified in A and B, the Widesl minimum applied in C
  row('2026-10-13', 'Tue', {
    A: block([W, D, pick('S_wide_0917', 700), BUY]),
    B: block([W, D, pick('S_wide_0917', 700), BUY]),
    C: block([W, W2, D], { overridden: true }),
    REF: block([D, pick('S_dir_0917', -300), W2]),
  }),
  // Wed 14 Oct: recorded late (09:41)
  row('2026-10-14', 'Wed', same([W, D, W2]), {
    status: 'late',
    status_detail:
      'recorded at 09:41:12 IST, after 09:17: not a forward entry, left out of every forward counter',
    recorded: {
      at: '2026-10-14T09:41:12+05:30',
      time: '09:41:12',
      on_time: false,
      commit: 'ab12cd3',
      hash: 'e'.repeat(64),
      hash_short: 'eeeeeeeeeeee',
      prev_short: 'ffffffffffff',
      position: 2,
      chain_ok: true,
    },
  }),
  // Thu 15 Oct: no entry
  row(
    '2026-10-15',
    'Thu',
    {},
    {
      source: 'missing',
      status: 'not_recorded',
      status_detail:
        'no journal entry for this trading day (the 09:16 job did not record: the VIX open could not be read, or the job did not run)',
      vix: null,
      dte: null,
      recorded: null,
    },
  ),
  // Fri 16 Oct: a stop fired, VIX from Angel One
  row('2026-10-16', 'Fri', same([S1, D, W2]), {
    vix: { open: 15.9, band: '15-18', source: 'angelone' },
  }),
  // Mon 19 Oct: recorded, results not stored yet
  row(
    '2026-10-19',
    'Mon',
    same([pick('N_wide_0917', null), pick('N_dir_1202', null), pick('N_p80_0932', null)]),
    {
      status: 'waiting',
      status_detail: 'the nightly update has not stored this day yet',
      scored: false,
    },
  ),
];

const zero = (): Record<RotationListKey, number> => ({ A: 0, B: 0, C: 0, REF: 0 });

export const COUNTERS: RotationCounters = {
  days: 5,
  late: 1,
  scored: 4,
  waiting: 1,
  not_recorded: 1,
  buy_qualified: { A: 1, B: 1, C: 0, REF: 0 },
  widesl_minimum_applied: { ...zero(), C: 1 },
  start_band_shared: zero(),
  all_lists_identical: 3,
  lists_differ: 2,
  days_with_stop: 1,
  days_with_target: 0,
};

export function log(over: Partial<RotationLog> = {}): RotationLog {
  return {
    as_of: '2026-10-19T12:00:00+05:30',
    today: '2026-10-19',
    entry_window_open: false,
    source: 'recorded',
    from: null,
    to: null,
    registered: {
      first_day: '2026-10-12',
      record_time: '09:16',
      cutoff_time: '09:17',
      lots_per_strategy: 2,
      lists: [
        { key: 'A', description: 'own 5 / weekday 34 / dte 33 / VIX 23 / family-band 5' },
        { key: 'B', description: 'own 0 / weekday 36 / dte 35 / VIX 24 / family-band 5' },
        { key: 'C', description: 'own 15 / weekday 30 / dte 30 / VIX 20 / family-band 5' },
        { key: 'REF', description: 'the live baseline' },
      ],
    },
    chain: { entries: 5, intact: true, problems: [], head: 'ffffffffffff' },
    journal_entries: 5,
    last_collected_day: '2026-10-16',
    reconstructable: { error: null, available: 423, first: '2025-01-10', last: '2026-10-09' },
    holidays: [{ day: '2026-10-20', name: 'Dussehra' }],
    rows: ROWS,
    counters: { recorded: COUNTERS, reconstructed: { ...COUNTERS, late: 0, not_recorded: 0 } },
    placement_skipped_lines: 0,
    basis: 'gross',
    ...over,
  };
}

export function placement(day: string, list: RotationListKey, status: PlacementStatus, note = '') {
  return { day, list, status, note, at: `${day}T09:31:07+05:30` };
}
