/**
 * Options Lab: the one place to backtest options. Reached through the Fastify proxy at
 * /api/backtest/* (leg-wise engine under /legwise/*, YAML engine at the root).
 *
 * Three workspaces (BL-102), one navigation (the sidebar's nested links; there is no tab bar):
 *
 *  Today
 *   - Rotation: how the followed list (Adaptive) is doing against the fixed base and luck (BL-058)
 *  Explore data
 *   - Heatmap: ATM short-straddle P&L by entry time, date and stop loss, every index and stock (BL-094)
 *   - Matrix: where do the rotation variants make or lose money, by start time, date and
 *     condition, with the recorded picks laid over it (the Strategy Matrix; read-only)
 *   - Correlation: do the strategies lose on the same days? (BL-090)
 *  Build and test
 *   - Strategies: the saved leg-wise strategies and each one's latest saved result.
 *   - Builder: Leg grid (the leg-wise strategy builder) or YAML engine (the YAML DSL engine, which
 *     was the standalone Backtest tab; /backtest redirects to /optionslab/builder/yaml).
 *  Advanced (archived: routed, not in the sidebar)
 *   - Regimes: does the index come in persistent periods? (index + VIX history)
 *  Retired: Runs. `/optionslab/runs` redirects to Strategies, where each strategy's History drawer
 *  shows its saved days; the YAML engine lists its own registry runs.
 *  Retired: Daily results (saved `obt daily` results, trade logs). `/optionslab/results` redirects
 *  to Today, whose status bar carries the evening run and its Run button.
 *
 * /optionslab with no section opens Today (the rotation page).
 */

import { useAppRoute } from '../hooks/useAppRoute';
import { SECTION_META } from '../lib/optionsLabSections';
import {
  type BuilderMode,
  OPTIONS_LAB_DEFAULT_SECTION,
  OPTIONS_LAB_SECTIONS,
  builderMode,
  oneOf,
} from '../lib/routes';
import { CorrelationPanel } from './optionslab/CorrelationPanel';
import { HeatmapPanel } from './optionslab/HeatmapPanel';
import { RegimesPanel } from './optionslab/RegimesPanel';
import { RotationMatrixPanel } from './optionslab/RotationMatrixPanel';
import { RotationPanel } from './optionslab/RotationPanel';
import { StrategiesAndBasketsPanel } from './optionslab/StrategiesAndBasketsPanel';
import { StrategyBuilder } from './optionslab/StrategyBuilder';
import { YamlBacktest } from './optionslab/yaml/YamlBacktest';
import { SegmentedControl, type SegmentedOption } from './ui/SegmentedControl';

const BUILDER_MODE_OPTIONS: SegmentedOption<BuilderMode>[] = [
  { value: 'form', label: 'Leg grid' },
  { value: 'yaml', label: 'YAML engine (advanced)' },
];

const BUILDER_MODE_NOTE: Record<BuilderMode, string> = {
  form: 'Leg-wise strategies on the collected 1-minute Fyers data (5-minute bars on request).',
  yaml: 'Advanced: the older YAML strategy DSL on the cached AlgoTest bars, a different engine and data from the leg grid.',
};

function BuilderSection({
  mode,
  onModeChange,
}: { mode: BuilderMode; onModeChange: (mode: BuilderMode) => void }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl
          value={mode}
          options={BUILDER_MODE_OPTIONS}
          onChange={onModeChange}
          ariaLabel="Builder mode"
          size="sm"
        />
        <p className="text-xs text-muted">{BUILDER_MODE_NOTE[mode]}</p>
      </div>
      {mode === 'form' ? <StrategyBuilder /> : <YamlBacktest />}
    </div>
  );
}

export function OptionsLabView() {
  const { rest, navigate } = useAppRoute();
  const section = oneOf(OPTIONS_LAB_SECTIONS, rest[0]) ?? OPTIONS_LAB_DEFAULT_SECTION;
  const meta = SECTION_META[section];
  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <p className="text-xs text-faint">Options Lab › {meta.workspace}</p>
        <h2 className="text-lg font-semibold tracking-tight text-foreground">{meta.question}</h2>
        <p className="max-w-3xl text-sm text-muted">{meta.explanation}</p>
      </header>
      {section === 'heatmap' && <HeatmapPanel />}
      {section === 'strategies' && <StrategiesAndBasketsPanel />}
      {section === 'builder' && (
        <BuilderSection
          mode={builderMode(rest)}
          onModeChange={(mode) =>
            navigate('optionslab', 'builder', mode === 'yaml' ? 'yaml' : undefined)
          }
        />
      )}
      {section === 'regimes' && <RegimesPanel />}
      {section === 'correlation' && <CorrelationPanel />}
      {section === 'rotation' && <RotationPanel />}
      {section === 'matrix' && <RotationMatrixPanel />}
    </div>
  );
}
