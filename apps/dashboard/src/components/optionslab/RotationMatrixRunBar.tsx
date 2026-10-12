'use client';

/**
 * The Matrix's run bar and settings drawer (the Analytics page pattern): the two switches used
 * most often (view, metric) stay inline beside a one-line summary of the active settings and a
 * Settings button; every other setting lives in the drawer, so the grid is on the first screen.
 */

import { RotateCcw, SlidersHorizontal } from 'lucide-react';

import { type MatrixPreset, PRESET_OPTIONS } from '../../lib/rotationMatrixDefault';
import {
  ANY,
  METRIC_OPTIONS,
  type MatrixFilters,
  VIEW_OPTIONS,
} from '../../lib/rotationMatrixView';
import type { MatrixMeta } from '../../types/rotationMatrix';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Drawer } from '../ui/Drawer';
import { SegmentedControl } from '../ui/SegmentedControl';
import { RotationMatrixControls } from './RotationMatrixControls';

export function RotationMatrixRunBar({
  filters: f,
  set,
  summary,
  changed,
  note,
  onOpenSettings,
}: {
  filters: MatrixFilters;
  set: (patch: Partial<MatrixFilters>) => void;
  /** "Today · 12 Oct 2026 · Both indices · All families". */
  summary: string;
  /** How many settings differ from the opening view. */
  changed: number;
  /** Why the shown day is not today, or that a fallback applies. */
  note: string | null;
  onOpenSettings: () => void;
}) {
  const hint = VIEW_OPTIONS.find((o) => o.value === f.view)?.hint;
  return (
    <Card className="space-y-1.5 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <SegmentedControl
          value={f.view}
          options={VIEW_OPTIONS.map(({ value, label }) => ({ value, label }))}
          onChange={(view) => set({ view })}
          ariaLabel="Matrix view"
          size="sm"
        />
        <SegmentedControl
          value={f.metric}
          options={METRIC_OPTIONS.map((o) => ({
            ...o,
            disabled: o.value === 'selection' && f.list === ANY,
          }))}
          onChange={(metric) => set({ metric })}
          ariaLabel="Metric"
          size="sm"
        />
        <p
          className="min-w-0 flex-1 truncate text-xs text-muted"
          title={hint ? `${summary}. ${hint}` : summary}
          data-testid="matrix-summary"
        >
          {summary}
        </p>
        <Button size="sm" onClick={onOpenSettings} title="Open the matrix settings">
          <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
          Settings
          {changed > 0 ? <span className="metric text-xs text-warning">{changed}</span> : null}
        </Button>
      </div>
      {note ? <p className="text-xs text-muted">{note}</p> : null}
    </Card>
  );
}

export function RotationMatrixSettingsDrawer({
  open,
  onOpenChange,
  filters,
  set,
  meta,
  summary,
  sessionsReady,
  onPreset,
  onReset,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filters: MatrixFilters;
  set: (patch: Partial<MatrixFilters>) => void;
  meta: MatrixMeta | undefined;
  summary: string;
  /** The scored sessions are known, so "Last N sessions" can count back from the newest. */
  sessionsReady: boolean;
  onPreset: (preset: MatrixPreset) => void;
  onReset: () => void;
}) {
  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title="Matrix settings"
      subtitle={summary}
      closeLabel="Close settings"
      actions={
        <Button
          size="sm"
          variant="ghost"
          onClick={onReset}
          title="Back to today's session, family by start time, average"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          Reset to today
        </Button>
      }
    >
      <RotationMatrixControls
        filters={filters}
        set={set}
        meta={meta}
        periodExtras={
          <div className="flex flex-wrap gap-1.5">
            {PRESET_OPTIONS.map((p) => (
              <Button
                key={p.value}
                size="sm"
                onClick={() => onPreset(p.value)}
                disabled={!sessionsReady && p.value.startsWith('last')}
                title={
                  !sessionsReady && p.value.startsWith('last')
                    ? 'The scored sessions are still loading'
                    : undefined
                }
              >
                {p.label}
              </Button>
            ))}
          </div>
        }
      />
    </Drawer>
  );
}
