/**
 * Options Lab → Strategy builder: an AlgoTest/Quantiply-style form over the leg-wise schema
 * (legwise/schema.py). Two panes from `xl`: the strategy and its legs (each collapsed to a
 * one-line summary) on the left, and a sticky run rail on the right with the date range, live
 * validation, Backtest (its credit cost beside it), Save and the latest run.
 *
 * The form only shapes JSON; the Python schema is the validator. It is asked on every edit
 * (useLegwiseValidate) and its messages are placed beside the fields they are about.
 * Pure logic (defaults, templates, summaries, dirty check, message mapping) lives in
 * lib/legwiseBuilder.ts.
 */

import { Plus } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import { useAppRoute } from '../../hooks/useAppRoute';
import { LEGWISE_API, useLegwiseResults, useLegwiseStrategies } from '../../hooks/useLegwise';
import { useLegwiseValidate } from '../../hooks/useLegwiseValidate';
import { usePaymentBalance } from '../../hooks/usePaymentBalance';
import { apiPost, apiPut } from '../../lib/api';
import {
  STRATEGY_NAME_RE,
  TEMPLATES,
  type TemplateId,
  UNDERLYINGS,
  buildTemplate,
  fromSaved,
  isDirty,
  newLeg,
  newStrategy,
  nextLegId,
  parseIssue,
  placeIssues,
  runFailureKind,
  toPayload,
} from '../../lib/legwiseBuilder';
import { compareToBaseline, lotsOf } from '../../lib/legwiseStats';
import type { BacktestResponse, Leg, LegwiseStrategy } from '../../types/legwise';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { toast } from '../ui/Toast';
import { ConfirmDialog, type ConfirmRequest } from './builder/ConfirmDialog';
import { LegCard } from './builder/LegCard';
import { ResultTable } from './builder/ResultTable';
import { RunRail } from './builder/RunRail';
import { Choice, LabeledField, OptionalNumber, TextField } from './builder/fields';

const BLANK_NAME = 'my_strategy';

const HINTS = {
  noReentryAfter:
    'After this time a stopped-out leg is not re-entered, even if it has re-entries left.',
  squareOff:
    'Partial closes only the leg whose stop loss or target was hit; Complete closes every leg as soon as any one of them is.',
} as const;

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
      href="/pricing"
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
  const [openLegs, setOpenLegs] = useState<ReadonlySet<number>>(new Set());
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<ReactNode | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
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

  const set = <K extends keyof LegwiseStrategy>(key: K, value: LegwiseStrategy[K]) =>
    setS({ ...s, [key]: value });
  const setLegs = (legs: Leg[]) => set('legs', legs);

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
    setOpenLegs(new Set());
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
    loadParamHandled.current = true;
    if (!target) return;
    params.delete('load');
    const query = params.toString();
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${query ? `?${query}` : ''}`,
    );
    load(target);
  }, [saved.data]);

  function startNew() {
    discardThen('Start a new strategy?', () => replaceForm(blank(), null));
  }

  function applyTemplate(id: TemplateId) {
    const template = TEMPLATES.find((t) => t.id === id);
    if (!template) return;
    discardThen(`Start from ${template.label}?`, () => {
      const strategy = buildTemplate(id, s.underlying);
      replaceForm({ name: strategy.id, strategy }, null);
    });
  }

  async function backtest() {
    setRunning(true);
    setProblem(null);
    const body: Record<string, unknown> = { strategy: payload };
    if (from) body.from = from;
    if (to) body.to = to;
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
          <PricingLink>Pricing page</PricingLink>.
        </>
      ) : kind === 'access' ? (
        <>
          Backtesting needs an active access pass, so this backtest did not run. Get one on the{' '}
          <PricingLink>Pricing page</PricingLink>.
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

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_20rem] xl:items-start">
      <div className="min-w-0 space-y-5">
        <Card>
          <CardHeader
            title={
              <span className="flex flex-wrap items-center gap-2">
                Strategy
                {loaded ? (
                  <Badge tone="neutral">
                    {loaded.name}
                    {loaded.sha ? <span className="font-mono">· {loaded.sha}</span> : null}
                  </Badge>
                ) : (
                  <Badge tone="neutral">Not saved yet</Badge>
                )}
                {dirty && <Badge status="attention">Unsaved changes</Badge>}
              </span>
            }
            description="Leg-wise, AlgoTest-style. Backtests run on the 1-minute Fyers data collected so far."
            className="flex-wrap"
            actions={
              <>
                <Choice<string>
                  label="Load a saved strategy"
                  value={loaded?.name ?? ''}
                  options={loadOptions}
                  onChange={load}
                />
                <Choice<TemplateId | ''>
                  label="Start from a template"
                  value=""
                  options={[
                    { value: '', label: 'Start from…' },
                    ...TEMPLATES.map((t) => ({ value: t.id, label: t.label })),
                  ]}
                  onChange={(id) => id && applyTemplate(id)}
                />
                <Button size="sm" onClick={startNew}>
                  New
                </Button>
              </>
            }
          />
          {saved.error && !saved.data && (
            <p className="mb-3 text-xs text-warning">
              Saved strategies could not be loaded ({saved.error}).
            </p>
          )}
          <div className="flex flex-wrap items-start gap-3">
            <LabeledField
              label="File name (a-z 0-9 _)"
              errors={nameError ? [nameError] : undefined}
            >
              <TextField
                label="File name"
                value={name}
                onChange={setName}
                className="w-48"
                errors={nameError ? [nameError] : undefined}
              />
            </LabeledField>
            <LabeledField label="Strategy id" errors={slot('id')}>
              <TextField
                label="Strategy id"
                value={s.id}
                onChange={(v) => set('id', v)}
                className="w-48"
                errors={slot('id')}
              />
            </LabeledField>
            <LabeledField label="Index" errors={slot('underlying')}>
              <Choice
                label="Index"
                value={s.underlying}
                options={UNDERLYINGS}
                onChange={(v) => set('underlying', v)}
              />
            </LabeledField>
            <LabeledField label="Entry" errors={slot('entry_time')}>
              <TextField
                label="Entry time"
                type="time"
                value={s.entry_time}
                errors={slot('entry_time')}
                onChange={(v) => set('entry_time', v)}
              />
            </LabeledField>
            <LabeledField label="Exit" errors={slot('exit_time')}>
              <TextField
                label="Exit time"
                type="time"
                value={s.exit_time}
                errors={slot('exit_time')}
                onChange={(v) => set('exit_time', v)}
              />
            </LabeledField>
            <LabeledField
              label="No re-entry after"
              hint={HINTS.noReentryAfter}
              errors={slot('no_reentry_after')}
            >
              <TextField
                label="No re-entry after"
                type="time"
                value={s.no_reentry_after ?? ''}
                errors={slot('no_reentry_after')}
                onChange={(v) => set('no_reentry_after', v || undefined)}
              />
            </LabeledField>
            <LabeledField label="Square off" hint={HINTS.squareOff} errors={slot('square_off')}>
              <Choice
                label="Square off"
                value={s.square_off}
                errors={slot('square_off')}
                options={[
                  { value: 'partial', label: 'Partial (only the leg)' },
                  { value: 'complete', label: 'Complete (all legs)' },
                ]}
                onChange={(v) => set('square_off', v)}
              />
            </LabeledField>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Legs"
            description={s.legs.length === 0 ? 'Add at least one leg.' : undefined}
            actions={
              <>
                {s.legs.length > 1 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setOpenLegs(
                        openLegs.size === s.legs.length ? new Set() : new Set(s.legs.keys()),
                      )
                    }
                  >
                    {openLegs.size === s.legs.length ? 'Collapse all' : 'Expand all'}
                  </Button>
                )}
                <Button
                  size="sm"
                  onClick={() => {
                    const last = s.legs[s.legs.length - 1];
                    setLegs([
                      ...s.legs,
                      newLeg(
                        nextLegId(s.legs.map((l) => l.id)),
                        last?.option_type === 'CE' ? 'PE' : 'CE',
                      ),
                    ]);
                    setOpenLegs(new Set([...openLegs, s.legs.length]));
                  }}
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add leg
                </Button>
              </>
            }
          />
          <div className="space-y-2">
            {s.legs.map((leg, i) => (
              <LegCard
                // biome-ignore lint/suspicious/noArrayIndexKey: legs have no stable identity (ids are user-edited and may repeat while typing); every input is controlled, so a position key cannot leave stale input state behind
                key={i}
                leg={leg}
                index={i}
                underlying={s.underlying}
                issues={issues}
                open={openLegs.has(i)}
                onToggle={() => {
                  const next = new Set(openLegs);
                  if (!next.delete(i)) next.add(i);
                  setOpenLegs(next);
                }}
                onChange={(l) => setLegs(s.legs.map((x, j) => (j === i ? l : x)))}
                onRemove={() => {
                  setLegs(s.legs.filter((_, j) => j !== i));
                  // Keep the cards after the removed one open or closed as they were.
                  setOpenLegs(
                    new Set([...openLegs].filter((j) => j !== i).map((j) => (j > i ? j - 1 : j))),
                  );
                }}
                onCopy={() => {
                  setLegs([
                    ...s.legs,
                    {
                      ...leg,
                      id: nextLegId(
                        s.legs.map((l) => l.id),
                        leg.id,
                      ),
                    },
                  ]);
                  setOpenLegs(new Set([...openLegs, s.legs.length]));
                }}
              />
            ))}
          </div>
        </Card>

        <Card>
          <CardHeader title="Overall & execution" />
          <div className="flex flex-wrap items-start gap-3">
            <LabeledField label="Overall max loss (₹)" errors={slot('overall.stop_loss_inr')}>
              <OptionalNumber
                label="Overall max loss in rupees"
                value={s.overall.stop_loss_inr}
                errors={slot('overall.stop_loss_inr')}
                onChange={(v) => set('overall', { ...s.overall, stop_loss_inr: v })}
              />
            </LabeledField>
            <LabeledField label="Overall max profit (₹)" errors={slot('overall.target_inr')}>
              <OptionalNumber
                label="Overall max profit in rupees"
                value={s.overall.target_inr}
                errors={slot('overall.target_inr')}
                onChange={(v) => set('overall', { ...s.overall, target_inr: v })}
              />
            </LabeledField>
            <LabeledField label="Slippage %" errors={slot('execution.slippage_pct')}>
              <OptionalNumber
                label="Slippage percent"
                value={s.execution.slippage_pct}
                step={0.1}
                errors={slot('execution.slippage_pct')}
                onChange={(v) => set('execution', { ...s.execution, slippage_pct: v ?? 0 })}
              />
            </LabeledField>
            <LabeledField label="Cost per order (₹)" errors={slot('execution.cost_per_order_inr')}>
              <OptionalNumber
                label="Cost per order in rupees"
                value={s.execution.cost_per_order_inr}
                errors={slot('execution.cost_per_order_inr')}
                onChange={(v) => set('execution', { ...s.execution, cost_per_order_inr: v ?? 0 })}
              />
            </LabeledField>
          </div>
        </Card>
      </div>

      <RunRail
        from={from}
        to={to}
        onFrom={setFrom}
        onTo={setTo}
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

      {run && (
        <div className="min-w-0 xl:col-span-2">
          <ResultTable result={run.result} lots={run.lots} comparison={comparison} />
        </div>
      )}

      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
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
