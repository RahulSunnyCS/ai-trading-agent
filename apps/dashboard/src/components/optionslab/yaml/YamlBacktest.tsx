/**
 * Builder › YAML: the YAML strategy DSL engine (packages/option-backtesting), which was the
 * standalone Backtest tab. Preset -> editable YAML -> debounced validation -> Run -> result.
 *
 * Everything goes through the Fastify proxy at /api/backtest/*. POST /runs spends one
 * feature credit when billing is on, so the cost is always shown beside the button and a
 * 402 is reported as "out of credits", not as a failure of the run.
 */

import { AlertCircle, CheckCircle2, Play } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useAppRoute } from '../../../hooks/useAppRoute';
import { useBacktestPresets } from '../../../hooks/useBacktestPresets';
import { useBacktestValidate } from '../../../hooks/useBacktestValidate';
import { usePaymentBalance } from '../../../hooks/usePaymentBalance';
import { usePolledResource } from '../../../hooks/usePolledResource';
import { apiGet, apiPost } from '../../../lib/api';
import { cn } from '../../../lib/cn';
import { formatDay, formatInt } from '../../../lib/format';
import { coverageRange, headlineOfResult, runBlockedReason } from '../../../lib/optionsRuns';
import type { CoverageResponse, PresetDetail, RunResult } from '../../../types/backtest';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { Input, inputClass } from '../../ui/Input';
import { RefreshButton } from '../../ui/RefreshButton';
import { SkeletonRows } from '../../ui/Skeleton';
import { StateMessage } from '../../ui/StateMessage';
import { YamlResult } from './YamlResult';
import { useYamlDraft } from './yamlDraft';

/** Credits one run costs (apps/server consumes one `backtest_run` credit per POST /runs). */
const RUN_COST_CREDITS = 1;

function extractUnderlying(yaml: string): string | null {
  const match = yaml.match(/underlying:\s*["']?(\w+)["']?/);
  return match?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/**
 * GET /presets returns names only (no descriptions), so these are plain buttons, not
 * RadioCards: a card per preset would have nothing to say under the name.
 */
function PresetPicker() {
  const { presets, loading, error, refresh } = useBacktestPresets();
  const preset = useYamlDraft((s) => s.preset);
  const yaml = useYamlDraft((s) => s.yaml);
  const loadPreset = useYamlDraft((s) => s.loadPreset);
  const [fetching, setFetching] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function handleSelect(name: string): Promise<void> {
    setFetching(name);
    setLoadError(null);
    const result = await apiGet<PresetDetail>(`/api/backtest/presets/${encodeURIComponent(name)}`);
    setFetching(null);
    if (result.ok) loadPreset(name, result.data.yaml);
    else setLoadError(`Couldn't load ${name}: ${result.error}`);
  }

  const edited = preset !== null && preset.yaml !== yaml;
  return (
    <Card>
      <CardHeader
        title="Presets"
        description="Example strategies. Loading one replaces the editor's text."
        actions={<RefreshButton onClick={refresh} loading={loading} />}
      />
      {error !== null && presets.length === 0 ? (
        <StateMessage variant="error" title="Couldn't load presets" description={error} />
      ) : loading && presets.length === 0 ? (
        <SkeletonRows rows={1} />
      ) : presets.length === 0 ? (
        <p className="text-sm text-muted">No presets are installed.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {presets.map((p) => {
            const current = preset?.name === p.name;
            return (
              <Button
                key={p.name}
                variant="secondary"
                size="sm"
                aria-pressed={current}
                className={cn(current && 'border-primary text-primary')}
                disabled={fetching !== null}
                loading={fetching === p.name}
                onClick={() => void handleSelect(p.name)}
              >
                {p.name}
              </Button>
            );
          })}
          {preset !== null && (
            <span className="text-xs text-muted">
              Loaded {preset.name}
              {edited ? ', edited since' : ''}
            </span>
          )}
        </div>
      )}
      {loadError !== null && <p className="mt-2 text-xs text-negative">{loadError}</p>}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Cached coverage for the strategy's underlying
// ---------------------------------------------------------------------------

/** Mounted only once the YAML names an underlying: usePolledResource always fetches. */
function Coverage({ underlying }: { underlying: string }) {
  const { data, loading, error } = usePolledResource<CoverageResponse>(
    `/api/backtest/coverage?underlying=${encodeURIComponent(underlying)}`,
    { cache: true },
  );
  const defaultDates = useYamlDraft((s) => s.defaultDates);
  const setDates = useYamlDraft((s) => s.setDates);
  const range = coverageRange(data);
  const from = range?.from;
  const to = range?.to;

  // With coverage known the range starts as everything cached, so Run is enabled without
  // the user typing dates. Dates the user has chosen are left alone.
  useEffect(() => {
    if (from && to) defaultDates(from, to);
  }, [from, to, defaultDates]);

  if (data === null) {
    return (
      <span className="text-xs text-faint">
        {loading
          ? `Checking cached ${underlying} data…`
          : `Cached ${underlying} coverage is unavailable${error ? `: ${error}` : ''}.`}
      </span>
    );
  }
  if (!range) {
    return <span className="text-xs text-warning">No cached bars for {underlying}.</span>;
  }
  return (
    <span className="text-xs text-faint">
      Cached {underlying}:{' '}
      {Object.entries(data)
        .map(([timeframe, r]) => `${timeframe} ${formatDay(r.start)} to ${formatDay(r.end)}`)
        .join(' · ')}{' '}
      <button
        type="button"
        className="rounded text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setDates({ from: range.from, to: range.to })}
      >
        Use full range
      </button>
    </span>
  );
}

// ---------------------------------------------------------------------------
// What a run costs
// ---------------------------------------------------------------------------

function RunCost() {
  const credits = usePaymentBalance();
  const cost = `${formatInt(RUN_COST_CREDITS)} credit`;
  if (credits.loading) return <span className="text-xs text-muted">{cost} per run</span>;
  if (credits.error !== null) {
    return <span className="text-xs text-muted">{cost} per run when billing is on</span>;
  }
  if (!credits.enabled) {
    return <span className="text-xs text-muted">Free: billing is off on this instance</span>;
  }
  if (credits.balance === null) return <span className="text-xs text-muted">{cost} per run</span>;
  return (
    <span className={cn('text-xs', credits.balance > 0 ? 'text-muted' : 'text-warning')}>
      {cost} per run · {credits.balance > 0 ? `${formatInt(credits.balance)} left` : 'none left'}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export function YamlBacktest() {
  const { navigate } = useAppRoute();
  const yaml = useYamlDraft((s) => s.yaml);
  const from = useYamlDraft((s) => s.from);
  const to = useYamlDraft((s) => s.to);
  const result = useYamlDraft((s) => s.result);
  const setYaml = useYamlDraft((s) => s.setYaml);
  const setDates = useYamlDraft((s) => s.setDates);
  const setResult = useYamlDraft((s) => s.setResult);

  const validation = useBacktestValidate(yaml);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<{ message: string; outOfCredits: boolean } | null>(null);

  const underlying = extractUnderlying(yaml);
  const errors = validation.result?.valid === false ? validation.result.errors : [];
  const blocked = runBlockedReason({
    yaml,
    validating: validation.validating,
    valid: validation.result?.valid ?? null,
    errorCount: errors.length,
    validationError: validation.error,
    from,
    to,
  });

  async function handleRun(): Promise<void> {
    setRunning(true);
    setRunError(null);
    const response = await apiPost<RunResult>('/api/backtest/runs', { yaml, from, to });
    setRunning(false);
    if (!response.ok) {
      const outOfCredits = response.status === 402;
      setRunError({
        outOfCredits,
        message: outOfCredits
          ? 'Out of feature credits. No run was made and nothing was charged.'
          : response.error,
      });
      return;
    }
    setResult({ data: response.data, from, to });
  }

  return (
    <div className="space-y-5">
      <PresetPicker />

      <Card>
        <CardHeader
          title="Strategy"
          description="The YAML strategy DSL, checked as you type. Checking is free."
          actions={
            yaml.trim() === '' ? null : validation.validating ? (
              <Badge tone="neutral">Checking…</Badge>
            ) : validation.error !== null ? (
              <Badge status="attention">Not checked</Badge>
            ) : validation.result === null ? null : validation.result.valid ? (
              <Badge tone="positive">
                <CheckCircle2 className="h-3 w-3" />
                Valid
              </Badge>
            ) : (
              <Badge tone="negative">
                <AlertCircle className="h-3 w-3" />
                {errors.length} error{errors.length === 1 ? '' : 's'}
              </Badge>
            )
          }
        />

        <textarea
          value={yaml}
          onChange={(e) => setYaml(e.target.value)}
          spellCheck={false}
          rows={18}
          aria-label="Strategy YAML"
          aria-invalid={errors.length > 0}
          className={`${inputClass} font-mono !text-xs`}
          placeholder="Pick a preset above, or paste a strategy YAML"
        />

        {errors.length > 0 && (
          <div className="mt-2 space-y-1 rounded-lg border border-negative/30 bg-negative/10 px-3 py-2">
            {errors.map((err) => (
              <p key={err} className="text-xs text-negative">
                {err}
              </p>
            ))}
          </div>
        )}
        {validation.error !== null && yaml.trim() !== '' && (
          <p className="mt-2 text-xs text-warning">
            The validation service did not answer: {validation.error}
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label htmlFor="yaml-backtest-from" className="flex flex-col gap-1 text-xs text-muted">
            From
            <Input
              id="yaml-backtest-from"
              type="date"
              className="w-40"
              value={from}
              max={to || undefined}
              onChange={(e) => setDates({ from: e.target.value })}
            />
          </label>
          <label htmlFor="yaml-backtest-to" className="flex flex-col gap-1 text-xs text-muted">
            To
            <Input
              id="yaml-backtest-to"
              type="date"
              className="w-40"
              value={to}
              min={from || undefined}
              onChange={(e) => setDates({ to: e.target.value })}
            />
          </label>
          <Button
            variant="primary"
            disabled={blocked !== null}
            loading={running}
            aria-describedby="yaml-backtest-run-note"
            onClick={() => void handleRun()}
          >
            {running ? null : <Play className="h-3.5 w-3.5" />}
            {running ? 'Running…' : 'Run backtest'}
          </Button>
          <div id="yaml-backtest-run-note" className="flex flex-col gap-0.5 pb-0.5">
            <RunCost />
            <span className="text-xs text-muted" aria-live="polite">
              {running ? 'This can take a little while on a long range.' : (blocked ?? '')}
            </span>
          </div>
        </div>

        {underlying !== null && (
          <div className="mt-3">
            <Coverage key={underlying} underlying={underlying} />
          </div>
        )}

        {runError !== null && (
          <div className="mt-3 space-y-2">
            <StateMessage
              variant="error"
              title={runError.outOfCredits ? 'Out of credits' : 'Run failed'}
              description={runError.message}
            />
            {runError.outOfCredits && (
              <Button variant="secondary" size="sm" onClick={() => navigate('pricing')}>
                Top up on Billing
              </Button>
            )}
          </div>
        )}
      </Card>

      {result !== null && (
        <YamlResult
          headline={headlineOfResult(result.data)}
          result={result.data}
          description={`Run ${result.data.run_id} · ${formatDay(result.from)} to ${formatDay(result.to)} · also listed under Runs`}
        />
      )}
    </div>
  );
}
