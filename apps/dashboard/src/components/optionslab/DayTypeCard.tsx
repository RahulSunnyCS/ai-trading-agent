/**
 * "When does it work?" — each strategy's ₹/lot grouped by the day's market type, plus the
 * scatter against realised-vs-implied movement.
 *
 * Two lenses side by side because they mean different things:
 *   Same day     — explanatory (a day's label is only known once it is over)
 *   Previous day — the only one you could act on in advance
 * Buckets under MIN_BUCKET_N days are greyed: with a week or two of option history most
 * cells are anecdotes, and the card says so.
 */

import { useMemo, useState } from 'react';

import { formatPnl } from '../../lib/format';
import { MIN_BUCKET_N, type PnlDay, bucketByLabel, scatterPoints } from '../../lib/legwiseJoin';
import type { DayAnatomy } from '../../types/legwise';
import { Card, CardHeader } from '../ui/Card';
import { THead, TRow, Table, Td, Th } from '../ui/Table';
import { PnlScatter } from './PnlScatter';
import { LabelChip, STATES } from './RegimeViews';
import { Select, pnlClass } from './shared';

const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(0)}%`);

export function DayTypeCard({
  strategies,
  pnl,
  anatomy,
  segmentNames,
}: {
  strategies: string[];
  /** ₹ per lot per day, keyed by strategy id (current-version results only). */
  pnl: Map<string, PnlDay[]>;
  anatomy: DayAnatomy[];
  segmentNames: string[];
}) {
  const [series, setSeries] = useState(-1);
  const options = [
    { value: '-1', label: 'Whole day' },
    ...segmentNames.map((n, i) => ({ value: String(i), label: n })),
  ];

  const scatter = useMemo(
    () =>
      strategies.map((id) => ({
        id,
        points: scatterPoints(pnl.get(id) ?? [], anatomy, series),
      })),
    [strategies, pnl, anatomy, series],
  );

  if (anatomy.length === 0) {
    return (
      <Card>
        <CardHeader title="When does it work?" />
        <p className="text-sm text-muted">
          No index history to classify days against. Run <code>obt fyers history</code> — or, until
          then, the days the evening run has collected are enough for a first look.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="When does it work?"
        description="₹ per lot by the market's day type. 'Previous day' is the lens you could act on in advance; 'same day' only explains what happened. Greyed = fewer than 5 days."
        actions={
          <Select value={String(series)} options={options} onChange={(v) => setSeries(Number(v))} />
        }
      />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        {strategies.map((id) => {
          const rows = pnl.get(id) ?? [];
          const same = bucketByLabel(rows, anatomy, series, 'same', STATES);
          const lag = bucketByLabel(rows, anatomy, series, 'lag1', STATES);
          return (
            <div key={id}>
              <p className="mb-1 truncate text-sm font-medium" title={id}>
                {id} <span className="text-xs font-normal text-faint">n={rows.length}</span>
              </p>
              <Table>
                <THead>
                  <Th>Day type</Th>
                  <Th align="right">Same day</Th>
                  <Th align="right">Win</Th>
                  <Th align="right">Previous day</Th>
                  <Th align="right">Win</Th>
                </THead>
                <tbody>
                  {STATES.map((label, i) => {
                    const a = same[i];
                    const b = lag[i];
                    const cell = (x: typeof a) =>
                      !x || x.n === 0 ? (
                        <span className="text-faint">—</span>
                      ) : (
                        <span className={x.n < MIN_BUCKET_N ? 'text-faint' : pnlClass(x.mean ?? 0)}>
                          {formatPnl(x.mean ?? 0)}
                          <span className="ml-1 text-[10px] text-faint">n={x.n}</span>
                        </span>
                      );
                    return (
                      <TRow key={label}>
                        <Td>
                          <LabelChip label={label} />
                        </Td>
                        <Td align="right" numeric>
                          {cell(a)}
                        </Td>
                        <Td
                          align="right"
                          numeric
                          className={a && a.n < MIN_BUCKET_N ? 'text-faint' : ''}
                        >
                          {pct(a?.winRate ?? null)}
                        </Td>
                        <Td align="right" numeric>
                          {cell(b)}
                        </Td>
                        <Td
                          align="right"
                          numeric
                          className={b && b.n < MIN_BUCKET_N ? 'text-faint' : ''}
                        >
                          {pct(b?.winRate ?? null)}
                        </Td>
                      </TRow>
                    );
                  })}
                </tbody>
              </Table>
            </div>
          );
        })}
      </div>
      <div className="mt-5">
        <p className="mb-1 text-xs font-medium uppercase tracking-wider text-faint">
          Each day: ₹ per lot vs how much the market moved relative to VIX
        </p>
        <PnlScatter series={scatter} />
      </div>
    </Card>
  );
}
