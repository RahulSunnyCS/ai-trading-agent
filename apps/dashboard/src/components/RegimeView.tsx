/**
 * RegimeView — the live tagger's daily regimes (GET /api/regime-tags) for one underlying over
 * a 30 / 90 / 180-day window: a strip of trading days, the share of days per regime, paper-
 * trade P&L by the regime of each trade's exit day, and the raw tags.
 *
 * Every regime renders through lib/regimeMeta.ts (`<RegimeBadge>`), the dashboard's one regime
 * vocabulary; the derivations are in lib/regimeTags.ts.
 */

import { useMemo, useState } from 'react';

import { usePaperTrades } from '../hooks/usePaperTrades';
import { useRegimeTags } from '../hooks/useRegimeTags';
import { EMPTY, formatDay, formatInt, formatIstDateTimeShort, formatPct } from '../lib/format';
import { regimeMeta } from '../lib/regimeMeta';
import {
  REGIME_WINDOWS,
  type RegimeWindow,
  dayRegimes,
  pnlByRegime,
  presentRegimes,
  regimeDistribution,
  stripCells,
  underlyingOptions,
  weekdayOf,
  windowRange,
} from '../lib/regimeTags';
import { RegimeBadge } from './optionslab/regimes/RegimeBadge';
import { RegimeDistribution } from './regime/RegimeDistribution';
import { RegimePnlTable } from './regime/RegimePnlTable';
import { RegimeStrip } from './regime/RegimeStrip';
import { Card, CardHeader } from './ui/Card';
import { InfoTooltip } from './ui/InfoTooltip';
import { Select } from './ui/Input';
import { RefreshButton } from './ui/RefreshButton';
import { SegmentedControl } from './ui/SegmentedControl';
import { SkeletonRows } from './ui/Skeleton';
import { StateMessage } from './ui/StateMessage';
import { THead, TRow, Table, Td, Th } from './ui/Table';
import { Toolbar, ToolbarSpacer } from './ui/Toolbar';

const ALL = 'ALL';

const WINDOW_OPTIONS = REGIME_WINDOWS.map((days) => ({
  value: String(days) as `${RegimeWindow}`,
  label: `${days} days`,
}));

export function RegimeView() {
  const [underlying, setUnderlying] = useState('NIFTY');
  const [windowDays, setWindowDays] = useState<RegimeWindow>(90);
  const [regimeFilter, setRegimeFilter] = useState<string>(ALL);

  // Fixed per window choice; the endpoint takes from / to, so the window is fetched, not cut.
  const range = useMemo(() => windowRange(windowDays), [windowDays]);
  const { tags, loading, error, refresh } = useRegimeTags(underlying, range.from, range.to);
  const { trades, error: tradesError } = usePaperTrades();

  const days = useMemo(() => dayRegimes(tags), [tags]);
  const cells = useMemo(() => stripCells(days), [days]);
  const distribution = useMemo(() => regimeDistribution(days), [days]);
  const regimes = useMemo(() => presentRegimes(days), [days]);
  const pnl = useMemo(
    () => pnlByRegime(trades, days, { underlying, from: range.from, to: range.to }),
    [trades, days, underlying, range],
  );
  const underlyings = useMemo(
    () => underlyingOptions(underlying, tags, trades),
    [underlying, tags, trades],
  );

  const highlight = regimeFilter === ALL ? null : regimeFilter;
  const tableDays = useMemo(
    () => [...days].reverse().filter((d) => highlight === null || d.regime === highlight),
    [days, highlight],
  );
  const windowCaption = `${formatDay(range.from)} – ${formatDay(range.to)}`;
  const hasData = days.length > 0;

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Market regimes"
          description={`The live tagger's regime for each trading day · ${windowCaption}`}
          actions={<RefreshButton onClick={refresh} loading={loading} />}
          className="mb-3"
        />
        <Toolbar ariaLabel="Regime filters">
          <Select
            aria-label="Underlying"
            value={underlying}
            onChange={(event) => {
              setUnderlying(event.target.value);
              setRegimeFilter(ALL);
            }}
            className="w-36"
          >
            {underlyings.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </Select>
          <SegmentedControl
            ariaLabel="Window"
            size="sm"
            value={String(windowDays) as `${RegimeWindow}`}
            options={WINDOW_OPTIONS}
            onChange={(value) => setWindowDays(Number(value) as RegimeWindow)}
          />
          <Select
            aria-label="Regime"
            value={regimeFilter}
            onChange={(event) => setRegimeFilter(event.target.value)}
            className="w-48"
          >
            <option value={ALL}>All regimes</option>
            {regimes.map((key) => (
              <option key={key} value={key}>
                {regimeMeta(key).glyph} {regimeMeta(key).label}
              </option>
            ))}
          </Select>
          <ToolbarSpacer />
          <span className="text-xs text-faint">
            {hasData ? `${formatInt(days.length)} tagged days` : ''}
          </span>
        </Toolbar>
      </Card>

      {loading && !hasData ? (
        <Card>
          <SkeletonRows rows={4} />
        </Card>
      ) : null}
      {error !== null ? (
        <StateMessage variant="error" title="Couldn't load regime tags" description={error} />
      ) : null}
      {!loading && error === null && !hasData ? (
        <Card>
          <StateMessage
            variant="empty"
            title={`No regime tags for ${underlying} in this window`}
            description="Tags appear after the EOD retrospection engine classifies a trading day; today the tagger runs for NIFTY only."
          />
        </Card>
      ) : null}

      {hasData ? (
        <>
          <Card>
            <CardHeader
              title="Day by day"
              description="One cell per weekday, oldest first; focus or hover a day to read it. Dashed cells have no tag."
            />
            <RegimeStrip cells={cells} highlight={highlight} />
          </Card>

          <Card>
            <CardHeader
              title="Share of days"
              description={`Of ${formatInt(distribution.total)} tagged days in the window`}
            />
            <RegimeDistribution rows={distribution.rows} total={distribution.total} />
          </Card>

          <Card>
            <CardHeader
              title={
                <span className="inline-flex items-center gap-1.5">
                  P&amp;L by regime
                  <InfoTooltip
                    label="About P&L by regime"
                    text="Closed paper trades on this underlying, grouped by the regime of the IST day they exited; from the latest 100 trades the API returns."
                  />
                </span>
              }
              description="Net P&L of closed paper trades by the regime of their exit day"
            />
            {tradesError !== null && trades.length === 0 ? (
              <StateMessage
                variant="error"
                title="Couldn't load paper trades"
                description={tradesError}
              />
            ) : (
              <RegimePnlTable pnl={pnl} windowCaption={windowCaption} />
            )}
          </Card>

          <Card flush>
            <div className="border-b border-border px-5 py-4">
              <h2 className="text-base font-semibold tracking-tight text-foreground">Tags</h2>
              <p className="mt-0.5 text-sm text-muted">Most recent first</p>
            </div>
            <div className="px-2 py-1">
              {tableDays.length === 0 ? (
                <StateMessage variant="empty" title="No days with this regime in the window" />
              ) : (
                <Table>
                  <THead>
                    <Th>Date (IST)</Th>
                    <Th>Regime</Th>
                    <Th align="right">Confidence</Th>
                    <Th>Classified at (IST)</Th>
                  </THead>
                  <tbody>
                    {tableDays.map((d) => (
                      <TRow key={d.day}>
                        <Td numeric>
                          {weekdayOf(d.day)} {formatDay(d.day)}
                        </Td>
                        <Td>
                          <RegimeBadge regime={d.regime} />
                        </Td>
                        <Td numeric align="right">
                          {d.confidence === null ? EMPTY : formatPct(d.confidence, 1)}
                        </Td>
                        <Td numeric className="text-muted">
                          {formatIstDateTimeShort(d.classifiedAt)}
                        </Td>
                      </TRow>
                    ))}
                  </tbody>
                </Table>
              )}
            </div>
          </Card>
        </>
      ) : null}
    </div>
  );
}
