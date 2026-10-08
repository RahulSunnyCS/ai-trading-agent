'use client';

import { Check, Clock, Play, TriangleAlert } from 'lucide-react';

import { cn } from '../../../lib/cn';
import { formatDay, formatIstTime } from '../../../lib/format';
import { type StepState, type TimelineStep, countdown } from '../../../lib/momentumWeek';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Skeleton } from '../../ui/Skeleton';

const STATE_STYLE: Record<StepState, string> = {
  done: 'bg-positive/15 text-positive',
  late: 'bg-warning/15 text-warning',
  waiting: 'border border-dashed border-border-strong text-faint',
  due: 'bg-primary/15 text-primary',
  missed: 'bg-negative/15 text-negative',
};

function stepNote(step: TimelineStep): string {
  if (step.state === 'done') return step.ranAt ? `ran ${formatIstTime(step.ranAt)}` : 'done';
  if (step.state === 'late')
    return `ran ${step.ranAt ? formatIstTime(step.ranAt) : ''} · ${step.lateBy} min late`;
  if (step.state === 'waiting')
    return step.minutesToGo != null ? `in ${countdown(step.minutesToGo)}` : 'later today';
  if (step.state === 'due') return 'due now';
  return 'did not run';
}

/**
 * The Friday steps in one row (BL-051): each is done, done late, still to come (with a
 * countdown), due now or missed. Replaces the old readiness and schedule cards; "Run by hand"
 * opens the drawer with the manual run, data readiness and the schedule.
 */
export function FridayTimeline({
  steps,
  week,
  onRunByHand,
  onWeek,
  previousWeek,
  nextWeek,
  running,
}: {
  steps: readonly TimelineStep[] | null;
  week: string | null;
  onRunByHand: () => void;
  onWeek: (week: string | null) => void;
  previousWeek: string | null;
  nextWeek: string | null;
  running: boolean;
}) {
  return (
    <Card flush>
      <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
        <h2 className="text-sm font-semibold text-foreground">
          {week ? `Friday ${formatDay(week)}` : <Skeleton className="h-4 w-32" />}
        </h2>
        <span className="text-xs text-muted">the weekly signal&apos;s steps</span>
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            disabled={!previousWeek}
            onClick={() => onWeek(previousWeek)}
          >
            ‹ Week before
          </Button>
          {nextWeek ? (
            <Button size="sm" variant="ghost" onClick={() => onWeek(nextWeek)}>
              Week after ›
            </Button>
          ) : null}
          <Button size="sm" onClick={onRunByHand} loading={running}>
            {running ? null : <Play className="h-3.5 w-3.5" aria-hidden="true" />}
            {running ? 'Running…' : 'Run by hand'}
          </Button>
        </div>
      </div>
      <ol className="flex overflow-x-auto px-2 pb-3 pt-1">
        {steps
          ? steps.map((step, index) => (
              <li key={step.run} className="relative min-w-36 flex-1 px-2 py-2">
                {index < steps.length - 1 ? (
                  <span
                    aria-hidden="true"
                    className={cn(
                      'absolute left-9 right-0 top-[19px] h-0.5',
                      step.state === 'done' || step.state === 'late'
                        ? 'bg-positive/40'
                        : 'bg-border',
                    )}
                  />
                ) : null}
                <div className="relative flex w-fit items-center gap-2 bg-surface pr-2">
                  <span
                    className={cn(
                      'grid h-5 w-5 shrink-0 place-items-center rounded-full',
                      STATE_STYLE[step.state],
                    )}
                  >
                    {step.state === 'done' ? (
                      <Check className="h-3 w-3" aria-hidden="true" />
                    ) : step.state === 'late' || step.state === 'missed' ? (
                      <TriangleAlert className="h-3 w-3" aria-hidden="true" />
                    ) : (
                      <Clock className="h-3 w-3" aria-hidden="true" />
                    )}
                  </span>
                  <span className="metric text-xs text-faint">{step.time}</span>
                </div>
                <div className="mt-1.5 whitespace-nowrap text-sm font-semibold text-foreground">
                  {step.label}
                </div>
                <div
                  className={cn(
                    'whitespace-nowrap text-xs',
                    step.state === 'missed' ? 'text-negative' : 'text-muted',
                  )}
                >
                  {stepNote(step)}
                </div>
              </li>
            ))
          : Array.from({ length: 5 }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholders
              <li key={i} className="min-w-36 flex-1 px-2 py-2">
                <Skeleton className="h-4 w-12" />
                <Skeleton className="mt-2 h-4 w-24" />
                <Skeleton className="mt-1 h-3 w-16" />
              </li>
            ))}
      </ol>
    </Card>
  );
}
