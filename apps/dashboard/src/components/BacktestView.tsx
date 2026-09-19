/**
 * BacktestView — the options-backtesting research tab (M-4).
 *
 * Preset picker -> editable strategy YAML -> debounced validation -> Run,
 * fed entirely through the Fastify proxy (server/routes/backtest.ts), which
 * gates POST /runs behind access + credit consumption when payments are
 * enabled — a 402 here means "out of credits," not a bug.
 *
 * Data source: packages/option-backtesting's FastAPI service, reached only
 * via /api/backtest/*; this component never talks to it directly.
 */

import { AlertCircle, CheckCircle2, Play, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useBacktestPresets } from '../hooks/useBacktestPresets.js';
import { useBacktestRuns } from '../hooks/useBacktestRuns.js';
import { useBacktestValidate } from '../hooks/useBacktestValidate.js';
import { apiGet, apiPost } from '../lib/api.js';
import type { CoverageResponse, RunResult } from '../types/backtest.js';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Card, CardHeader } from './ui/Card';
import { StatCard } from './ui/StatCard';
import { StateMessage } from './ui/StateMessage';
import { THead, TRow, Table, Td, Th } from './ui/Table';

function extractUnderlying(yaml: string): string | null {
  const match = yaml.match(/underlying:\s*["']?(\w+)["']?/);
  return match?.[1] ?? null;
}

function fmtInr(n: number): string {
  return n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

// ---------------------------------------------------------------------------
// Preset picker
// ---------------------------------------------------------------------------

function PresetPicker({ onSelect }: { onSelect: (yaml: string) => void }) {
  const { presets, loading, error, refresh } = useBacktestPresets();
  const [loadingPreset, setLoadingPreset] = useState(false);

  async function handleSelect(name: string): Promise<void> {
    if (!name) return;
    setLoadingPreset(true);
    const result = await apiGet<{ name: string; yaml: string }>(
      `/api/backtest/presets/${encodeURIComponent(name)}`,
    );
    setLoadingPreset(false);
    if (result.ok) onSelect(result.data.yaml);
  }

  return (
    <Card>
      <CardHeader
        title="Preset strategies"
        description="Load an example strategy into the editor below, then tweak it"
        actions={
          <Button size="sm" onClick={refresh} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        }
      />
      {error !== null ? (
        <StateMessage variant="error" title="Couldn't load presets" description={error} />
      ) : (
        <div className="flex flex-wrap gap-2">
          {presets.map((p) => (
            <Button
              key={p.name}
              variant="secondary"
              size="sm"
              disabled={loadingPreset}
              onClick={() => void handleSelect(p.name)}
            >
              {p.name}
            </Button>
          ))}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Strategy editor + run controls
// ---------------------------------------------------------------------------

interface EditorProps {
  yaml: string;
  onChange: (yaml: string) => void;
  from: string;
  to: string;
  onFromChange: (v: string) => void;
  onToChange: (v: string) => void;
  onRun: () => void;
  running: boolean;
  runError: string | null;
}

function StrategyEditor({
  yaml,
  onChange,
  from,
  to,
  onFromChange,
  onToChange,
  onRun,
  running,
  runError,
}: EditorProps) {
  const { result: validation, validating } = useBacktestValidate(yaml);
  const [coverage, setCoverage] = useState<CoverageResponse | null>(null);

  useEffect(() => {
    const underlying = extractUnderlying(yaml);
    if (!underlying) {
      setCoverage(null);
      return;
    }
    const controller = new AbortController();
    void apiGet<CoverageResponse>(
      `/api/backtest/coverage?underlying=${underlying}`,
      controller.signal,
    ).then((result) => {
      if (result.ok) setCoverage(result.data);
    });
    return () => controller.abort();
  }, [yaml]);

  const canRun = validation?.valid === true && from !== '' && to !== '' && !running;

  return (
    <Card>
      <CardHeader
        title="Strategy"
        description="YAML strategy DSL — validated as you type"
        actions={
          validating ? (
            <Badge tone="neutral">Validating…</Badge>
          ) : validation === null ? null : validation.valid ? (
            <Badge tone="positive">
              <CheckCircle2 className="h-3 w-3" />
              Valid
            </Badge>
          ) : (
            <Badge tone="negative">
              <AlertCircle className="h-3 w-3" />
              {validation.errors.length} error{validation.errors.length === 1 ? '' : 's'}
            </Badge>
          )
        }
      />

      <textarea
        value={yaml}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        rows={16}
        className="w-full rounded-lg border border-border bg-surface-2/50 p-3 font-mono text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        placeholder="Pick a preset above, or paste a strategy YAML"
      />

      {validation && !validation.valid && (
        <div className="mt-2 space-y-1 rounded-lg border border-negative/30 bg-negative/10 px-3 py-2">
          {validation.errors.map((err) => (
            <p key={err} className="text-xs text-negative">
              {err}
            </p>
          ))}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted">
          From
          <input
            type="date"
            value={from}
            onChange={(e) => onFromChange(e.target.value)}
            className="rounded-lg border border-border bg-surface-2/50 px-2.5 py-1.5 text-sm text-foreground"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          To
          <input
            type="date"
            value={to}
            onChange={(e) => onToChange(e.target.value)}
            className="rounded-lg border border-border bg-surface-2/50 px-2.5 py-1.5 text-sm text-foreground"
          />
        </label>
        <Button variant="primary" disabled={!canRun} onClick={onRun}>
          <Play className="h-3.5 w-3.5" />
          {running ? 'Running…' : 'Run backtest'}
        </Button>
        {coverage && Object.keys(coverage).length > 0 && (
          <span className="text-xs text-faint">
            cached:{' '}
            {Object.entries(coverage)
              .map(([tf, r]) => `${tf} ${r.start}→${r.end}`)
              .join(' · ')}
          </span>
        )}
      </div>

      {runError !== null && (
        <div className="mt-3">
          <StateMessage variant="error" title="Run failed" description={runError} />
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Result display
// ---------------------------------------------------------------------------

function ResultCard({ result }: { result: RunResult }) {
  return (
    <Card>
      <CardHeader title="Result" description={`Run ${result.run_id}`} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard
          label="Net"
          value={`₹${fmtInr(result.net_inr)}`}
          tone={result.net_inr >= 0 ? 'positive' : 'negative'}
        />
        <StatCard label="Gross" value={`₹${fmtInr(result.gross_inr)}`} />
        <StatCard label="Win days" value={`${result.win_days} / ${result.sessions.length}`} />
        <StatCard label="Worst day" value={`₹${fmtInr(result.worst_day)}`} tone="negative" />
        <StatCard label="Lot-days" value={result.lot_days.toFixed(2)} />
        <StatCard
          label="INR / lot-day"
          value={`₹${fmtInr(result.inr_per_lot_day)}`}
          tone={result.inr_per_lot_day >= 0 ? 'positive' : 'negative'}
        />
        {result.margin && (
          <StatCard
            label="Return on peak margin"
            value={`${(result.margin.return_on_peak_margin * 100).toFixed(2)}%`}
            tone={result.margin.return_on_peak_margin >= 0 ? 'positive' : 'negative'}
          />
        )}
      </div>

      {result.margin && (
        <p className="mt-3 text-xs text-muted">
          Peak margin: ₹{fmtInr(result.margin.peak_margin_inr)} ({result.margin.peak_lots} lots × ₹
          {fmtInr(result.margin.margin_per_lot_inr)}/lot on {result.margin.peak_date}, category:{' '}
          {result.margin.strategy_type})
        </p>
      )}

      {result.bootstrap && (
        <p className="mt-3 text-xs text-muted">
          Bootstrap 90% CI (n={result.bootstrap.n_resamples}, seed={result.bootstrap.seed}): net [₹
          {fmtInr(result.bootstrap.net_lo)}, ₹{fmtInr(result.bootstrap.net_hi)}] · INR/lot-day [₹
          {fmtInr(result.bootstrap.inr_per_lot_day_lo)}, ₹
          {fmtInr(result.bootstrap.inr_per_lot_day_hi)}]
        </p>
      )}

      <h3 className="mb-2 mt-5 text-sm font-semibold text-foreground">DTE breakdown</h3>
      <Table>
        <THead>
          <Th>DTE</Th>
          <Th align="right">Net</Th>
        </THead>
        <tbody>
          {Object.entries(result.dte_buckets)
            .sort(([a], [b]) => Number(a) - Number(b))
            .map(([dte, net]) => (
              <TRow key={dte}>
                <Td>{dte}</Td>
                <Td align="right" numeric>
                  ₹{fmtInr(net)}
                </Td>
              </TRow>
            ))}
        </tbody>
      </Table>

      {result.regime_buckets && (
        <>
          <h3 className="mb-2 mt-5 text-sm font-semibold text-foreground">
            Regime breakdown (lag-1)
          </h3>
          <Table>
            <THead>
              <Th>Regime</Th>
              <Th align="right">Net</Th>
            </THead>
            <tbody>
              {Object.entries(result.regime_buckets).map(([regimeName, net]) => (
                <TRow key={regimeName}>
                  <Td>{regimeName}</Td>
                  <Td align="right" numeric>
                    ₹{fmtInr(net)}
                  </Td>
                </TRow>
              ))}
            </tbody>
          </Table>
        </>
      )}

      <h3 className="mb-2 mt-5 text-sm font-semibold text-foreground">Sessions</h3>
      <Table>
        <THead>
          <Th>Date</Th>
          <Th align="right">DTE</Th>
          <Th align="right">Net</Th>
          <Th align="right">Gross</Th>
          <Th align="right">Cost</Th>
          <Th align="right">Lot-days</Th>
          <Th align="right">Peak loss</Th>
          <Th align="right">Lots</Th>
        </THead>
        <tbody>
          {result.sessions.map((s) => (
            <TRow key={s.date}>
              <Td>{s.date}</Td>
              <Td align="right" numeric>
                {s.dte}
              </Td>
              <Td align="right" numeric>
                ₹{fmtInr(s.net)}
              </Td>
              <Td align="right" numeric>
                ₹{fmtInr(s.gross)}
              </Td>
              <Td align="right" numeric>
                ₹{fmtInr(s.cost)}
              </Td>
              <Td align="right" numeric>
                {s.lot_days.toFixed(2)}
              </Td>
              <Td align="right" numeric>
                ₹{fmtInr(s.peak_loss)}
              </Td>
              <Td align="right" numeric>
                {s.total_lots}
              </Td>
            </TRow>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Past runs
// ---------------------------------------------------------------------------

function PastRunsCard({ refreshKey }: { refreshKey: number }) {
  const { runs, loading, error, refresh } = useBacktestRuns();

  useEffect(() => {
    if (refreshKey > 0) refresh();
    // refresh (useBacktestRuns' fetchRuns) is only recreated when `limit`
    // changes, which PastRunsCard never varies — refreshKey is the real
    // trigger here, refresh is included just to satisfy the exhaustive-deps
    // lint without behaving differently.
  }, [refreshKey, refresh]);

  return (
    <Card>
      <CardHeader
        title="Past runs"
        description="Recorded in the option-backtesting run registry"
        actions={
          <Button size="sm" onClick={refresh} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        }
      />
      {error !== null ? (
        <StateMessage variant="error" title="Couldn't load past runs" description={error} />
      ) : runs.length === 0 ? (
        <StateMessage variant="empty" title="No runs yet" description="Run a strategy above." />
      ) : (
        <Table>
          <THead>
            <Th>Strategy</Th>
            <Th>Window</Th>
            <Th align="right">Net</Th>
            <Th align="right">Win days</Th>
            <Th align="right">INR/lot-day</Th>
          </THead>
          <tbody>
            {runs.map((r) => (
              <TRow key={r.run_id}>
                <Td>{r.strategy_id}</Td>
                <Td>
                  {r.date_from} → {r.date_to}
                </Td>
                <Td align="right" numeric>
                  ₹{fmtInr(r.net_inr)}
                </Td>
                <Td align="right" numeric>
                  {r.win_days} / {r.n_sessions}
                </Td>
                <Td align="right" numeric>
                  ₹{fmtInr(r.inr_per_lot_day)}
                </Td>
              </TRow>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Root view
// ---------------------------------------------------------------------------

export function BacktestView() {
  const [yaml, setYaml] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [runsRefreshKey, setRunsRefreshKey] = useState(0);

  async function handleRun(): Promise<void> {
    setRunning(true);
    setRunError(null);
    const response = await apiPost<RunResult>('/api/backtest/runs', { yaml, from, to });
    setRunning(false);
    if (!response.ok) {
      setRunError(
        response.status === 402
          ? 'Out of feature credits — top up on the Pricing tab.'
          : response.error,
      );
      return;
    }
    setResult(response.data);
    setRunsRefreshKey((k) => k + 1);
  }

  return (
    <div className="space-y-5">
      <PresetPicker onSelect={setYaml} />
      <StrategyEditor
        yaml={yaml}
        onChange={setYaml}
        from={from}
        to={to}
        onFromChange={setFrom}
        onToChange={setTo}
        onRun={() => void handleRun()}
        running={running}
        runError={runError}
      />
      {result && <ResultCard result={result} />}
      <PastRunsCard refreshKey={runsRefreshKey} />
    </div>
  );
}
