/**
 * Options Lab: the one place to backtest options. Reached through the Fastify proxy at
 * /api/backtest/* (leg-wise engine under /legwise/*, YAML engine at the root).
 *
 *  - Strategies: the saved leg-wise strategies and each one's latest saved result.
 *  - Builder: Form (the leg-wise strategy builder) or YAML (the YAML DSL engine, which
 *    was the standalone Backtest tab; /backtest redirects to /optionslab/builder/yaml).
 *  - Runs: the YAML run registry and the leg-wise runs in one list, clickable and comparable.
 *  - Daily results: saved `obt daily` results, the evening run button, trade logs.
 *  - Regimes: does the index come in persistent periods? (index + VIX history)
 *
 * /optionslab with no section opens Daily results, as it always has.
 */

import { useAppRoute } from '../hooks/useAppRoute';
import {
  type BuilderMode,
  OPTIONS_LAB_DEFAULT_SECTION,
  OPTIONS_LAB_SECTIONS,
  type OptionsLabSection,
  builderMode,
  oneOf,
} from '../lib/routes';
import { RegimesPanel } from './optionslab/RegimesPanel';
import { ResultsPanel } from './optionslab/ResultsPanel';
import { RunsPanel } from './optionslab/RunsPanel';
import { StrategiesPanel } from './optionslab/StrategiesPanel';
import { StrategyBuilder } from './optionslab/StrategyBuilder';
import { YamlBacktest } from './optionslab/yaml/YamlBacktest';
import { SegmentedControl, type SegmentedOption } from './ui/SegmentedControl';
import { type TabItem, Tabs } from './ui/Tabs';

/** Labels match the nested sidebar links (shell/nav.ts). */
const SECTION_LABEL: Record<OptionsLabSection, string> = {
  strategies: 'Strategies',
  builder: 'Builder',
  runs: 'Runs',
  results: 'Daily results',
  regimes: 'Regimes',
};

const SECTIONS: TabItem<OptionsLabSection>[] = OPTIONS_LAB_SECTIONS.map((value) => ({
  value,
  label: SECTION_LABEL[value],
}));

const BUILDER_MODE_OPTIONS: SegmentedOption<BuilderMode>[] = [
  { value: 'form', label: 'Form' },
  { value: 'yaml', label: 'YAML' },
];

const BUILDER_MODE_NOTE: Record<BuilderMode, string> = {
  form: 'Leg-wise strategies on the 1-minute Fyers data.',
  yaml: 'The YAML strategy DSL on the cached AlgoTest bars.',
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
  return (
    <div className="space-y-5">
      <Tabs
        value={section}
        items={SECTIONS}
        onChange={(next) => navigate('optionslab', next)}
        ariaLabel="Options Lab sections"
        variant="pill"
        className="w-fit"
      />
      {section === 'strategies' && <StrategiesPanel />}
      {section === 'builder' && (
        <BuilderSection
          mode={builderMode(rest)}
          onModeChange={(mode) =>
            navigate('optionslab', 'builder', mode === 'yaml' ? 'yaml' : undefined)
          }
        />
      )}
      {section === 'runs' && <RunsPanel />}
      {section === 'results' && <ResultsPanel />}
      {section === 'regimes' && <RegimesPanel />}
    </div>
  );
}
