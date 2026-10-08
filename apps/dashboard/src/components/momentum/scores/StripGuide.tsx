'use client';

import { ChevronDown, ChevronRight } from 'lucide-react';

import {
  DECILE_CLASS,
  STRIP_EXAMPLES,
  STRIP_EXAMPLE_LOOKBACKS,
  TREND_LABEL,
  stripExampleScores,
} from '../../../lib/momentumScores';
import { useMomentumScoresViewsStore } from '../../../store/momentumScoresViews';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { ScoreStrip, TrendBadge } from './ScoreStrip';

const DECILES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

/**
 * "How to read the strip": what a coloured cell is, which end is recent, and the five shapes the
 * page names. Open on a first visit; "Got it" folds it to its title line, which stays on the page
 * to open again. The choice is kept in this browser.
 */
export function StripGuide() {
  const open = useMomentumScoresViewsStore((state) => state.stripHelpOpen);
  const setOpen = useMomentumScoresViewsStore((state) => state.setStripHelpOpen);
  return (
    <Card flush>
      <section aria-label="How to read the strip">
        <div className="flex items-center gap-2 px-4 py-2">
          <button
            type="button"
            aria-expanded={open}
            aria-controls="strip-guide-body"
            onClick={() => setOpen(!open)}
            className="inline-flex items-center gap-1.5 rounded text-sm font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {open ? (
              <ChevronDown className="h-4 w-4 text-muted" aria-hidden="true" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted" aria-hidden="true" />
            )}
            How to read the strip
          </button>
          {open ? (
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setOpen(false)}>
              Got it
            </Button>
          ) : (
            <span className="text-xs text-faint">the coloured 1–10 cells beside each name</span>
          )}
        </div>
        {open ? (
          <div id="strip-guide-body" className="space-y-3 border-t border-border px-4 py-3 text-sm">
            <p className="text-muted">
              Each cell is one lookback,{' '}
              <b className="text-foreground">left to right: 1, 2, 4, 8, 13, 26 and 52 weeks</b>. The
              number is a score from 1 to 10: where that window’s return ranks among all scored
              stocks, 10 being the strongest tenth. Read the{' '}
              <b className="text-foreground">shape</b>, not one cell. Hover a cell for the return.
            </p>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
              <span>weakest tenth</span>
              <span className="inline-flex gap-0.5" aria-hidden="true">
                {DECILES.map((decile) => (
                  <span
                    key={decile}
                    className={`metric inline-flex h-5 w-6 items-center justify-center rounded text-[11px] font-semibold text-foreground ${DECILE_CLASS[decile]}`}
                  >
                    {decile}
                  </span>
                ))}
              </span>
              <span>strongest tenth</span>
            </div>
            <ul className="space-y-1.5">
              {STRIP_EXAMPLES.map((example) => (
                <li key={example.trend} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="w-24 shrink-0">
                    <TrendBadge trend={example.trend} />
                  </span>
                  <ScoreStrip
                    scores={stripExampleScores(example.deciles)}
                    lookbacks={STRIP_EXAMPLE_LOOKBACKS}
                  />
                  <span className="min-w-0 flex-1 text-xs text-muted">
                    <span className="sr-only">{TREND_LABEL[example.trend]}: </span>
                    {example.says}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-faint">
              The Rank column is separate and works the other way round: 1 is the strongest stock. A
              score describes the past; it does not predict what comes next.
            </p>
          </div>
        ) : null}
      </section>
    </Card>
  );
}
