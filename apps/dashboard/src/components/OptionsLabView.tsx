/**
 * Options Lab — daily leg-wise option strategies on the 1-minute Fyers data
 * (packages/option-backtesting legwise/ + fyers/), reached through the
 * Fastify proxy at /api/backtest/legwise/*.
 *
 *  - Results: saved `obt daily` results, the evening run button, trade logs.
 *  - Market regimes: does the index come in persistent periods? (index + VIX history)
 *  - Strategy builder: create/edit/backtest/save AlgoTest-style strategies.
 */

import { useState } from 'react';

import { cn } from '../lib/cn';
import { RegimesPanel } from './optionslab/RegimesPanel';
import { ResultsPanel } from './optionslab/ResultsPanel';
import { StrategyBuilder } from './optionslab/StrategyBuilder';

type Section = 'results' | 'regimes' | 'builder';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'results', label: 'Daily results' },
  { id: 'regimes', label: 'Market regimes' },
  { id: 'builder', label: 'Strategy builder' },
];

export function OptionsLabView() {
  const [section, setSection] = useState<Section>('results');
  return (
    <div className="space-y-5">
      <div className="inline-flex rounded-lg border border-border bg-surface p-1">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setSection(s.id)}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm transition-colors',
              section === s.id
                ? 'bg-surface-2 text-foreground shadow-card'
                : 'text-muted hover:text-foreground',
            )}
          >
            {s.label}
          </button>
        ))}
      </div>
      {section === 'results' && <ResultsPanel />}
      {section === 'regimes' && <RegimesPanel />}
      {section === 'builder' && <StrategyBuilder />}
    </div>
  );
}
