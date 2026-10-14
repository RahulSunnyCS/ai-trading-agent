/**
 * Options Lab → Strategy builder over the leg-wise schema (legwise/schema.py), as a leg grid
 * (BL-102): a header with the strategy's name and file, a row of tokens for its own settings, one
 * dense row per leg edited in place, the strategy read back in plain words, and below them the
 * run panel with the period, test settings, live validation, Backtest (its credit cost beside
 * it), Save and the latest run. Anything the grid does not show is behind a leg's "All settings".
 *
 * The form only shapes JSON; the Python schema is the validator. It is asked on every edit
 * (useLegwiseValidate) and its messages are placed beside the fields they are about.
 * Pure logic (defaults, templates, summaries, dirty check, message mapping) lives in
 * lib/legwiseBuilder.ts.
 */

import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import { useAppRoute } from '../../hooks/useAppRoute';
import { useFavourites } from '../../hooks/useFavourites';
import {
  LEGWISE_API,
  useLegwiseData,
  useLegwiseResults,
  useLegwiseStrategies,
} from '../../hooks/useLegwise';
import { useLegwiseValidate } from '../../hooks/useLegwiseValidate';
import { usePaymentBalance } from '../../hooks/usePaymentBalance';
import { apiPost, apiPut } from '../../lib/api';
import {
  STRATEGY_NAME_RE,
  type StartSpec,
  fromSaved,
  isDirty,
  newLeg,
  newStrategy,
  nextLegId,
  parseIssue,
  placeIssues,
  runFailureKind,
  startFromParams,
  strategyFromStart,
  toPayload,
} from '../../lib/legwiseBuilder';
import { type PeriodKey, autoName, periodOf, periodRange, slugId } from '../../lib/legwiseGrid';
import { compareToBaseline, lotsOf } from '../../lib/legwiseStats';
import type { BacktestResponse, Leg, LegwiseStrategy } from '../../types/legwise';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Drawer } from '../ui/Drawer';
import { toast } from '../ui/Toast';
import { NewStrategyDialog } from './NewStrategyDialog';
import { ConfirmDialog, type ConfirmRequest } from './builder/ConfirmDialog';
import { LegCard } from './builder/LegCard';
import { LegGrid } from './builder/LegGrid';
import { ReadBack } from './builder/ReadBack';
import { ResultTable } from './builder/ResultTable';
import { RunRail } from './builder/RunRail';
import { StrategyTokens } from './builder/StrategyTokens';
import { Choice, LabeledField, TextField } from './builder/fields';

const BLANK_NAME = 'my_strategy';

interface Version {
  name: string;
  strategy: LegwiseStrategy;
}

interface Run {
  result: BacktestResponse;
  /** The strategy's "one lot" when it ran, so later edits to lots do not rescale the result. */
  lots: number;
  /** The exact JSON that ran, to tell whether the form has moved on since. */
  sent: string;
}

function blank(): Version {
  return { name: BLANK_NAME, strategy: newStrategy() };
}

function PricingLink({ children }: { children: ReactNode }) {
  const { navigate } = useAppRoute();
  return (
    <a
      href="/billing"
      className="font-medium underline underline-offset-2"
      onClick={(event) => {
        // In-app navigation keeps the form; a plain link would reload and lose the edits.
        event.preventDefault();
        navigate('pricing');
      }}
    >
      {children}
    </a>
  );
}

export function StrategyBuilder() {
  const saved = useLegwiseStrategies();
  const stored = useLegwiseResults();
  const payment = usePaymentBalance();

  const [name, setName] = useState(BLANK_NAME);
  const [s, setS] = useState<LegwiseStrategy>(newStrategy);
  /** What the form started from: the loaded (or last saved) version, or the blank strategy. */
  const [baseline, setBaseline] = useState<Version>(blank);
  const [loaded, setLoaded] = useState<{ name: string; sha: string } | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<ReactNode | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [starting, setStarting] = useState(false);
  const favourites = useFavourites();
  const data = useLegwiseData();
  /** Edit a CE and a PE that match together (the grid's "Edit both legs together"). */
  const [together, setTogether] = useState(true);
  /** The leg whose full settings are open in the drawer. */
  const [detailsIndex, setDetailsIndex] = useState<number | null>(null);
  /** Test settings: bar size and whether to run the days the quality gate refused. */
  const [bars, setBars] = useState<'1m' | '5m'>('1m');
  const [includeExcluded, setIncludeExcluded] = useState(false);
  /** Until the file name is edited by hand it follows what the strategy does. */
  const [nameTouched, setNameTouched] = useState(false);
  /** Credits used here since the balance was last read (it is only re-read once a minute). */
  const [spent, setSpent] = useState<{ at: number | null; count: number }>({ at: null, count: 0 });

  const payload = useMemo(() => toPayload(s), [s]);
  const sent = useMemo(() => JSON.stringify(payload), [payload]);
  const validation = useLegwiseValidate(payload);
  const issues = useMemo(
    () => placeIssues(validation.errors, payload),
    [validation.errors, payload],
  );
  const dirty = useMemo(() => isDirty({ name, strategy: s }, baseline), [name, s, baseline]);
  const slot = (key: string) => issues.bySlot[key];

  const balance =
    payment.balance !== null && spent.at === payment.balance
      ? Math.max(0, payment.balance - spent.count)
      : payment.balance;

  /**
   * A change to the strategy. A strategy that is not saved yet and whose file name nobody has
   * typed takes its file name (and id) from what it does, so "Short strangle OTM1 · 09:17"
   * becomes nifty_short_strangle_otm1_09_17 without anyone writing it.
   */
  function change(next: LegwiseStrategy) {
    if (loaded === null && !nameTouched) {
      const id = slugId(autoName(next), next.underlying);
      setName(id);
      setS({ ...next, id });
      return;
    }
    setS(next);
  }

  /** The file name is the strategy id too, as in every saved strategy; a hand edit stops the auto name. */
  function setFileName(value: string) {
    setNameTouched(true);
    setName(value);
    if (s.id === name || loaded === null) setS({ ...s, id: value });
  }

  // The saved version's results are already stored (keyed by version hash), so comparing
  // an edit against them is free — a second backtest call would spend a credit.
  const savedBaseline = useMemo(() => {
    const version = saved.data?.find((x) => x.name === (loaded?.name ?? name));
    if (!version) return null;
    const lots = lotsOf(version.strategy);
    const mine = (stored.data?.results ?? []).filter(
      (r) => r.strategy_id === version.strategy.id && r.strategy_sha === version.sha,
    );
    return mine.length ? new Map(mine.map((r) => [r.day, r.net / lots])) : null;
  }, [saved.data, stored.data, loaded, name]);

  const comparison = useMemo(
    () =>
      run && savedBaseline ? compareToBaseline(run.result.days, run.lots, savedBaseline) : null,
    [run, savedBaseline],
  );

  /** Start over from `version`; the previous run and messages belong to the old form. */
  function replaceForm(version: Version, origin: { name: string; sha: string } | null) {
    setName(version.name);
    setS(version.strategy);
    setLoaded(origin);
    setBaseline(origin ? version : blank());
    setDetailsIndex(null);
    // A started or loaded strategy keeps the name it came with until the file name is edited.
    setNameTouched(origin !== null || version.name !== BLANK_NAME);
    setRun(null);
    setProblem(null);
  }

  /** Run `action` now, or after the user agrees to lose their unsaved edits. */
  function discardThen(title: string, action: () => void) {
    if (!dirty) {
      action();
      return;
    }
    setConfirm({
      title,
      body: (
        <>
          <span className="font-medium text-foreground">{name}</span> has unsaved changes. They will
          be lost.
        </>
      ),
      confirmLabel: 'Discard changes',
      danger: true,
      onConfirm: action,
    });
  }

  function load(target: string) {
    const found = saved.data?.find((x) => x.name === target);
    if (!found) return;
    discardThen(`Load ${found.name}?`, () =>
      replaceForm(
        { name: found.name, strategy: fromSaved(found.strategy) },
        { name: found.name, sha: found.sha },
      ),
    );
  }

  // Strategies › "Open in builder" links here with ?load=<file name>. Load it once, as soon as
  // the saved list arrives, then drop the parameter so a refresh does not reload over edits.
  const loadParamHandled = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: load is redefined every render; this runs when the saved list arrives
  useEffect(() => {
    if (loadParamHandled.current || !saved.data) return;
    const params = new URLSearchParams(window.location.search);
    const target = params.get('load');
    const spec = startFromParams(params);
    loadParamHandled.current = true;
    if (!target && !spec) return;
    for (const key of ['load', 'new', 'index', 'premium', 'copy']) params.delete(key);
    const query = params.toString();
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${query ? `?${query}` : ''}`,
    );
    if (target) load(target);
    else if (spec) startFrom(spec);
  }, [saved.data]);

  /** Open what the Start a strategy dialog chose, unsaved, after the discard check. */
  function startFrom(spec: StartSpec) {
    const started = strategyFromStart(spec, saved.data ?? []);
    if (!started) return;
    discardThen(`Start ${started.name}?`, () =>
      replaceForm({ name: started.name, strategy: started.strategy }, null),
    );
  }

  async function backtest() {
    setRunning(true);
    setProblem(null);
    const body: Record<string, unknown> = { strategy: payload };
    if (from) body.from = from;
    if (to) body.to = to;
    if (bars !== '1m') body.bars = bars;
    if (includeExcluded) body.include_excluded = true;
    const r = await apiPost<BacktestResponse>(`${LEGWISE_API}/backtest`, body);
    setRunning(false);
    if (r.ok) {
      setRun({ result: r.data, lots: lotsOf(payload), sent });
      if (payment.enabled)
        setSpent((prev) => ({
          at: payment.balance,
          count: prev.at === payment.balance ? prev.count + 1 : 1,
        }));
      return;
    }
    const kind = runFailureKind(r.status, r.error);
    setProblem(
      kind === 'credits' ? (
        <>
          You are out of credits, so this backtest did not run. Top up on the{' '}
          <PricingLink>Billing page</PricingLink>.
        </>
      ) : kind === 'access' ? (
        <>
          Backtesting needs an active access pass, so this backtest did not run. Get one on the{' '}
          <PricingLink>Billing page</PricingLink>.
        </>
      ) : (
        <Lines text={r.error} strategy={payload} />
      ),
    );
  }

  async function writeFile() {
    setSaving(true);
    setProblem(null);
    const r = await apiPut<{ name: string; sha?: string }>(
      `${LEGWISE_API}/strategies/${encodeURIComponent(name)}`,
      { strategy: payload },
    );
    setSaving(false);
    if (!r.ok) {
      setProblem(<Lines text={r.error} strategy={payload} />);
      return;
    }
    toast(`Saved as strategies/legwise/${r.data.name}.yaml. The evening run now includes it.`);
    setLoaded({ name: r.data.name, sha: r.data.sha ?? '' });
    setBaseline({ name, strategy: s });
    saved.refetch();
  }

  function save() {
    const existing = saved.data?.find((x) => x.name === name);
    if (!existing) {
      void writeFile();
      return;
    }
    setConfirm({
      title: `Overwrite ${existing.name}?`,
      body: (
        <>
          <span className="font-mono text-foreground">strategies/legwise/{existing.name}.yaml</span>{' '}
          already exists (version <span className="font-mono">{existing.sha}</span>). Saving
          replaces it, and the evening run will use the new version from now on. Results stored for
          the old version are kept.
        </>
      ),
      confirmLabel: 'Overwrite',
      danger: true,
      onConfirm: () => void writeFile(),
    });
  }

  const nameError = STRATEGY_NAME_RE.test(name)
    ? null
    : 'File name must be 1–64 characters of a–z, 0–9 and _';
  const loadOptions = [
    { value: '', label: saved.loading && !saved.data ? 'Loading…' : 'Load saved…' },
    ...(saved.data ?? []).map((x) => ({ value: x.name, label: x.name })),
    ...(loaded && !saved.data?.some((x) => x.name === loaded.name)
      ? [{ value: loaded.name, label: loaded.name }]
      : []),
  ];

  const lastDay = (data.data?.days[s.underlying] ?? []).slice(-1)[0] ?? null;
  const period = periodOf(from, to, lastDay);
  const problems = useMemo(() => {
    if (validation.status === 'unknown') return ['The form could not be checked right now.'];
    if (validation.status !== 'invalid') return [];
    const placed = Object.values(issues.bySlot).flat();
    const unplaced = issues.unplaced.map((u) => u.message);
    return [...new Set([...unplaced, ...placed])];
  }, [validation.status, issues]);

  const detailLeg = detailsIndex === null ? undefined : s.legs[detailsIndex];

  return (
    <div className="space-y-5">
      <Card className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h2 className="flex flex-wrap items-center gap-2 text-base font-semibold tracking-tight text-foreground">
              {autoName(s)}
              {loaded ? (
                <Badge tone="neutral">
                  {loaded.name}
                  {loaded.sha ? <span className="font-mono">· {loaded.sha}</span> : null}
                </Badge>
              ) : (
                <Badge tone="neutral">Not saved yet</Badge>
              )}
              {dirty && <Badge status="attention">Unsaved changes</Badge>}
            </h2>
            <p className="text-xs text-muted">
              Saved as{' '}
              <span className="font-mono text-foreground">strategies/legwise/{name}.yaml</span>
              {s.id !== name ? (
                <>
                  {' '}
                  · id <span className="font-mono text-foreground">{s.id}</span>
                </>
              ) : null}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Choice<string>
              label="Open a saved strategy"
              value={loaded?.name ?? ''}
              options={loadOptions}
              onChange={load}
            />
            <Button size="sm" onClick={() => setStarting(true)}>
              New
            </Button>
          </div>
        </div>
        {saved.error && !saved.data && (
          <p className="text-xs text-warning">
            Saved strategies could not be loaded ({saved.error}).
          </p>
        )}
        <div className="flex flex-wrap items-start gap-3">
          <LabeledField label="File name (a-z 0-9 _)" errors={nameError ? [nameError] : slot('id')}>
            <TextField
              label="File name"
              value={name}
              onChange={setFileName}
              className="w-72"
              errors={nameError ? [nameError] : slot('id')}
            />
          </LabeledField>
        </div>
        <StrategyTokens strategy={s} slots={issues.bySlot} onChange={change} />
      </Card>

      <Card className="space-y-3">
        <LegGrid
          legs={s.legs}
          issues={issues}
          together={together}
          onTogetherChange={setTogether}
          onChange={(legs) => change({ ...s, legs })}
          onDetails={setDetailsIndex}
          onCopy={(i) => {
            const leg = s.legs[i];
            if (!leg) return;
            change({
              ...s,
              legs: [
                ...s.legs,
                {
                  ...leg,
                  id: nextLegId(
                    s.legs.map((l) => l.id),
                    leg.id,
                  ),
                },
              ],
            });
          }}
          onRemove={(i) => change({ ...s, legs: s.legs.filter((_, j) => j !== i) })}
          onAdd={() => change({ ...s, legs: [...s.legs, newLegFor(s)] })}
          onAddPair={() => {
            const ids = s.legs.map((l) => l.id);
            const ce = nextLegId(ids, 'ce');
            const pe = nextLegId([...ids, ce], 'pe');
            change({ ...s, legs: [...s.legs, newLeg(ce, 'CE'), newLeg(pe, 'PE')] });
          }}
        />
        <ReadBack strategy={s} problems={problems} checking={validation.status === 'checking'} />
      </Card>

      <RunRail
        from={from}
        to={to}
        onFrom={setFrom}
        onTo={setTo}
        period={period}
        onPeriod={(key: PeriodKey) => {
          const range = periodRange(lastDay, key);
          setFrom(range.from);
          setTo(range.to);
        }}
        bars={bars}
        onBars={setBars}
        includeExcluded={includeExcluded}
        onIncludeExcluded={setIncludeExcluded}
        validation={validation}
        issues={issues}
        payment={{ enabled: payment.enabled, balance }}
        running={running}
        saving={saving}
        saveBlocked={nameError}
        onBacktest={() => void backtest()}
        onSave={save}
        problem={problem}
        summary={
          run ? { result: run.result, lots: run.lots, comparison, stale: run.sent !== sent } : null
        }
      />

      {run && <ResultTable result={run.result} lots={run.lots} comparison={comparison} />}

      <Drawer
        open={detailLeg !== undefined}
        onOpenChange={(open) => {
          if (!open) setDetailsIndex(null);
        }}
        title={
          detailLeg ? `All settings for ${detailLeg.id || `leg ${(detailsIndex ?? 0) + 1}`}` : 'Leg'
        }
        subtitle="Everything the grid does not show: range breakout, re-entry on target, ids."
      >
        {detailLeg && detailsIndex !== null ? (
          <LegCard
            leg={detailLeg}
            index={detailsIndex}
            underlying={s.underlying}
            issues={issues}
            open
            onToggle={() => undefined}
            onChange={(l) =>
              change({ ...s, legs: s.legs.map((x, j) => (j === detailsIndex ? l : x)) })
            }
            onRemove={() => {
              change({ ...s, legs: s.legs.filter((_, j) => j !== detailsIndex) });
              setDetailsIndex(null);
            }}
            onCopy={() =>
              change({
                ...s,
                legs: [
                  ...s.legs,
                  {
                    ...detailLeg,
                    id: nextLegId(
                      s.legs.map((l) => l.id),
                      detailLeg.id,
                    ),
                  },
                ],
              })
            }
          />
        ) : null}
      </Drawer>

      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
      <NewStrategyDialog
        open={starting}
        onOpenChange={setStarting}
        saved={saved.data ?? []}
        starred={new Set(favourites.set?.strategies ?? [])}
        onStart={startFrom}
        initialUnderlying={s.underlying}
      />
    </div>
  );
}

/** A new leg for the strategy: the opposite type of the last one, with the next free id. */
function newLegFor(s: LegwiseStrategy): Leg {
  const last = s.legs[s.legs.length - 1];
  return newLeg(nextLegId(s.legs.map((l) => l.id)), last?.option_type === 'CE' ? 'PE' : 'CE');
}

/** A failed call's message, one line per problem, in plain words where the mapping knows them. */
function Lines({ text, strategy }: { text: string; strategy: LegwiseStrategy }) {
  return (
    <>
      {text.split('; ').map((line) => (
        <p key={line}>{parseIssue(line, strategy).message}</p>
      ))}
    </>
  );
}
