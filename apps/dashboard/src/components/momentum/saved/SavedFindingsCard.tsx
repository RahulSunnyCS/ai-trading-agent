'use client';

import { AlertTriangle, CircleCheck, Info, Layers, TriangleAlert } from 'lucide-react';

import { cn } from '../../../lib/cn';
import type { Finding, FindingAction } from '../../../lib/momentumFindings';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';

const ICON = {
  negative: AlertTriangle,
  warning: TriangleAlert,
  info: Info,
  neutral: CircleCheck,
} as const;

const TONE = {
  negative: 'bg-negative/15 text-negative',
  warning: 'bg-warning/15 text-warning',
  info: 'bg-info/15 text-info',
  neutral: 'bg-surface-2 text-muted',
} as const;

/**
 * "What the saved runs say" (BL-052 Phase 3): up to five findings worked out from the saved
 * strategies, each with its link. Below the list and the compare bar; Hide is remembered.
 */
export function SavedFindingsCard({
  findings,
  hidden,
  onHiddenChange,
  onAction,
}: {
  findings: ReadonlyArray<Finding>;
  hidden: boolean;
  onHiddenChange: (hidden: boolean) => void;
  onAction: (action: FindingAction) => void;
}) {
  if (findings.length === 0) return null;
  return (
    <Card className="p-0">
      <div className="flex items-center gap-2 px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">What the saved runs say</h2>
        <span className="truncate text-xs text-faint">
          worked out from the runs themselves; updates when a run is saved
        </span>
        <span className="grow" />
        <Button size="sm" variant="ghost" onClick={() => onHiddenChange(!hidden)}>
          {hidden ? `Show ${findings.length}` : 'Hide'}
        </Button>
      </div>
      {hidden ? null : (
        <ul>
          {findings.map((finding) => {
            const Icon = finding.id === 'folded' ? Layers : ICON[finding.tone];
            return (
              <li
                key={finding.id}
                className="flex items-start gap-3 border-t border-border px-4 py-2.5"
              >
                <span
                  className={cn(
                    'mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md',
                    TONE[finding.tone],
                  )}
                  aria-hidden
                >
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">{finding.title}</p>
                  <p className="text-sm text-muted">{finding.detail}</p>
                </div>
                {finding.action ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="shrink-0 text-primary"
                    onClick={() => finding.action && onAction(finding.action)}
                  >
                    {finding.action.label}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
