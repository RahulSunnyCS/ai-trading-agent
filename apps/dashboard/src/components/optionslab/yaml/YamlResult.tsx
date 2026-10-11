/**
 * The YAML engine's result: the one component for a run that has just finished (Builder ›
 * YAML) and for a stored run opened from Runs. The registry keeps a stored run's headline
 * figures only, so `result` is null there and the per-session parts say so instead.
 *
 * Every rupee figure here is a TOTAL over the run at the lots the strategy held; the only
 * per-lot figure the engine reports is the rate "net per lot-day".
 */

import { formatDay, formatInr, formatInt, formatNumber, formatPct } from '../../../lib/format';
import { type YamlHeadline, sessionEquity } from '../../../lib/optionsRuns';
import type { RunResult } from '../../../types/backtest';
import { Badge } from '../../ui/Badge';
import { Card, CardHeader } from '../../ui/Card';
import { StatCard } from '../../ui/StatCard';
import { THead, TRow, Table, Td, Th } from '../../ui/Table';
import { RegimeBadge } from '../regimes/RegimeBadge';
import { CumulativeLines, pnlClass } from '../shared';

function tone(value: number): 'positive' | 'negative' | 'default' {
  if (value > 0) return 'positive';
  if (value < 0) return 'negative';
  return 'default';
}

function SectionTitle({ children }: { children: string }) {
  return <h3 className="mb-2 mt-6 text-sm font-semibold text-foreground">{children}</h3>;
}

export function YamlKpis({
  headline,
  margin,
}: { headline: YamlHeadline; margin?: RunResult['margin'] }) {
  const winRate = headline.sessions > 0 ? headline.winDays / headline.sessions : null;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
      <StatCard
        label="Net"
        value={formatInr(headline.net)}
        tone={tone(headline.net)}
        note="Total, after costs"
      />
      {headline.gross !== null && (
        <StatCard
          label="Gross"
          value={formatInr(headline.gross)}
          tone={tone(headline.gross)}
          note={`Costs ${formatInr(headline.gross - headline.net)}`}
        />
      )}
      <StatCard
        label="Win days"
        value={`${formatInt(headline.winDays)} / ${formatInt(headline.sessions)}`}
        note={winRate === null ? undefined : `${formatPct(winRate, 0)} of sessions`}
      />
      <StatCard
        label="Worst day"
        value={formatInr(headline.worstDay)}
        tone={tone(headline.worstDay)}
        note="Total, one session"
      />
      <StatCard
        label="Net per lot-day"
        value={formatInr(headline.inrPerLotDay)}
        tone={tone(headline.inrPerLotDay)}
        hint="Net divided by lot-days: one lot held for one session is one lot-day. The engine's size-neutral rate."
        note={`${formatNumber(headline.lotDays, 2, { trim: true })} lot-days`}
      />
      <StatCard
        label="Sum of peak losses"
        value={formatInr(headline.sumPeakLoss)}
        tone={tone(headline.sumPeakLoss)}
        hint="Each session's deepest intraday loss, added up over the run."
      />
      {margin ? (
        <StatCard
          label="Return on peak margin"
          value={formatPct(margin.return_on_peak_margin, 2)}
          tone={tone(margin.return_on_peak_margin)}
          note={`Peak ${formatInr(margin.peak_margin_inr, { compact: true })}`}
        />
      ) : null}
    </div>
  );
}

export function YamlResult({
  headline,
  result,
  title = 'Result',
  description,
}: {
  headline: YamlHeadline;
  /** The full result of a run made in this session; null for a run read from the registry. */
  result: RunResult | null;
  title?: string;
  description?: string;
}) {
  const equity = result ? sessionEquity(result.sessions) : [];
  const sessions = result ? [...result.sessions].sort((a, b) => a.date.localeCompare(b.date)) : [];
  const dte = result
    ? Object.entries(result.dte_buckets).sort(([a], [b]) => Number(a) - Number(b))
    : [];
  const regimes = result?.regime_buckets ? Object.entries(result.regime_buckets) : [];

  return (
    <Card>
      <CardHeader title={title} description={description ?? `Run ${headline.runId}`} />
      <YamlKpis headline={headline} margin={result?.margin ?? null} />

      {result?.margin ? (
        <p className="mt-3 text-xs text-muted">
          Peak margin {formatInr(result.margin.peak_margin_inr)}:{' '}
          {formatInt(result.margin.peak_lots)} lots × {formatInr(result.margin.margin_per_lot_inr)}{' '}
          per lot on {formatDay(result.margin.peak_date)}, margin category{' '}
          {result.margin.strategy_type}.
        </p>
      ) : null}

      {result === null ? (
        <p className="mt-4 text-sm text-muted">
          The run registry keeps these headline figures only. The equity curve, the DTE and regime
          breakdowns and the per-session rows exist for a run made in this session, in Builder ›
          YAML.
        </p>
      ) : (
        <>
          <SectionTitle>Equity: cumulative net by session</SectionTitle>
          {equity.length >= 2 ? (
            <CumulativeLines lines={[{ id: 'Cumulative net', points: equity }]} />
          ) : (
            <p className="text-sm text-muted">
              A curve needs at least two sessions; this run has {formatInt(equity.length)}.
            </p>
          )}

          <div className="grid gap-x-8 lg:grid-cols-2">
            <div>
              <SectionTitle>By days to expiry</SectionTitle>
              <Table>
                <THead>
                  <Th>DTE</Th>
                  <Th align="right">Net (total)</Th>
                </THead>
                <tbody>
                  {dte.map(([days, net]) => (
                    <TRow key={days}>
                      <Td numeric>{days}</Td>
                      <Td align="right" numeric className={pnlClass(net)}>
                        {formatInr(net)}
                      </Td>
                    </TRow>
                  ))}
                </tbody>
              </Table>
            </div>
            <div>
              <SectionTitle>By the previous session's regime</SectionTitle>
              {regimes.length === 0 ? (
                <p className="text-sm text-muted">
                  {result?.regime_status === 'connect_failed' ||
                  result?.regime_status === 'missing_table'
                    ? `Regime tags could not be read: ${result.regime_message ?? result.regime_status}.`
                    : 'No regime tags for this window. They come from the trading database, which the backtest service reads only when it is given a database URL.'}
                </p>
              ) : (
                <Table>
                  <THead>
                    <Th>Regime</Th>
                    <Th align="right">Net (total)</Th>
                  </THead>
                  <tbody>
                    {regimes.map(([key, net]) => (
                      <TRow key={key}>
                        <Td>
                          <RegimeBadge regime={key} />
                        </Td>
                        <Td align="right" numeric className={pnlClass(net)}>
                          {formatInr(net)}
                        </Td>
                      </TRow>
                    ))}
                  </tbody>
                </Table>
              )}
            </div>
          </div>

          <SectionTitle>Sessions</SectionTitle>
          <Table maxHeight={420} stickyFirstCol>
            <THead>
              <Th>Date</Th>
              <Th align="right">DTE</Th>
              <Th align="right">Net</Th>
              <Th align="right">Gross</Th>
              <Th align="right">Cost</Th>
              <Th align="right">Lots</Th>
              <Th align="right">Lot-days</Th>
              <Th align="right">Peak loss</Th>
            </THead>
            <tbody>
              {sessions.map((s) => (
                <TRow key={s.date}>
                  <Td className="whitespace-nowrap">{formatDay(s.date)}</Td>
                  <Td align="right" numeric>
                    {formatInt(s.dte)}
                  </Td>
                  <Td align="right" numeric className={pnlClass(s.net)}>
                    {formatInr(s.net)}
                  </Td>
                  <Td align="right" numeric className={pnlClass(s.gross)}>
                    {formatInr(s.gross)}
                  </Td>
                  <Td align="right" numeric>
                    {formatInr(s.cost)}
                  </Td>
                  <Td align="right" numeric>
                    {formatInt(s.total_lots)}
                  </Td>
                  <Td align="right" numeric>
                    {formatNumber(s.lot_days, 2, { trim: true })}
                  </Td>
                  <Td align="right" numeric className={pnlClass(s.peak_loss)}>
                    {formatInr(s.peak_loss)}
                  </Td>
                </TRow>
              ))}
            </tbody>
          </Table>
        </>
      )}
    </Card>
  );
}
