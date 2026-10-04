/**
 * Options Lab — daily leg-wise option strategies on the 1-minute Fyers data
 * (packages/option-backtesting legwise/ + fyers/), reached through the
 * Fastify proxy at /api/backtest/legwise/*.
 *
 *  - Results: saved `obt daily` results, the evening run button, trade logs.
 *  - Market regimes: does the index come in persistent periods? (index + VIX history)
 *  - Strategy builder: create/edit/backtest/save AlgoTest-style strategies.
 */

import { useAppRoute } from '../hooks/useAppRoute';
import { OPTIONS_LAB_SECTIONS, oneOf } from '../lib/routes';
import { RegimesPanel } from './optionslab/RegimesPanel';
import { ResultsPanel } from './optionslab/ResultsPanel';
import { StrategyBuilder } from './optionslab/StrategyBuilder';
import { type TabItem, Tabs } from './ui/Tabs';

type Section = (typeof OPTIONS_LAB_SECTIONS)[number];

const SECTIONS: TabItem<Section>[] = [
  { value: 'results', label: 'Daily results' },
  { value: 'regimes', label: 'Market regimes' },
  { value: 'builder', label: 'Strategy builder' },
];

export function OptionsLabView() {
  const { rest, navigate } = useAppRoute();
  const section: Section = oneOf(OPTIONS_LAB_SECTIONS, rest[0]) ?? 'results';
  const setSection = (next: Section) => navigate('optionslab', next);
  return (
    <div className="space-y-5">
      <Tabs
        value={section}
        items={SECTIONS}
        onChange={setSection}
        ariaLabel="Options Lab sections"
        variant="pill"
        className="w-fit"
      />
      {section === 'results' && <ResultsPanel />}
      {section === 'regimes' && <RegimesPanel />}
      {section === 'builder' && <StrategyBuilder />}
    </div>
  );
}
