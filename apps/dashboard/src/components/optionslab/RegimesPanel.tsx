/**
 * Options Lab → Market regimes: does the market come in persistent periods?
 *
 * Built on the index + India VIX history alone (GET /legwise/anatomy), so it works over
 * years — option P&L only goes back as far as the daily collector has run. Each day's
 * segments are labelled QUIET / CHOP / TREND_UP / TREND_DOWN (legwise/anatomy.py); this
 * tab shows them as a calendar, measures how sticky each label is against a shuffled
 * baseline, and tests whether one part of the day predicts another.
 *
 * Labels are known only AFTER their day: persistence found here is actionable only
 * read lag-1 (yesterday → today). The tab says so.
 */

import { useEffect, useMemo, useState } from 'react';

import { useAnatomy } from '../../hooks/useLegwise';
import { formatDay, formatInt, formatMultiple, formatNumber, formatPct } from '../../lib/format';
import { styleProxies, zscore } from '../../lib/legwiseJoin';
import { regimeMeta } from '../../lib/regimeMeta';
import {
  type ExpiryFilter,
  type Label,
  associationTest,
  baseRates,
  crossTab,
  expiryCounts,
  filterByExpiry,
  matchesExpiry,
  meanRunLength,
  permutationTest,
  rollingShare,
  stayRateInto,
  transitionsInto,
} from '../../lib/regimeStats';
import {
  MAX_CUTS,
  MIN_CUTS,
  isDefaultCuts,
  sameCuts,
  segmentNames,
  useRegimeCuts,
  useRegimeCutsStore,
  validateCuts,
} from '../../store/regimeCuts';
import type { AnatomyResponse, DayAnatomy } from '../../types/legwise';
import { Accordion } from '../ui/Accordion';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { CodeBlock } from '../ui/CodeBlock';
import { InfoTooltip } from '../ui/InfoTooltip';
import { SegmentedControl } from '../ui/SegmentedControl';
import { SkeletonRows } from '../ui/Skeleton';
import { StateMessage } from '../ui/StateMessage';
import {
  CalendarHeatmap,
  CrossTabTable,
  HeatmapLegend,
  LabelMixTable,
  LiftLegend,
  STATES,
  TransitionMatrix,
} from './RegimeViews';
import { CommandHint } from './regimes/CommandHint';
import { RegimeBadge } from './regimes/RegimeBadge';
import { ShareChart } from './regimes/ShareChart';
import { CumulativeLines, Field, Select, TextInput } from './shared';

// The cuts live in store/regimeCuts.ts now; this name is kept for existing importers.
export { validateCuts };

const MIN_DAYS_FOR_CLAIMS = 60;
const SHARE_WINDOW = 20;
const PROXY_WINDOW = 10;
const RANGES = [
  { value: 'all', label: 'All history' },
  { value: '1y', label: 'Last 1 year' },
  { value: '6m', label: 'Last 6 months' },
  { value: '3m', label: 'Last 3 months' },
] as const;
type RangeKey = (typeof RANGES)[number]['value'];

const EXPIRY_TEXT: Record<ExpiryFilter, string> = {
  all: 'all days',
  expiry: 'expiry days',
  non_expiry: 'non-expiry days',
};

function fromDate(range: RangeKey): string | undefined {
  if (range === 'all') return undefined;
  const d = new Date();
  d.setMonth(d.getMonth() - { '1y': 12, '6m': 6, '3m': 3 }[range]);
  return d.toISOString().slice(0, 10);
}

/** One label per day for a series (-1 = whole day, else a segment index); null = unknown. */
function labelsFor(days: DayAnatomy[], idx: number): Label[] {
  return days.map((d) => (idx < 0 ? d.whole?.label : d.segments[idx]?.label) ?? null);
}

/** A card title with its longer explanation behind an (i). */
function TitleWithInfo({ title, info }: { title: string; info: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {title}
      <InfoTooltip text={info} label={`About ${title}`} />
    </span>
  );
}

export function RegimesPanel() {
  const cuts = useRegimeCuts();
  const setCuts = useRegimeCutsStore((s) => s.setCuts);
  const resetCuts = useRegimeCutsStore((s) => s.resetCuts);
  const [draft, setDraft] = useState<string[]>(() => [...cuts]);
  const [range, setRange] = useState<RangeKey>('all');
  const [expiry, setExpiry] = useState<ExpiryFilter>('all');
  const [series, setSeries] = useState(-1); // -1 = whole day
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(1);

  const res = useAnatomy('NIFTY', cuts, { from: fromDate(range) });
  const data: AnatomyResponse | null = res.data;
  const names = useMemo(() => segmentNames(cuts), [cuts]);
  const draftError = validateCuts(draft);

  // Follow the shared cuts when they change elsewhere (stored cuts arriving, a reset).
  useEffect(() => {
    setDraft([...cuts]);
  }, [cuts]);
  // Keep the selectors inside the segment list when the number of cuts changes.
  useEffect(() => {
    setSeries((s) => (s >= names.length ? -1 : s));
    setFrom((f) => Math.min(f, names.length - 1));
    setTo((t) => Math.min(Math.max(t, 1), names.length - 1));
  }, [names.length]);

  const allDays = useMemo(() => data?.days ?? [], [data]);
  const counts = useMemo(() => expiryCounts(allDays), [allDays]);
  const hasExpiryFlags = counts.expiry + counts.nonExpiry > 0;
  // Never leave the panel on a filter the data cannot answer.
  const filter: ExpiryFilter = hasExpiryFlags ? expiry : 'all';
  /** The days the statistics are about; the calendar still draws every day. */
  const days = useMemo(() => filterByExpiry(allDays, filter), [allDays, filter]);

  const analysis = useMemo(() => {
    // Real day-to-day adjacency over ALL days; a pair counts when its next day is in the filter.
    const labels = labelsFor(allDays, series);
    const keep = allDays.map((d) => matchesExpiry(d, filter));
    return {
      t: transitionsInto(labels, STATES, keep),
      base: baseRates(labelsFor(days, series)),
      stay: permutationTest(labels, (ls) => stayRateInto(ls, keep)),
      run: filter === 'all' ? permutationTest(labels, meanRunLength) : null,
    };
  }, [allDays, days, series, filter]);

  const mixRows = useMemo(
    () =>
      [-1, ...names.map((_, i) => i)].map((idx) => {
        const ls = labelsFor(days, idx);
        return {
          name: idx < 0 ? 'Whole day' : (names[idx] ?? ''),
          rates: baseRates(ls),
          n: ls.filter((l) => l !== null && l !== 'UNKNOWN').length,
        };
      }),
    [days, names],
  );

  const rolling = useMemo(() => {
    const seg = (d: DayAnatomy) => (series < 0 ? d.whole : d.segments[series]);
    const trend = days.map((d) => {
      const s = seg(d);
      return { day: d.day, value: s ? s.label === 'TREND_UP' || s.label === 'TREND_DOWN' : null };
    });
    const calm = days.map((d) => {
      const s = seg(d);
      return {
        day: d.day,
        value: s && s.range_over_implied !== null ? s.range_over_implied < 1 : null,
      };
    });
    return [
      { id: 'Trend days', points: rollingShare(trend, SHARE_WINDOW) },
      { id: 'Moved less than VIX implied', points: rollingShare(calm, SHARE_WINDOW) },
    ];
  }, [days, series]);
  const rollingReady = rolling.some((line) => line.points.length > 0);

  const proxies = useMemo(() => {
    const p = styleProxies(days, series, PROXY_WINDOW);
    return [
      { id: 'short-premium proxy', points: zscore(p.premium) },
      { id: 'directional proxy', points: zscore(p.directional) },
    ];
  }, [days, series]);

  const t33Tab = useMemo(() => {
    const tagged = days.filter((d) => d.t33);
    if (tagged.length === 0) return null;
    const t33States = [...new Set(tagged.map((d) => d.t33 as string))].sort();
    return {
      n: tagged.length,
      states: t33States,
      table: crossTab(
        labelsFor(tagged, -1),
        tagged.map((d) => d.t33 ?? null),
        STATES,
        t33States,
      ),
    };
  }, [days]);

  const within = useMemo(() => {
    if (names.length < 2) return null;
    const a = labelsFor(days, from);
    const b = labelsFor(days, to);
    return {
      table: crossTab(a, b, STATES, STATES),
      test: associationTest(a, b, STATES, STATES),
    };
  }, [days, from, to, names.length]);

  const seriesOptions = [
    { value: '-1', label: 'Whole day' },
    ...names.map((n, i) => ({ value: String(i), label: n })),
  ];
  const segOptions = names.map((n, i) => ({ value: String(i), label: n }));
  const seriesName = series < 0 ? 'Whole day' : (names[series] ?? '');
  const nAll = allDays.length;
  const nDays = days.length;
  const thin = nDays < MIN_DAYS_FOR_CLAIMS;
  const quietCut = formatMultiple(data?.thresholds.quiet_range_over_implied, 1);
  const trendCut = formatMultiple(data?.thresholds.trend_strength, 1);
  const draftChanged = !sameCuts(draft, cuts);

  const seriesSelect = (
    <Select value={String(series)} options={seriesOptions} onChange={(v) => setSeries(Number(v))} />
  );

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title={
            <TitleWithInfo
              title="Market regimes"
              info="A label is only known once its day is over. A pattern found here is usable only when read one day late: yesterday's label against today's outcome."
            />
          }
          description="How the index behaved inside each part of the session, from NIFTY 1-minute bars and India VIX."
        />
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Cut times (segment edges)">
            <div className="flex flex-wrap gap-1.5">
              {draft.map((c, i) => (
                <TextInput
                  // biome-ignore lint/suspicious/noArrayIndexKey: positional inputs, edited in place
                  key={i}
                  value={c}
                  type="time"
                  className="w-32"
                  onChange={(v) => setDraft(draft.map((x, j) => (j === i ? v : x)))}
                />
              ))}
            </div>
          </Field>
          <Button
            size="sm"
            variant="ghost"
            disabled={draft.length >= MAX_CUTS}
            onClick={() => setDraft([...draft, '14:30'])}
          >
            + cut
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={draft.length <= MIN_CUTS}
            onClick={() => setDraft(draft.slice(0, -1))}
          >
            − cut
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={draftError !== null || !draftChanged}
            onClick={() => setCuts(draft)}
          >
            Apply
          </Button>
          {!isDefaultCuts(cuts) && (
            <Button size="sm" variant="ghost" onClick={resetCuts}>
              Reset cuts
            </Button>
          )}
          <Field label="Range">
            <Select value={range} options={RANGES} onChange={setRange} />
          </Field>
          <Field label="Days">
            <SegmentedControl
              ariaLabel="Expiry or non-expiry days"
              size="sm"
              value={filter}
              onChange={setExpiry}
              options={[
                { value: 'all', label: `All (${formatInt(nAll)})` },
                {
                  value: 'expiry',
                  label: `Expiry days (${formatInt(counts.expiry)})`,
                  disabled: !hasExpiryFlags,
                },
                {
                  value: 'non_expiry',
                  label: `Non-expiry days (${formatInt(counts.nonExpiry)})`,
                  disabled: !hasExpiryFlags,
                },
              ]}
            />
          </Field>
        </div>
        {draftError && <p className="mt-2 text-xs text-negative">{draftError}</p>}
        <p className="mt-2 text-xs text-faint">
          These cut times are shared: Daily results and the day replay split the session the same
          way.
        </p>
        {res.loading && !data && <SkeletonRows rows={3} className="mt-3" />}
        {res.error && !data && (
          <div className="mt-3">
            <StateMessage
              variant="error"
              title="Couldn't load the index history"
              description={res.error}
            />
          </div>
        )}
        {data && nAll === 0 && (
          <div className="mt-3">
            <StateMessage
              variant="empty"
              title="No index history yet"
              description={
                <CommandHint
                  command="uv run obt fyers history"
                  where="from packages/option-backtesting"
                >
                  The NIFTY and India VIX minute history has not been downloaded for this range.
                  Downloading it once needs today's Fyers login; after that this tab fills in.
                </CommandHint>
              }
            />
          </div>
        )}
        {nAll > 0 && (
          <>
            <p className="mt-3 text-xs text-muted">
              {formatInt(nDays)} {EXPIRY_TEXT[filter]} · {formatDay(allDays[0]?.day)} →{' '}
              {formatDay(allDays[nAll - 1]?.day)}
              {filter !== 'all' && counts.unknown > 0 && (
                <>
                  {' '}
                  · {formatInt(counts.unknown)} days before {formatDay(data?.dte_reliable_from)}{' '}
                  have no expiry flag and are left out
                </>
              )}
              {thin && (
                <span className="text-warning">
                  {' '}
                  · Fewer than {MIN_DAYS_FOR_CLAIMS} days: read the calendar, not the statistics.
                </span>
              )}
            </p>
            <Accordion title="How this is computed" defaultOpen={false} className="mt-3">
              <dl className="space-y-2 text-sm text-muted">
                {STATES.map((s) => (
                  <div key={s} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <dt>
                      <RegimeBadge regime={s} />
                    </dt>
                    <dd className="min-w-0 flex-1 basis-64">{regimeMeta(s).definition}</dd>
                  </div>
                ))}
              </dl>
              <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted">
                <li>
                  Quiet means the range stayed under {quietCut} the range India VIX implied for that
                  stretch. Above that, a move at least {trendCut} as directional as a random walk is
                  a trend; anything else is chop.
                </li>
                <li>
                  These two thresholds are first guesses. If one label dominates the label mix, the
                  threshold is off, not the market.
                </li>
                <li>
                  Every "by chance" figure comes from shuffling the order of the days 1,000 times,
                  which keeps the label mix and destroys any sequence. p is the share of shuffles
                  that did at least as well.
                </li>
                <li>
                  With Expiry days or Non-expiry days selected, the mix, the share chart, the style
                  proxies and the within-day table use only those days. The persistence table still
                  pairs each day with the trading day before it and counts the pair when the later
                  day is in the selection.
                </li>
              </ul>
            </Accordion>
          </>
        )}
      </Card>

      {nAll > 0 && (
        <>
          <Card>
            <CardHeader
              title="Calendar"
              description="One cell per trading day. Runs of one colour are the periods."
              actions={<HeatmapLegend />}
            />
            <div className="space-y-4">
              {[-1, ...names.map((_, i) => i)].map((idx) => (
                <CalendarHeatmap
                  key={idx}
                  days={allDays}
                  series={idx}
                  caption={idx < 0 ? 'Whole day' : (names[idx] ?? '')}
                  isDimmed={filter === 'all' ? undefined : (d) => !matchesExpiry(d, filter)}
                />
              ))}
            </div>
          </Card>

          <Card>
            <CardHeader
              title={
                <TitleWithInfo
                  title="Label mix"
                  info="Share of days in each state, per segment. If one state dominates, the threshold is wrong, not the market."
                />
              }
              description={`Share of ${EXPIRY_TEXT[filter]} in each state.`}
            />
            <LabelMixTable rows={mixRows} />
          </Card>

          <Card>
            <CardHeader
              title={
                <TitleWithInfo
                  title="Do regimes persist?"
                  info="Each row is today's label; each cell is how often the next trading day got that column's label, with the number of days in brackets. A cell is tinted only with 5 or more days behind it; rows with under 20 days are faded."
                />
              }
              description={
                filter === 'all'
                  ? "Today's label against the next day's, beside the base rate."
                  : `Yesterday's label against the label of the ${EXPIRY_TEXT[filter]} that followed, beside their base rate.`
              }
              actions={seriesSelect}
            />
            <TransitionMatrix t={analysis.t} base={analysis.base} />
            <div className="mt-3">
              <LiftLegend />
            </div>
            <div className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              <Verdict
                title="Stays in the same state"
                test={analysis.stay}
                fmt={(v) => formatPct(v, 0)}
                thin={thin}
              />
              <Verdict
                title="Average run length (days)"
                test={analysis.run}
                fmt={(v) => formatNumber(v, 2)}
                thin={thin}
                unavailable={
                  filter === 'all'
                    ? undefined
                    : 'A run needs adjacent days, so this is measured across all days only.'
                }
              />
            </div>
          </Card>

          <Card>
            <CardHeader
              title={
                <TitleWithInfo
                  title={`Rolling ${SHARE_WINDOW}-day share`}
                  info={`Of the last ${SHARE_WINDOW} ${EXPIRY_TEXT[filter]}: the share that were trend days, and the share where the index moved less than India VIX implied. The second line above 50% is roughly a premium-selling climate.`}
                />
              }
              description={`${seriesName}, ${EXPIRY_TEXT[filter]}. The dashed line is 50%.`}
              actions={seriesSelect}
            />
            {rollingReady ? (
              <ShareChart
                lines={rolling}
                ariaLabel={`Rolling ${SHARE_WINDOW}-day share of trend days and of days that moved less than India VIX implied`}
              />
            ) : (
              <p className="text-sm text-muted">
                This needs at least {SHARE_WINDOW} {EXPIRY_TEXT[filter]} with a label;{' '}
                {formatInt(nDays)} so far.
              </p>
            )}
          </Card>

          <Card>
            <CardHeader
              title={
                <TitleWithInfo
                  title="Which style suited the period?"
                  info={`Rolling ${PROXY_WINDOW}-day sums, each line standardised against its own history (above 0 = better than that style's usual). These are stand-ins, not P&L. Short premium = the move India VIX implied minus the move that happened (a straddle seller's payoff shape). Directional = how clean the move was times how big it was.`}
                />
              }
              description="Market-only stand-ins for two styles, not P&L. Compare with the calendar: do the two take turns?"
            />
            <CumulativeLines lines={proxies} />
          </Card>

          {data && data.t33.status === 'unavailable' && (
            <Card>
              <CardHeader title="Comparison with the live regime tagger" />
              <CommandHint
                command="DATABASE_URL=<your Postgres URL> bun run py:api"
                where="from the repo root, in place of the usual start command"
              >
                This comparison is not shown because the Options Lab service is not connected to the
                trading database, where the live tagger stores its daily regimes. Start the service
                with the database address set:
              </CommandHint>
            </Card>
          )}
          {data && data.t33.status === 'error' && (
            <Card>
              <CardHeader title="Comparison with the live regime tagger" />
              <CommandHint command="docker compose up -d" where="from the repo root">
                This comparison is not shown because the trading database, where the live tagger
                stores its daily regimes, could not be reached. It is usually just not running:
              </CommandHint>
              {data.t33.message && (
                <Accordion title="Technical detail" defaultOpen={false} className="mt-3">
                  <CodeBlock className="whitespace-pre-wrap">{data.t33.message}</CodeBlock>
                </Accordion>
              )}
            </Card>
          )}
          {t33Tab && (
            <Card>
              <CardHeader
                title={
                  <TitleWithInfo
                    title="Comparison with the live regime tagger"
                    info="The two use different inputs: the live tagger reads straddle snapshots up to 14:30, this tab reads the index and India VIX for the whole day. Expect partial agreement. A Strong trend tag that never lands on trend days would mean one of the two is off."
                  />
                }
                description={`How this tab's whole-day label lines up with the live tagger's regime on ${formatInt(t33Tab.n)} days.`}
              />
              <CrossTabTable t={t33Tab.table} aName="This tab" bName="Live tagger" />
            </Card>
          )}

          {within && (
            <Card>
              <CardHeader
                title="Within the day"
                description="Does one part of the day predict another, such as a trending open followed by a quiet close?"
                actions={
                  <div className="flex items-center gap-2 text-xs text-muted">
                    <Select
                      value={String(from)}
                      options={segOptions}
                      onChange={(v) => setFrom(Number(v))}
                    />
                    →
                    <Select
                      value={String(to)}
                      options={segOptions}
                      onChange={(v) => setTo(Number(v))}
                    />
                  </div>
                }
              />
              <CrossTabTable t={within.table} aName={names[from] ?? ''} bName={names[to] ?? ''} />
              <div className="mt-4 text-sm">
                <Verdict
                  title="Association between the two segments (χ²)"
                  test={within.test}
                  fmt={(v) => formatNumber(v, 1)}
                  thin={thin}
                />
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function Verdict({
  title,
  test,
  fmt,
  thin,
  unavailable,
}: {
  title: string;
  test: { observed: number; chanceMean: number; p: number; iterations: number } | null;
  fmt: (v: number) => string;
  thin: boolean;
  /** Why there is no test, when that is by design rather than for lack of days. */
  unavailable?: string | undefined;
}) {
  if (!test) {
    return (
      <div className="rounded-lg border border-border bg-surface-2/50 px-3 py-2.5">
        <div className="text-xs font-medium uppercase tracking-wider text-faint">{title}</div>
        <div className="mt-1 text-muted">{unavailable ?? 'Not enough days.'}</div>
      </div>
    );
  }
  const significant = test.p < 0.05 && !thin;
  return (
    <div className="rounded-lg border border-border bg-surface-2/50 px-3 py-2.5">
      <div className="text-xs font-medium uppercase tracking-wider text-faint">{title}</div>
      <div className="metric mt-1">
        <span className="text-lg font-semibold">{fmt(test.observed)}</span>
        <span className="ml-2 text-muted">by chance {fmt(test.chanceMean)}</span>
      </div>
      <div
        className={`mt-0.5 text-xs ${significant ? 'font-medium text-foreground' : 'text-muted'}`}
      >
        p = {formatNumber(test.p, 3)} (shuffled day order, {formatInt(test.iterations)} runs) ·{' '}
        {thin
          ? 'too few days to call'
          : significant
            ? 'more than chance explains'
            : 'consistent with chance'}
      </div>
    </div>
  );
}
