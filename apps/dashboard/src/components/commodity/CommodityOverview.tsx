/**
 * Commodity Lab › Overview: the four minis at a glance (next expiry, how fresh the collected
 * data is) and the headline of the gold Dir forward test. Reads the same two endpoints as the
 * Forward test and Data sections; nothing is recomputed here.
 */

import { CalendarClock, Database } from 'lucide-react';

import type { ReactNode } from 'react';

import { useCommodityForward, useCommodityOverview } from '../../hooks/useCommodity';
import { navigateToLink } from '../../hooks/useQueryState';
import { cn } from '../../lib/cn';
import {
  COMMODITY_SECTION_META,
  ROOT_UNIT,
  expiryText,
  staleWeekdays,
} from '../../lib/commodityView';
import { EMPTY, formatDay, formatInr } from '../../lib/format';
import type { CommodityRoot, ForwardBlock } from '../../types/commodity';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { RefreshButton } from '../ui/RefreshButton';
import { SkeletonRows } from '../ui/Skeleton';
import { StatCard } from '../ui/StatCard';
import { StateMessage } from '../ui/StateMessage';
import { WindowStrip } from './WindowStrip';

function RootCard({ root, asOf }: { root: CommodityRoot; asOf: string }) {
  const stale = staleWeekdays(root, asOf);
  const fresh = stale !== null && stale <= 1;
  return (
    <div className="rounded-lg border border-border bg-surface-2/60 px-4 py-3.5">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-foreground">{root.name}</div>
          <div className="text-[11px] text-faint">
            {root.root} · {ROOT_UNIT[root.root] ?? EMPTY}
          </div>
        </div>
        <Badge tone={fresh ? 'positive' : stale === null ? 'neutral' : 'warning'}>
          {stale === null ? 'No data' : fresh ? 'Collected' : `${stale} weekdays behind`}
        </Badge>
      </div>
      <dl className="mt-3 space-y-1.5 text-sm">
        <div className="flex items-center justify-between gap-3">
          <dt className="flex items-center gap-1.5 text-muted">
            <CalendarClock className="h-3.5 w-3.5" aria-hidden /> Next expiry
          </dt>
          <dd className="metric text-foreground">{expiryText(root)}</dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="flex items-center gap-1.5 text-muted">
            <Database className="h-3.5 w-3.5" aria-hidden /> Last collected
          </dt>
          <dd className="metric text-foreground">{formatDay(root.last_day)}</dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted">Days held</dt>
          <dd className="metric text-foreground">{root.days_collected}</dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted">Settles on</dt>
          <dd className="metric truncate text-foreground" title={root.future ?? undefined}>
            {root.future?.replace('MCX:', '') ?? EMPTY}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function ForwardCard({ block, refresh }: { block: ForwardBlock; refresh: ReactNode }) {
  const { rule, summary, pass_rule: pass, window } = block;
  const first = rule.key === 'goldm-dir';
  return (
    <Card>
      <CardHeader
        title={`${rule.label.replace(' paper', '')} forward test`}
        description={`Paper-only: sell ${rule.root === 'GOLDM' ? 'gold' : 'silver'} options at ${rule.entry} in the ${rule.week === 'expiry week' ? 'last five sessions before each expiry' : 'five sessions before each expiry week'}, scored every night.`}
        actions={
          <span className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() =>
                navigateToLink(`/commoditylab/forward${first ? '' : `?rule=${rule.key}`}`)
              }
            >
              Open the test
            </Button>
            {refresh}
          </span>
        }
      />
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard
            label="Net so far"
            value={summary.sessions ? formatInr(summary.net, { sign: true }) : EMPTY}
            tone={summary.net > 0 ? 'positive' : summary.net < 0 ? 'negative' : 'muted'}
            note={`After charges and ${pass.slippage_pct}% slippage`}
          />
          <StatCard label="Sessions" value={summary.sessions} note="Scored and journaled" />
          <StatCard
            label="Expiries up"
            value={`${summary.expiries_up} of ${summary.expiries}`}
            note={`Pass needs ${pass.expiries_up} of ${pass.expiries}`}
          />
          <StatCard
            label="Journal"
            value={block.chain.ok ? 'Intact' : 'Broken'}
            tone={block.chain.ok ? 'positive' : 'negative'}
            note="Hash chain checked on every read"
          />
        </div>
        {window ? (
          <div>
            <div className="mb-1.5 text-xs font-medium uppercase tracking-wider text-faint">
              Window for the {formatDay(window.expiry)} expiry
            </div>
            <WindowStrip window={window} />
          </div>
        ) : (
          <p className="text-sm text-muted">No expiry window is open yet.</p>
        )}
      </div>
    </Card>
  );
}

export function CommodityOverview() {
  const overview = useCommodityOverview();
  const forward = useCommodityForward();
  const f = forward.data;
  const o = overview.data;
  return (
    <div className="space-y-5">
      {forward.error ? (
        <StateMessage
          variant="error"
          title="Could not read the forward tests"
          description={forward.error}
        />
      ) : f === null ? (
        <Card>
          <SkeletonRows rows={2} />
        </Card>
      ) : (
        f.rules.map((block, i) => (
          <ForwardCard
            key={block.rule.key}
            block={block}
            refresh={
              i === 0 ? (
                <RefreshButton
                  onClick={() => {
                    overview.refetch();
                    forward.refetch();
                  }}
                  loading={overview.loading || forward.loading}
                />
              ) : null
            }
          />
        ))
      )}

      <Card>
        <CardHeader title="The four minis" description={COMMODITY_SECTION_META.data.explanation} />
        {overview.error ? (
          <StateMessage
            variant="error"
            title="Could not read the commodity data"
            description={overview.error}
          />
        ) : o === null ? (
          <SkeletonRows rows={3} />
        ) : (
          <div className="space-y-3">
            {o.errors.length > 0 ? (
              <StateMessage
                variant="error"
                title="A root could not be read"
                description={o.errors.join('; ')}
              />
            ) : null}
            <div className={cn('grid gap-3 sm:grid-cols-2 xl:grid-cols-4')}>
              {o.roots.map((r) => (
                <RootCard key={r.root} root={r} asOf={o.as_of} />
              ))}
            </div>
            <p className="text-[11px] text-faint">
              Only gold’s expiry calendar is kept current (the forward test extends it); another
              root shows where its calendar ends rather than a guess.
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}
