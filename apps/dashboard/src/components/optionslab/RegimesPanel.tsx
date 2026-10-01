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

import { DEFAULT_CUTS, useAnatomy } from '../../hooks/useLegwise';
import { styleProxies, zscore } from '../../lib/legwiseJoin';
import {
  type Label,
  associationTest,
  baseRates,
  crossTab,
  meanRunLength,
  permutationTest,
  rollingShare,
  stayRate,
  transitions,
} from '../../lib/regimeStats';
import type { AnatomyResponse, DayAnatomy } from '../../types/legwise';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { StateMessage } from '../ui/StateMessage';
import {
  CalendarHeatmap,
  CrossTabTable,
  HeatmapLegend,
  LabelMixTable,
  STATES,
  TransitionMatrix,
} from './RegimeViews';
import { CumulativeLines, Field, Select, TextInput } from './shared';

const CUTS_KEY = 'optionslab.cuts';
const MIN_DAYS_FOR_CLAIMS = 60;
const RANGES = [
  { value: 'all', label: 'All history' },
  { value: '1y', label: 'Last 1 year' },
  { value: '6m', label: 'Last 6 months' },
  { value: '3m', label: 'Last 3 months' },
] as const;
type RangeKey = (typeof RANGES)[number]['value'];

function loadCuts(): string[] {
  try {
    const raw = window.localStorage.getItem(CUTS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed) && parsed.every((c) => typeof c === 'string')) return parsed;
  } catch {
    // storage blocked or corrupt: fall back to the defaults
  }
  return [...DEFAULT_CUTS];
}

function fromDate(range: RangeKey): string | undefined {
  if (range === 'all') return undefined;
  const d = new Date();
  d.setMonth(d.getMonth() - { '1y': 12, '6m': 6, '3m': 3 }[range]);
  return d.toISOString().slice(0, 10);
}

/** Client-side mirror of anatomy.parse_cuts, so a typo never costs a round trip. */
export function validateCuts(cuts: string[]): string | null {
  if (cuts.length === 0 || cuts.length > 4) return 'Use between 1 and 4 cut times.';
  if (cuts.some((c) => !/^\d{2}:\d{2}$/.test(c))) return 'Cut times must look like 10:30.';
  const minutes = cuts.map((c) => Number(c.slice(0, 2)) * 60 + Number(c.slice(3)));
  if (minutes.some((m) => m <= 9 * 60 + 15 || m >= 15 * 60 + 30)) {
    return 'Cuts must fall inside the session (09:16–15:29).';
  }
  if (minutes.some((m, i) => i > 0 && m <= (minutes[i - 1] ?? 0))) {
    return 'Cuts must be in increasing order.';
  }
  return null;
}

/** One label per day for a series (-1 = whole day, else a segment index); null = unknown. */
function labelsFor(days: DayAnatomy[], idx: number): Label[] {
  return days.map((d) => (idx < 0 ? d.whole?.label : d.segments[idx]?.label) ?? null);
}

function segmentNames(cuts: string[]): string[] {
  const edges = ['09:15', ...cuts, '15:30'];
  return edges.slice(1).map((e, i) => `${edges[i]}–${e}`);
}

export function RegimesPanel() {
  const [cuts, setCuts] = useState<string[]>(loadCuts);
  const [draft, setDraft] = useState<string[]>(cuts);
  const [range, setRange] = useState<RangeKey>('all');
  const [series, setSeries] = useState(-1); // -1 = whole day
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(1);

  const res = useAnatomy('NIFTY', cuts, { from: fromDate(range) });
  const data: AnatomyResponse | null = res.data;
  const names = useMemo(() => segmentNames(cuts), [cuts]);
  const draftError = validateCuts(draft);

  useEffect(() => {
    try {
      window.localStorage.setItem(CUTS_KEY, JSON.stringify(cuts));
    } catch {
      // not persisted: the tab still works
    }
  }, [cuts]);
  // Keep the selectors inside the segment list when the number of cuts changes.
  useEffect(() => {
    setSeries((s) => (s >= names.length ? -1 : s));
    setFrom((f) => Math.min(f, names.length - 1));
    setTo((t) => Math.min(Math.max(t, 1), names.length - 1));
  }, [names.length]);

  const days = useMemo(() => data?.days ?? [], [data]);
  const labels = useMemo(() => labelsFor(days, series), [days, series]);

  const analysis = useMemo(() => {
    const t = transitions(labels, STATES);
    const base = baseRates(labels);
    return {
      t,
      base,
      stay: permutationTest(labels, stayRate),
      run: permutationTest(labels, meanRunLength),
    };
  }, [labels]);

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
    const pick = (idx: number) => (d: (typeof days)[number]) =>
      idx < 0 ? d.whole : d.segments[idx];
    const seg = pick(series);
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
      { id: 'trend days %', points: rollingShare(trend, 20) },
      { id: 'realised < implied %', points: rollingShare(calm, 20) },
    ];
  }, [days, series]);

  const proxies = useMemo(() => {
    const p = styleProxies(days, series, 10);
    return [
      {
        id: 'short-premium proxy',
        points: p.premium.map((x) => ({ time: x.time, value: x.value })),
      },
      {
        id: 'directional proxy',
        points: p.directional.map((x) => ({ time: x.time, value: x.value })),
      },
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
  const nDays = days.length;
  const thin = nDays < MIN_DAYS_FOR_CLAIMS;

  function apply() {
    if (draftError === null) setCuts(draft);
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Market regimes"
          description="How the index behaved inside each part of the session, from NIFTY 1-minute bars and India VIX. A label is only known after the day — read persistence lag-1 (yesterday → today) before using it for anything."
        />
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Cut times (segment edges)">
            <div className="flex gap-1.5">
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
            onClick={() => draft.length < 4 && setDraft([...draft, '14:30'])}
          >
            + cut
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => draft.length > 1 && setDraft(draft.slice(0, -1))}
          >
            − cut
          </Button>
          <Button size="sm" variant="primary" disabled={draftError !== null} onClick={apply}>
            Apply
          </Button>
          <Field label="Range">
            <Select value={range} options={RANGES} onChange={setRange} />
          </Field>
        </div>
        {draftError && <p className="mt-2 text-xs text-negative">{draftError}</p>}
        {res.error && !data && (
          <div className="mt-3">
            <StateMessage
              variant="error"
              title="Couldn't load the index history"
              description={res.error}
            />
          </div>
        )}
        {data && nDays === 0 && (
          <div className="mt-3">
            <StateMessage
              variant="empty"
              title="No index history yet"
              description="Run `uv run obt fyers history` (from packages/option-backtesting, with a Fyers login) to backfill NIFTY and India VIX."
            />
          </div>
        )}
        {nDays > 0 && (
          <p className="mt-3 text-xs text-muted">
            {nDays} days · {days[0]?.day} → {days[nDays - 1]?.day} · QUIET = range under{' '}
            {data?.thresholds.quiet_range_over_implied}× the VIX-implied range, TREND = at least{' '}
            {data?.thresholds.trend_strength}× as directional as a random walk would be. These
            thresholds are first guesses — check the label mix below before trusting a pattern.
            {thin && (
              <span className="text-warning">
                {' '}
                Fewer than {MIN_DAYS_FOR_CLAIMS} days: read the calendar, not the statistics.
              </span>
            )}
          </p>
        )}
      </Card>

      {nDays > 0 && (
        <>
          <Card>
            <CardHeader
              title="Calendar"
              description="One cell per trading day (columns = weeks, rows = Mon–Fri). Runs of one colour are the 'periods'."
              actions={<HeatmapLegend />}
            />
            <div className="space-y-3">
              {[-1, ...names.map((_, i) => i)].map((idx) => (
                <CalendarHeatmap
                  key={idx}
                  days={days}
                  series={idx}
                  caption={idx < 0 ? 'Whole day' : (names[idx] ?? '')}
                />
              ))}
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Label mix"
              description="Share of days in each state, per segment. If one state dominates, the threshold is wrong, not the market."
            />
            <LabelMixTable rows={mixRows} />
          </Card>

          <Card>
            <CardHeader
              title="Do regimes persist?"
              description="Today's label → next day's label, beside the base rate. Bold green / red = at least 10 points above / below base with 5+ cases behind the cell; faded rows have under 20 days."
              actions={
                <Select
                  value={String(series)}
                  options={seriesOptions}
                  onChange={(v) => setSeries(Number(v))}
                />
              }
            />
            <TransitionMatrix t={analysis.t} base={analysis.base} />
            <div className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              <Verdict
                title="Stays in the same state"
                test={analysis.stay}
                fmt={(v) => `${(v * 100).toFixed(0)}%`}
                thin={thin}
              />
              <Verdict
                title="Average run length (days)"
                test={analysis.run}
                fmt={(v) => v.toFixed(2)}
                thin={thin}
              />
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Rolling 20-day share"
              description="Share of the last 20 days that were trend days, and that realised less range than VIX implied (above 50% ≈ a premium-selling climate)."
            />
            <CumulativeLines lines={rolling} />
          </Card>

          <Card>
            <CardHeader
              title="Which style suited the period?"
              description="Rolling 10-day sums over the full index history, each line standardised against its own history (above 0 = better than that style's usual). PROXIES, not P&L: short-premium = VIX-implied move − realised move (a straddle seller's payoff shape); directional = efficiency × realised move (a big move that stayed clean). Compare with the calendar: do the two take turns?"
            />
            <CumulativeLines lines={proxies} />
          </Card>

          {data && data.t33.status !== 'ok' && data.t33.status !== 'empty' && (
            <p className="text-xs text-muted">
              T-33 cross-check unavailable
              {data.t33.status === 'unavailable'
                ? ': export DATABASE_URL in the process running obt-api to compare with the live regime tagger.'
                : `: ${data.t33.message ?? 'unknown error'}`}
            </p>
          )}
          {t33Tab && (
            <Card>
              <CardHeader
                title="Cross-check vs the live regime tagger (T-33)"
                description={`How this tab's whole-day label lines up with apps/server's daily_regime_tags on ${t33Tab.n} days. Different inputs (straddle snapshots to 14:30 vs index + VIX all day), so expect partial agreement — a TRENDING_STRONG tag that never lands on Trend days would mean one of the two is off.`}
              />
              <CrossTabTable
                t={t33Tab.table}
                aName="This tab"
                bName="T-33"
                colLabel={(c) => c.replaceAll('_', ' ').toLowerCase()}
              />
            </Card>
          )}

          {within && (
            <Card>
              <CardHeader
                title="Within the day"
                description="Does one part of the day predict another — e.g. a trending open followed by a quiet close?"
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
                  fmt={(v) => v.toFixed(1)}
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
}: {
  title: string;
  test: { observed: number; chanceMean: number; p: number; iterations: number } | null;
  fmt: (v: number) => string;
  thin: boolean;
}) {
  if (!test) return <div className="text-muted">{title}: not enough days.</div>;
  const significant = test.p < 0.05 && !thin;
  return (
    <div className="rounded-lg border border-border bg-surface-2/50 px-3 py-2.5">
      <div className="text-xs font-medium uppercase tracking-wider text-faint">{title}</div>
      <div className="metric mt-1">
        <span className="text-lg font-semibold">{fmt(test.observed)}</span>
        <span className="ml-2 text-muted">by chance {fmt(test.chanceMean)}</span>
      </div>
      <div className={`mt-0.5 text-xs ${significant ? 'text-positive' : 'text-muted'}`}>
        p = {test.p.toFixed(3)} (shuffled day order, {test.iterations} runs) ·{' '}
        {thin
          ? 'too few days to call'
          : significant
            ? 'more than chance explains'
            : 'consistent with chance'}
      </div>
    </div>
  );
}
