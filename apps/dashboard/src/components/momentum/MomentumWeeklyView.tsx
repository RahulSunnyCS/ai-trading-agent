'use client';

import { Send } from 'lucide-react';
import { useState } from 'react';

import { apiPost } from '../../lib/api';
import type { MomentumWeeklyRunResult } from '../../types/momentum';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { StateMessage } from '../ui/StateMessage';

type RunKind = 'preview' | 'final';

/**
 * Manual trigger for the Friday weekly signal (TODO.md 3.11.5) — the same
 * `run_weekly()` the launchd-scheduled `mbt weekly` CLI runs, so this button
 * produces an identical result to the automatic Friday runs. Useful to
 * re-run a missed schedule (laptop asleep at 14:40/16:45 IST) or to check
 * the current signal on any other day.
 */
export function MomentumWeeklyView() {
  const [runKind, setRunKind] = useState<RunKind>('final');
  const [send, setSend] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MomentumWeeklyRunResult | null>(null);

  async function run(): Promise<void> {
    setRunning(true);
    setError(null);
    const response = await apiPost<MomentumWeeklyRunResult>('/api/momentum/weekly/run', {
      run: runKind,
      send,
    });
    setRunning(false);
    if (!response.ok) {
      setError(response.error);
      return;
    }
    setResult(response.data);
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Weekly signal"
          description="Manually run the Friday momentum signal — the same job the laptop cron (14:40 preview / 16:45 final IST) runs automatically."
        />
        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex rounded-lg border border-border bg-surface-2/30 p-1">
            <Button
              size="sm"
              variant={runKind === 'preview' ? 'primary' : 'ghost'}
              onClick={() => setRunKind('preview')}
            >
              Preview (live prices)
            </Button>
            <Button
              size="sm"
              variant={runKind === 'final' ? 'primary' : 'ghost'}
              onClick={() => setRunKind('final')}
            >
              Final (official closes)
            </Button>
          </div>
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input
              type="checkbox"
              checked={send}
              onChange={(event) => setSend(event.target.checked)}
            />
            Send to Telegram
          </label>
          <Button size="sm" onClick={() => void run()} disabled={running} className="ml-auto">
            <Send className={running ? 'h-3.5 w-3.5 animate-pulse' : 'h-3.5 w-3.5'} />
            {running ? 'Running…' : 'Run now'}
          </Button>
        </div>
        {error ? (
          <div className="mt-4">
            <StateMessage variant="error" title="Run failed" description={error} />
          </div>
        ) : null}
      </Card>

      {result ? (
        <Card>
          <CardHeader
            title={result.title}
            description={
              result.sent_to_telegram ? 'Sent to Telegram.' : 'Not sent to Telegram (unchecked).'
            }
          />
          <pre className="whitespace-pre-wrap rounded-lg border border-border bg-surface-2/30 p-3 text-sm text-foreground">
            {result.body}
          </pre>
        </Card>
      ) : null}
    </div>
  );
}
