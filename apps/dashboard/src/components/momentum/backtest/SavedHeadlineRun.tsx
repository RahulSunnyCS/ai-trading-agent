'use client';

import { cn } from '../../../lib/cn';
import { EMPTY, formatDay, formatNumber, formatPct, formatPp } from '../../../lib/format';
import type { HeadlineSaved } from '../../../lib/momentumSaved';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { SavedGroupCurve } from '../saved/SavedGroupCurve';

function Figure({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="min-w-0 flex-1 basis-32">
      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-faint">{label}</div>
      <div className={cn('metric mt-1 text-lg font-semibold', tone ?? 'text-foreground')}>
        {value}
      </div>
    </div>
  );
}

/**
 * Backtest before anything is run: the headline favourite's latest saved figures and curve, read
 * from Saved runs (never a run started by the page), with its settings loaded in the run bar when
 * it has settings to run.
 */
export function SavedHeadlineRun({
  saved,
  onSettings,
}: {
  saved: HeadlineSaved;
  onSettings: () => void;
}) {
  const kpis = saved.kpis;
  const day = formatDay(saved.savedAt.slice(0, 10));
  const isGroup = saved.openable === null;
  // A group that follows an All Fridays run shows that run, named, not the group's blend.
  const followed =
    saved.openable !== null && saved.openable.id !== saved.headline.id ? saved.openable : null;
  return (
    <Card>
      <CardHeader
        title={saved.headline.name}
        description={
          isGroup
            ? `Showing the saved run of ${day}: the group's sleeves blended. A group is run one sleeve at a time; open Settings to run something.`
            : followed
              ? `Showing the saved run of ${day}: ${followed.name}, the All Fridays run this group follows. Run to refresh.`
              : `Showing the saved run of ${day}. Run to refresh.`
        }
        actions={
          <span className="flex items-center gap-2">
            <Badge tone="primary">Headline</Badge>
            <Button size="sm" variant="ghost" onClick={onSettings}>
              Settings
            </Button>
          </span>
        }
      />
      <div className="mb-3 flex flex-wrap gap-4">
        <Figure label="CAGR" value={kpis.cagr == null ? EMPTY : formatPct(kpis.cagr)} />
        <Figure
          label="vs benchmark"
          value={kpis.excess_cagr == null ? EMPTY : formatPp(kpis.excess_cagr)}
          tone={(kpis.excess_cagr ?? 0) >= 0 ? 'text-positive' : 'text-negative'}
        />
        <Figure
          label="Max drawdown"
          value={kpis.max_drawdown == null ? EMPTY : formatPct(kpis.max_drawdown)}
          tone="text-negative"
        />
        <Figure
          label={isGroup ? 'Sharpe (est.)' : 'Sharpe'}
          value={kpis.sharpe == null ? EMPTY : formatNumber(kpis.sharpe, 2)}
        />
      </div>
      <SavedGroupCurve
        name={saved.headline.name}
        dates={saved.dates}
        blend={saved.values}
        sleeves={[]}
      />
    </Card>
  );
}
