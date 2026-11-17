/**
 * The Live board's picks × time matrix (BL-231 Phase 6): one row per pick, one column per time
 * bucket from the open, each cell the pick's running P&L at the end of the bucket. Read off the
 * snapshot's minute curves, so it moves with every 5-minute refresh and needs no request of its
 * own. Figures are before slippage (the engine's curve is at the prices it read); a cell before a
 * pick enters is empty, never zero, and a pick that has ended holds its last value in a muted face.
 */

import { useMemo, useState } from 'react';

import { cn } from '../../lib/cn';
import { formatInr } from '../../lib/format';
import type { LotsView } from '../../lib/rotationLiveBoard';
import {
  BUCKETS,
  type BookMatrix,
  type Bucket,
  DEFAULT_BUCKET,
  buildMatrices,
  cellTone,
  pickScale,
  totalScale,
} from '../../lib/rotationLiveMatrix';
import { legendSwatches } from '../../lib/rotationMatrixView';
import type { LiveBoardSnapshot } from '../../types/rotationLiveBoard';
import { SegmentedControl } from '../ui/SegmentedControl';
import { Table, Td, Th } from '../ui/Table';
import { pnlClass } from './shared';

const BUCKET_OPTIONS = BUCKETS.map((b) => ({ value: String(b), label: `${b} min` }));

function toBucket(value: string): Bucket {
  return BUCKETS.find((b) => String(b) === value) ?? DEFAULT_BUCKET;
}

function money(value: number): string {
  return formatInr(value, { sign: true });
}

function Cell({
  value,
  held,
  partial,
  tone,
  title,
}: {
  value: number | null;
  held: boolean;
  partial: boolean;
  tone: string;
  title: string;
}) {
  return (
    <Td
      dense
      align="right"
      numeric
      title={title}
      className={cn(
        'whitespace-nowrap border-l border-border/40 text-xs',
        tone,
        value === null && 'text-faint',
        held && 'italic opacity-70',
        partial && 'border-dashed',
        value !== null && pnlClass(value),
      )}
    >
      {value === null ? '·' : money(value)}
    </Td>
  );
}

function BookGrid({
  matrix,
  rowScale,
  sumScale,
}: {
  matrix: BookMatrix;
  rowScale: ReturnType<typeof pickScale>;
  sumScale: ReturnType<typeof totalScale>;
}) {
  const { columns } = matrix;
  if (columns.length === 0) {
    return <p className="text-xs text-faint">No bars yet for {matrix.name}.</p>;
  }
  return (
    <div className="space-y-1">
      <h4 className="text-xs font-semibold text-foreground">{matrix.name}</h4>
      <Table stickyFirstCol>
        <thead>
          <tr className="border-b border-border">
            <Th dense>Strategy</Th>
            {columns.map((c) => (
              <Th
                key={c.minute}
                dense
                align="right"
                className={cn('whitespace-nowrap', c.partial && 'italic text-info')}
                title={
                  c.partial ? 'The newest, unfinished bucket: as at the last bar read' : undefined
                }
              >
                {c.label}
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {matrix.rows.map((r) => (
            <tr key={r.key} className="border-b border-border/40">
              <Td dense className="align-top">
                <div className="max-w-[12rem] truncate font-medium text-foreground" title={r.label}>
                  {r.label}
                </div>
                <div className="text-[11px] text-faint">
                  {r.sub}
                  {r.state === 'waiting' ? ' · waiting' : r.state === 'closed' ? ' · closed' : ''}
                </div>
              </Td>
              {r.cells.map((cell, i) => {
                const col = columns[i];
                return (
                  <Cell
                    key={col?.minute ?? i}
                    value={cell.value}
                    held={cell.held}
                    partial={col?.partial ?? false}
                    tone={cellTone(cell.value, rowScale)}
                    title={
                      cell.value === null
                        ? `${r.label}: not entered by ${col?.label}`
                        : `${r.label} at ${col?.label}: ${money(cell.value)}${cell.held ? ' (ended; last value held)' : ''}`
                    }
                  />
                );
              })}
            </tr>
          ))}
          <tr className="border-t border-border bg-surface">
            <Td dense className="font-semibold text-foreground">
              Total
            </Td>
            {matrix.total.map((v, i) => {
              const col = columns[i];
              return (
                <Cell
                  key={col?.minute ?? i}
                  value={v}
                  held={false}
                  partial={col?.partial ?? false}
                  tone={cellTone(v, sumScale)}
                  title={
                    v === null
                      ? 'No pick has entered yet'
                      : `${matrix.name} at ${col?.label}: ${money(v)}`
                  }
                />
              );
            })}
          </tr>
        </tbody>
      </Table>
    </div>
  );
}

export function RotationLiveMatrix({
  snap,
  view,
}: {
  snap: LiveBoardSnapshot;
  view: LotsView;
}) {
  const [bucket, setBucket] = useState<Bucket>(DEFAULT_BUCKET);
  const matrices = useMemo(
    () => buildMatrices(snap.books, snap.as_of, bucket, view),
    [snap.books, snap.as_of, bucket, view],
  );
  const rowScale = useMemo(() => pickScale(matrices), [matrices]);
  const sumScale = useMemo(() => totalScale(matrices), [matrices]);
  const swatches = useMemo(() => legendSwatches(rowScale, 'inr'), [rowScale]);
  if (matrices.every((m) => m.columns.length === 0)) return null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-xs font-medium text-muted">
            Matrix: each pick's P&L through the day ({view === 'yours' ? 'your lots' : 'a lot each'}
            , before slippage)
          </h3>
          <p className="text-[11px] text-faint">
            Each cell is the P&L at the end of the time shown. · means not entered yet; an italic
            figure is a pick that has ended, held at its last value. The dashed column is the bucket
            still in progress.
          </p>
        </div>
        <SegmentedControl
          value={String(bucket)}
          options={BUCKET_OPTIONS}
          onChange={(v) => setBucket(toBucket(v))}
          ariaLabel="Matrix time step"
          size="sm"
        />
      </div>
      <div className="space-y-4">
        {matrices.map((m) => (
          <BookGrid key={m.book} matrix={m} rowScale={rowScale} sumScale={sumScale} />
        ))}
      </div>
      {swatches.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1 text-[11px] text-faint">
          <span className="mr-1">Tint, per pick:</span>
          {swatches.map((s) => (
            <span
              key={s.edge}
              className={cn(
                'inline-block rounded px-1.5 py-0.5 font-mono tabular-nums',
                s.className,
              )}
            >
              {money(Math.round(s.edge))}
            </span>
          ))}
          <span className="ml-1">(the Total row has its own scale)</span>
        </div>
      ) : null}
    </div>
  );
}
