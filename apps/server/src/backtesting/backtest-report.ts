/**
 * backtest-report.ts — Experiment-card report generation for backtest results.
 *
 * Computes per-personality metrics (Sharpe, drawdown, win rate, etc.) for each
 * data split and regime, runs statistical significance tests against the Clockwork
 * benchmark, and renders a human-readable ASCII report.
 *
 * Design decisions:
 *   - All statistics delegate to stats.ts — this module is metrics and formatting only.
 *   - Clockwork is identified by `isFrozen === true` in the personalities list,
 *     with a name fallback to 'clockwork'. Using `isFrozen` is more robust than
 *     relying on a name string that could change.
 *   - `significantlyBetter` requires BOTH a statistical signal (p < 0.05 in either
 *     test) AND a positive mean difference — statistical significance alone does not
 *     indicate benefit if the mean is lower.
 *   - Data quality warnings are generated for < 20 trades per personality per split,
 *     which is too few for the normal approximation in Mann-Whitney to be reliable.
 *   - formatReport uses fixed-width columns via padEnd/padStart for alignment without
 *     any third-party table library dependency.
 */

import type {
  BacktestConfig,
  BacktestResult,
  BacktestSplit,
  SimulatedTrade,
} from './backtest-runner.js';
import {
  type DrawdownResult,
  type MannWhitneyResult,
  type TTestResult,
  mannWhitneyU,
  maxDrawdown,
  sharpeRatio,
  welchTTest,
} from './stats.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface PersonalityMetrics {
  personalityId: string;
  personalityName: string;
  totalTrades: number;
  winRate: number;
  avgPnlPct: number;
  totalPnlPct: number;
  sharpe: number;
  maxDrawdownPct: number;
  exitReasons: Record<string, number>;
}

export interface RegimeMetrics extends PersonalityMetrics {
  regime: string;
}

export interface StatisticalComparison {
  personalityId: string;
  personalityName: string;
  tTest: TTestResult | null;
  mannWhitney: MannWhitneyResult | null;
  significantlyBetter: boolean;
}

export interface ExperimentCard {
  generatedAt: string;
  config: BacktestConfig;
  split: BacktestSplit;
  trainMetrics: PersonalityMetrics[];
  testMetrics: PersonalityMetrics[];
  holdoutMetrics: PersonalityMetrics[];
  regimeBreakdown: RegimeMetrics[];
  comparisons: StatisticalComparison[];
  dataQualityNotes: string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function cumsum(arr: number[]): number[] {
  const result: number[] = [];
  let running = 0;
  for (const v of arr) {
    running += v;
    result.push(running);
  }
  return result;
}

/**
 * Computes PersonalityMetrics for a group of trades belonging to one personality.
 * Trades must all be for the same personality (same personalityId).
 */
function computeMetrics(
  personalityId: string,
  personalityName: string,
  trades: SimulatedTrade[],
): PersonalityMetrics {
  if (trades.length === 0) {
    return {
      personalityId,
      personalityName,
      totalTrades: 0,
      winRate: 0,
      avgPnlPct: 0,
      totalPnlPct: 0,
      sharpe: 0,
      maxDrawdownPct: 0,
      exitReasons: {},
    };
  }

  const pnlPcts = trades.map((t) => t.pnlPct);
  const wins = trades.filter((t) => t.pnlPct > 0).length;

  const exitReasons: Record<string, number> = {};
  for (const t of trades) {
    exitReasons[t.exitReason] = (exitReasons[t.exitReason] ?? 0) + 1;
  }

  const drawdownResult: DrawdownResult = maxDrawdown(cumsum(pnlPcts));

  return {
    personalityId,
    personalityName,
    totalTrades: trades.length,
    winRate: wins / trades.length,
    avgPnlPct: mean(pnlPcts),
    totalPnlPct: pnlPcts.reduce((s, v) => s + v, 0),
    sharpe: sharpeRatio(pnlPcts),
    maxDrawdownPct: drawdownResult.maxDrawdownPct,
    exitReasons,
  };
}

/**
 * Groups trades by personalityId and computes metrics for each, using the
 * personality list to include personalities with zero trades (for completeness).
 */
function metricsForSplit(
  trades: SimulatedTrade[],
  personalities: BacktestResult['personalities'],
): PersonalityMetrics[] {
  const byPersonality = new Map<string, SimulatedTrade[]>();
  for (const p of personalities) {
    byPersonality.set(p.id, []);
  }
  for (const t of trades) {
    const arr = byPersonality.get(t.personalityId);
    if (arr !== undefined) arr.push(t);
  }

  return personalities.map((p) => computeMetrics(p.id, p.name, byPersonality.get(p.id) ?? []));
}

// ---------------------------------------------------------------------------
// Public: generateReport
// ---------------------------------------------------------------------------

export function generateReport(result: BacktestResult): ExperimentCard {
  const { trades, personalities, config, split } = result;

  // Group trades by split
  const trainTrades = trades.filter((t) => t.split === 'train');
  const testTrades = trades.filter((t) => t.split === 'test');
  const holdoutTrades = trades.filter((t) => t.split === 'holdout');

  const trainMetrics = metricsForSplit(trainTrades, personalities);
  const testMetrics = metricsForSplit(testTrades, personalities);
  const holdoutMetrics = metricsForSplit(holdoutTrades, personalities);

  // Regime breakdown — test set only, grouped by (personalityId, regime)
  const regimeBreakdown: RegimeMetrics[] = [];
  const regimeGroups = new Map<string, SimulatedTrade[]>();
  for (const t of testTrades) {
    const key = `${t.personalityId}::${t.regime}`;
    const arr = regimeGroups.get(key);
    if (arr !== undefined) {
      arr.push(t);
    } else {
      regimeGroups.set(key, [t]);
    }
  }
  for (const [key, groupTrades] of regimeGroups) {
    const [personalityId, regime] = key.split('::');
    if (personalityId === undefined || regime === undefined) continue;
    const p = personalities.find((x) => x.id === personalityId);
    if (p === undefined) continue;
    const m = computeMetrics(personalityId, p.name, groupTrades);
    regimeBreakdown.push({ ...m, regime });
  }

  // Statistical comparisons — test set, each personality vs Clockwork
  // Clockwork is the frozen benchmark; identify by isFrozen first, name fallback
  const clockworkPersonality =
    personalities.find((p) => p.isFrozen) ?? personalities.find((p) => p.name === 'clockwork');

  const clockworkTestTrades = clockworkPersonality
    ? testTrades.filter((t) => t.personalityId === clockworkPersonality.id)
    : [];
  const clockworkPnlPcts = clockworkTestTrades.map((t) => t.pnlPct);
  const clockworkMean = mean(clockworkPnlPcts);

  const comparisons: StatisticalComparison[] = [];
  for (const p of personalities) {
    if (p.isFrozen) continue; // Skip Clockwork itself
    const pTrades = testTrades.filter((t) => t.personalityId === p.id);
    const pPnlPcts = pTrades.map((t) => t.pnlPct);

    const tTest = welchTTest(pPnlPcts, clockworkPnlPcts);
    const mannWhitney = mannWhitneyU(pPnlPcts, clockworkPnlPcts);
    const pMean = mean(pPnlPcts);

    const statSig = (tTest?.significant ?? false) || (mannWhitney?.significant ?? false);
    const significantlyBetter = statSig && pMean > clockworkMean;

    comparisons.push({
      personalityId: p.id,
      personalityName: p.name,
      tTest,
      mannWhitney,
      significantlyBetter,
    });
  }

  // Data quality notes
  const dataQualityNotes: string[] = [];
  const SMALL_SAMPLE_THRESHOLD = 20;
  for (const m of testMetrics) {
    if (m.totalTrades < SMALL_SAMPLE_THRESHOLD) {
      dataQualityNotes.push(
        `${m.personalityName}: only ${m.totalTrades} trades in test set — insufficient for reliable statistical inference (minimum ${SMALL_SAMPLE_THRESHOLD} recommended)`,
      );
    }
  }
  for (const m of holdoutMetrics) {
    if (m.totalTrades < SMALL_SAMPLE_THRESHOLD) {
      dataQualityNotes.push(
        `${m.personalityName}: only ${m.totalTrades} trades in holdout set — holdout results should not be used for model selection`,
      );
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    config,
    split,
    trainMetrics,
    testMetrics,
    holdoutMetrics,
    regimeBreakdown,
    comparisons,
    dataQualityNotes,
  };
}

// ---------------------------------------------------------------------------
// Public: formatReport
// ---------------------------------------------------------------------------

function pct(v: number): string {
  const sign = v >= 0 ? '+' : '';
  return `${sign}${(v * 100).toFixed(1)}%`;
}

function fmtNum(v: number, decimals = 2): string {
  return v.toFixed(decimals);
}

/**
 * Renders a table row with fixed-width columns.
 * `cols` is an array of [value, width] pairs. Values are right-truncated if
 * too long, and padded to width. Columns are separated by two spaces.
 */
function tableRow(cols: Array<[string, number]>): string {
  return cols.map(([val, width]) => val.padEnd(width).slice(0, width)).join('  ');
}

function renderMetricsTable(metrics: PersonalityMetrics[]): string {
  const header = tableRow([
    ['Personality', 18],
    ['Trades', 6],
    ['WinRate', 7],
    ['AvgPnL%', 8],
    ['TotalPnL%', 10],
    ['Sharpe', 7],
    ['MaxDD%', 7],
  ]);
  const sep = '─'.repeat(header.length);
  const rows = metrics.map((m) =>
    tableRow([
      [m.personalityName, 18],
      [String(m.totalTrades), 6],
      [`${(m.winRate * 100).toFixed(1)}%`, 7],
      [pct(m.avgPnlPct), 8],
      [pct(m.totalPnlPct), 10],
      [fmtNum(m.sharpe), 7],
      [`${m.maxDrawdownPct.toFixed(1)}%`, 7],
    ]),
  );
  return [header, sep, ...rows].join('\n');
}

function renderRegimeTable(regimes: RegimeMetrics[]): string {
  const header = tableRow([
    ['Personality', 18],
    ['Regime', 20],
    ['Trades', 6],
    ['WinRate', 7],
    ['AvgPnL%', 8],
  ]);
  const sep = '─'.repeat(header.length);
  const rows = regimes.map((m) =>
    tableRow([
      [m.personalityName, 18],
      [m.regime, 20],
      [String(m.totalTrades), 6],
      [`${(m.winRate * 100).toFixed(1)}%`, 7],
      [pct(m.avgPnlPct), 8],
    ]),
  );
  return [header, sep, ...rows].join('\n');
}

function renderComparisonTable(comparisons: StatisticalComparison[]): string {
  const header = tableRow([
    ['Personality', 18],
    ['t-stat', 7],
    ['t p-val', 8],
    ['MW-U z', 7],
    ['MW p-val', 9],
    ['Better?', 7],
  ]);
  const sep = '─'.repeat(header.length);
  const rows = comparisons.map((c) => {
    const tStat = c.tTest !== null ? fmtNum(c.tTest.t) : 'n/a';
    const tPval = c.tTest !== null ? fmtNum(c.tTest.pValue, 3) : 'n/a';
    const mwZ = c.mannWhitney !== null ? fmtNum(c.mannWhitney.z) : 'n/a';
    const mwPval = c.mannWhitney !== null ? fmtNum(c.mannWhitney.pValue, 3) : 'n/a';
    return tableRow([
      [c.personalityName, 18],
      [tStat, 7],
      [tPval, 8],
      [mwZ, 7],
      [mwPval, 9],
      [c.significantlyBetter ? 'Yes *' : 'No', 7],
    ]);
  });
  return [header, sep, ...rows].join('\n');
}

export function formatReport(card: ExperimentCard): string {
  const { config, split } = card;
  const lines: string[] = [];

  const DIVIDER = '═'.repeat(59);
  const SUB_DIVIDER = '─'.repeat(59);

  lines.push(DIVIDER);
  lines.push('BACKTEST EXPERIMENT CARD');
  lines.push(DIVIDER);
  lines.push(`Config   : ${config.underlying}  ${config.fromDate} → ${config.toDate}`);
  lines.push(
    `Split    : Train ${split.train.days} days (${split.train.from}–${split.train.to})` +
      ` | Test ${split.test.days} days (${split.test.from}–${split.test.to})` +
      ` | Holdout ${split.holdout.days} days (${split.holdout.from}–${split.holdout.to})`,
  );
  lines.push(`Generated: ${card.generatedAt}`);
  lines.push('');

  lines.push('TRAIN SET RESULTS');
  lines.push(SUB_DIVIDER);
  lines.push(renderMetricsTable(card.trainMetrics));
  lines.push('');

  lines.push('TEST SET RESULTS');
  lines.push(SUB_DIVIDER);
  lines.push(renderMetricsTable(card.testMetrics));
  lines.push('');

  lines.push('REGIME BREAKDOWN (Test Set)');
  lines.push(SUB_DIVIDER);
  if (card.regimeBreakdown.length === 0) {
    lines.push('No regime-tagged trades in test set.');
  } else {
    lines.push(renderRegimeTable(card.regimeBreakdown));
  }
  lines.push('');

  lines.push('STATISTICAL TESTS vs CLOCKWORK (Test Set, p < 0.05)');
  lines.push(SUB_DIVIDER);
  if (card.comparisons.length === 0) {
    lines.push('No non-Clockwork personalities to compare.');
  } else {
    lines.push(renderComparisonTable(card.comparisons));
  }
  lines.push('');

  lines.push('HOLDOUT SET RESULTS');
  lines.push(SUB_DIVIDER);
  lines.push(renderMetricsTable(card.holdoutMetrics));
  lines.push('');

  lines.push('DATA QUALITY NOTES');
  lines.push(SUB_DIVIDER);
  if (card.dataQualityNotes.length === 0) {
    lines.push('No data quality issues detected.');
  } else {
    for (const note of card.dataQualityNotes) {
      lines.push(`- ${note}`);
    }
  }
  lines.push(DIVIDER);

  return lines.join('\n');
}
