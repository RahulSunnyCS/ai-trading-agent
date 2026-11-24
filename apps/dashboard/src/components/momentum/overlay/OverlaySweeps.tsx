'use client';

/**
 * Momentum › Options overlay › Sweeps (BL-229): the runs of an overnight grid
 * (`mbt overlay-sweep`), one row each, sorted by a train or test figure. Open loads a row's
 * settings into the page and runs it.
 */

import { useMemo, useState } from 'react';

import { usePolledResource } from '../../../hooks/usePolledResource';
import { EMPTY, formatInr, formatInt, formatPct } from '../../../lib/format';
import { DIRECTION_LABEL, customName } from '../../../lib/optionsOverlay';
import type {
  OverlayCustom,
  OverlayDirection,
  OverlayRequest,
  OverlaySweepRow,
  OverlaySweepStatus,
} from '../../../types/optionsOverlay';
import { Button } from '../../ui/Button';
import { Select } from '../../ui/Input';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { THead, TRow, Table, Td, Th } from '../../ui/Table';

const LIST_URL = '/api/momentum/options-overlay/sweeps';
type SortKey = 'test' | 'train' | 'test_dd' | 'total';

function sortValue(row: OverlaySweepRow, key: SortKey): number {
  if (key === 'train') return row.windows?.train.total_rs ?? Number.NEGATIVE_INFINITY;
  if (key === 'test') return row.windows?.test.total_rs ?? Number.NEGATIVE_INFINITY;
  if (key === 'test_dd') return row.windows?.test.max_dd ?? Number.NEGATIVE_INFINITY;
  return row.book?.total_rs ?? Number.NEGATIVE_INFINITY;
}

/** The settings that vary in a sweep, in a few words. */
export function sweepSettingsText(s: OverlaySweepRow['settings']): string {
  const parts: string[] = [];
  const money = String(s.moneyness ?? 'ATM');
  parts.push(money === 'DELTA' ? `Δ${Math.round(Number(s.delta_target ?? 0.6) * 100)}` : money);
  if (s.expiry_skip) parts.push(`exp+${s.expiry_skip}`);
  if (s.hold) parts.push('hold');
  if (s.stop) parts.push(`stop ${Math.round(Number(s.stop) * 100)}%`);
  if (s.target) parts.push(`tgt ${Math.round(Number(s.target) * 100)}%`);
  if (s.call_filter && s.call_filter !== 'none') parts.push(`calls if ${s.call_filter}`);
  if (s.sizing === 'capital_share') parts.push(`${Math.round(Number(s.sizing_value) * 100)}%/wk`);
  else if (s.sizing === 'exposure') parts.push(`exp ${Math.round(Number(s.sizing_value) * 100)}%`);
  else if (s.sizing === 'premium') parts.push('premium');
  else parts.push('1 lot');
  if (s.profit_step) parts.push(`book ${Math.round(Number(s.withdraw_share ?? 0.75) * 100)}%`);
  return parts.join(' · ');
}

export function OverlaySweeps({ onOpen }: { onOpen: (settings: Partial<OverlayRequest>) => void }) {
  const list = usePolledResource<{ sweeps: OverlaySweepStatus[] }>(LIST_URL, {
    intervalMs: 60_000,
  });
  const sweeps = list.data?.sweeps ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  const name = picked ?? sweeps[sweeps.length - 1]?.name ?? null;
  const status = sweeps.find((s) => s.name === name) ?? null;
  const rows = usePolledResource<{ name: string; rows: OverlaySweepRow[] }>(
    name ? `${LIST_URL}/${encodeURIComponent(name)}` : `${LIST_URL}/none`,
    { enabled: name !== null, ...(status?.running ? { intervalMs: 60_000 } : {}) },
  );
  // selection reads the train window only: the test window stays shut until it is opened on purpose
  const [sort, setSort] = useState<SortKey>('train');
  const [showTest, setShowTest] = useState(false);
  const [limit, setLimit] = useState(30);
  const data = rows.data && rows.data.name === name ? rows.data.rows : [];
  const sorted = useMemo(
    () => [...data].filter((r) => !r.error).sort((a, b) => sortValue(b, sort) - sortValue(a, sort)),
    [data, sort],
  );
  const errors = data.filter((r) => r.error).length;

  if (!sweeps.length) return null;
  return (
    <section
      aria-label="Sweeps"
      className="min-w-0 rounded-xl border border-border bg-surface shadow-card"
    >
      <header className="flex flex-wrap items-center gap-3 px-4 pb-2 pt-3">
        <h3 className="text-sm font-semibold text-foreground">Sweeps</h3>
        <Select
          aria-label="Sweep"
          className="w-64"
          value={name ?? ''}
          onChange={(e) => setPicked(e.target.value)}
        >
          {sweeps.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name}
            </option>
          ))}
        </Select>
        {status ? (
          <span className="text-xs text-faint">
            {formatInt(status.done)} of {formatInt(status.total)} runs
            {status.running
              ? ' · running'
              : status.finished
                ? ` · finished ${status.finished}`
                : ''}
            {errors ? ` · ${errors} failed` : ''}
          </span>
        ) : null}
        <div className="ml-auto">
          <SegmentedControl
            ariaLabel="Sort sweep by"
            size="sm"
            value={sort}
            options={
              showTest
                ? [
                    { value: 'train', label: 'Train total' },
                    { value: 'test', label: 'Test total' },
                    { value: 'test_dd', label: 'Test drawdown' },
                    { value: 'total', label: 'Whole period' },
                  ]
                : [{ value: 'train', label: 'Train total' }]
            }
            onChange={setSort}
          />
          <Button
            variant="ghost"
            size="sm"
            className="ml-2"
            onClick={() => {
              if (showTest) setSort('train');
              setShowTest(!showTest);
            }}
          >
            {showTest ? 'Hide the test window' : 'Show the test window'}
          </Button>
        </div>
      </header>
      <div className="px-4 pb-4">
        <p className="mb-2 text-xs text-muted">
          One row per setting tried, best train window first. Pick on the train window; the test
          window is the check, so it stays hidden until you open it, and with many rows a few will
          look good by chance.
        </p>
        <Table maxHeight={560}>
          <THead>
            <Th dense>Strategy</Th>
            <Th dense>Direction</Th>
            <Th dense>Settings</Th>
            <Th align="right" dense>
              Train total
            </Th>
            <Th align="right" dense>
              Train DD
            </Th>
            {showTest ? (
              <>
                <Th align="right" dense>
                  Test total
                </Th>
                <Th align="right" dense>
                  Test DD
                </Th>
                <Th align="right" dense>
                  Test top 5 %
                </Th>
              </>
            ) : null}
            <Th align="right" dense>
              Trades
            </Th>
            <Th dense>{''}</Th>
          </THead>
          <tbody>
            {sorted.slice(0, limit).map((r) => {
              const s = r.settings;
              const custom = s.custom as OverlayCustom | undefined;
              const strategy = r.label ?? (custom ? customName(custom) : EMPTY);
              return (
                <TRow key={r.id} className="whitespace-nowrap">
                  <Td dense title={strategy}>
                    <span className="block max-w-48 truncate">{strategy}</span>
                  </Td>
                  <Td dense>{DIRECTION_LABEL[(s.direction as OverlayDirection) ?? 'calls']}</Td>
                  <Td dense>{sweepSettingsText(s)}</Td>
                  <Td numeric align="right" dense>
                    {formatInr(r.windows?.train.total_rs, { sign: true, compact: true })}
                  </Td>
                  <Td numeric align="right" dense>
                    {formatPct(r.windows?.train.max_dd, 0)}
                  </Td>
                  {showTest ? (
                    <>
                      <Td numeric align="right" dense>
                        <span
                          className={
                            (r.windows?.test.total_rs ?? 0) >= 0 ? 'text-positive' : 'text-negative'
                          }
                        >
                          {formatInr(r.windows?.test.total_rs, { sign: true, compact: true })}
                        </span>
                      </Td>
                      <Td numeric align="right" dense>
                        {formatPct(r.windows?.test.max_dd, 0)}
                      </Td>
                      <Td numeric align="right" dense>
                        {formatPct(r.windows?.test.top5pct_share, 0)}
                      </Td>
                    </>
                  ) : null}
                  <Td numeric align="right" dense>
                    {formatInt(r.stats?.trades)}
                  </Td>
                  <Td dense>
                    <Button variant="ghost" size="sm" onClick={() => onOpen(r.settings)}>
                      Open
                    </Button>
                  </Td>
                </TRow>
              );
            })}
          </tbody>
        </Table>
        {sorted.length > limit ? (
          <Button
            variant="ghost"
            size="sm"
            className="mt-2"
            onClick={() => setLimit((n) => n + 100)}
          >
            Show more ({formatInt(sorted.length - limit)} left)
          </Button>
        ) : null}
      </div>
    </section>
  );
}
