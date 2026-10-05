/**
 * PersonalitiesView — every trading personality (GET /api/personalities?include_inactive=true,
 * filtered client-side by the Active / Include paused toggle), its recent performance joined
 * from the latest-100 trades window (lib/personalities.ts), expandable full parameters, the
 * suggestions inbox and the Edit dialog.
 */

import { useMemo, useState } from 'react';

import { TRADES_WINDOW_CAPTION, usePaperTrades } from '../hooks/usePaperTrades';
import { usePersonalities } from '../hooks/usePersonalities';
import { formatInt } from '../lib/format';
import {
  type PersonalitySort,
  type PersonalitySortKey,
  joinPerformance,
  nextSort,
  sortPersonalities,
  visiblePersonalities,
} from '../lib/personalities';
import type { Personality } from '../types/trading';
import { EditPersonalityDialog } from './EditPersonalityDialog';
import { PendingSuggestionsCard } from './PendingSuggestionsCard';
import { PersonalitiesTable } from './personalities/PersonalitiesTable';
import { Card } from './ui/Card';
import { RefreshButton } from './ui/RefreshButton';
import { SegmentedControl } from './ui/SegmentedControl';
import { SkeletonRows } from './ui/Skeleton';
import { StateMessage } from './ui/StateMessage';

type Scope = 'active' | 'all';

export function PersonalitiesView() {
  // Always fetch every personality: the toggle filters client-side, and the suggestions inbox
  // and the integrity check need the paused ones too.
  const { personalities, loading, error, refresh } = usePersonalities(true);
  const { trades, error: tradesError } = usePaperTrades();

  const [scope, setScope] = useState<Scope>('active');
  const [sort, setSort] = useState<PersonalitySort | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  // The personality being edited; null = dialog closed.
  const [editing, setEditing] = useState<Personality | null>(null);

  const performance = useMemo(
    () => joinPerformance(personalities, trades),
    [personalities, trades],
  );
  const rows = useMemo(
    () =>
      sortPersonalities(
        visiblePersonalities(personalities, scope === 'all'),
        sort,
        performance.byId,
      ),
    [personalities, scope, sort, performance],
  );
  const pausedCount = personalities.filter((p) => !p.is_active).length;
  const hasData = personalities.length > 0;

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <PendingSuggestionsCard personalities={personalities} onApplied={refresh} />

      <Card flush>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h2 className="text-base font-semibold tracking-tight text-foreground">
              Trading personalities
            </h2>
            <p className="mt-0.5 text-sm text-muted">
              How each personality picks and manages trades, and how it has done recently. Click a
              row for all of its settings.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <SegmentedControl<Scope>
              ariaLabel="Which personalities to show"
              size="sm"
              value={scope}
              onChange={setScope}
              options={[
                { value: 'active', label: 'Active' },
                {
                  value: 'all',
                  label: `Include paused${pausedCount > 0 ? ` (${formatInt(pausedCount)})` : ''}`,
                },
              ]}
            />
            <RefreshButton onClick={refresh} loading={loading} />
          </div>
        </div>

        <div className="px-2 py-1">
          {loading && !hasData && <SkeletonRows rows={5} className="px-1 pt-2" />}
          {error !== null && (
            <StateMessage
              variant="error"
              title="Couldn't load personalities"
              description={error}
              className="m-3"
            />
          )}
          {!loading && error === null && !hasData && (
            <StateMessage
              variant="empty"
              title="No personalities found"
              description="They appear once the database has been set up with its starting personalities."
            />
          )}
          {hasData && rows.length === 0 && (
            <StateMessage
              variant="empty"
              title="No active personalities"
              description="Every personality is paused. Choose Include paused to see them."
            />
          )}
          {rows.length > 0 && (
            <PersonalitiesTable
              personalities={rows}
              performance={performance.byId}
              sort={sort}
              onSort={(key: PersonalitySortKey) => setSort((current) => nextSort(current, key))}
              expanded={expanded}
              onToggle={toggle}
              onEdit={setEditing}
            />
          )}
        </div>

        {hasData && (
          <p className="border-t border-border px-5 py-3 text-xs text-faint">
            Net P&amp;L, Win % and Trades cover the {TRADES_WINDOW_CAPTION.toLowerCase()} across all
            personalities, not full history.
            {performance.unattributed > 0
              ? ` ${formatInt(performance.unattributed)} of them carry no personality and are not counted.`
              : ''}
            {tradesError !== null ? ` Trades could not be loaded (${tradesError}).` : ''}
          </p>
        )}
      </Card>

      {/* Mounts only while editing, so the form's state is scoped to one edit. */}
      {editing !== null && (
        <EditPersonalityDialog
          personality={editing}
          personalities={personalities}
          open={true}
          onOpenChange={(next) => {
            if (!next) setEditing(null);
          }}
          onSaved={refresh}
        />
      )}
    </div>
  );
}
