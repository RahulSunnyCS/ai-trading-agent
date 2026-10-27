import { istTimestamp, redact } from '@trading/notify';
import type { BrokerResult, ResultStatus } from './brokers/types.js';

// Only the broker-specific formatting lives here. The transport, the secret
// registry and the IST stamp are shared — see @trading/notify.

// Plain-text emoji, not Markdown formatting: broker names and error strings contain
// characters that would break Telegram's parser and silently drop the whole message,
// so parse_mode is never set. Icons alone carry the "glance at the lock screen and
// know" signal without needing any markup.
const STATUS_ICON: Record<ResultStatus, string> = {
  OK: '✅', // logged in just now
  SKIPPED: '🔁', // was already logged in - nothing done
  FAIL: '❌',
};

// Failures first, so anything needing attention is visible without scrolling once
// there are more than a couple of brokers.
const STATUS_RANK: Record<ResultStatus, number> = { FAIL: 0, OK: 1, SKIPPED: 2 };

/**
 * `results` are the AlgoTest broker lines, or null when the settings ask for no AlgoTest login
 * (ONLY=none, BL-140): then AlgoTest is not in the report at all. `quantiply` are the Quantiply
 * lines that ran (Angel One, Shoonya), empty when none is switched on - then the report is exactly
 * the AlgoTest-only one. With both, the verdict counts every login, each AlgoTest line says
 * "AlgoTest ·" so it can't be confused with Quantiply's own Angel One line, and a failure on one
 * platform never hides the other's lines.
 */
export function formatReport(
  results: BrokerResult[] | null,
  runUrl: string | null,
  quantiply: BrokerResult[] = [],
): string {
  const algotest = results ?? [];
  const both = results !== null && quantiply.length > 0;
  const entries: BrokerResult[] = [
    ...(both ? algotest.map((r) => ({ ...r, name: `AlgoTest · ${r.name}` })) : algotest),
    ...quantiply,
  ];
  const ready = entries.filter((r) => r.status === 'OK' || r.status === 'SKIPPED').length;
  const total = entries.length;
  const noun = quantiply.length > 0 ? 'logins' : 'brokers';

  let verdict: string;
  if (results !== null && results.length === 0) {
    verdict = both
      ? '🚨 AlgoTest login never reached the broker list'
      : '🚨 Login never reached the broker list';
  } else if (total === 0) verdict = '✅ Nothing to log in (Settings › Automation)';
  else if (ready === total) verdict = `✅ All ${noun} ready (${ready}/${total})`;
  else if (ready === 0) verdict = `❌ All ${noun} failed (0/${total}) - check now`;
  else verdict = `⚠️ Partial (${ready}/${total}) - check now`;

  const platforms = [results !== null && 'AlgoTest', quantiply.length > 0 && 'Quantiply'].filter(
    Boolean,
  );
  const title =
    platforms.length === 0
      ? 'Broker login'
      : quantiply.length === 0
        ? 'AlgoTest broker login'
        : `Broker login: ${platforms.join(' + ')}`;
  const lines = [verdict, `${title}, ${istTimestamp()} IST`, ''];

  const sorted = [...entries].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]);
  for (const result of sorted) {
    const detail = result.detail ? ` — ${result.detail}` : '';
    lines.push(`${STATUS_ICON[result.status]} ${result.name}${detail}`);
  }

  if (runUrl) lines.push('', `🔗 ${runUrl}`);
  return redact(lines.join('\n'));
}
