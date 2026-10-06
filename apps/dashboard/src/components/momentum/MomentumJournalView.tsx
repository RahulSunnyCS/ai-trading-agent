'use client';

import { AlertTriangle, CheckCircle2, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Fragment, useState } from 'react';

import { usePolledResource } from '../../hooks/usePolledResource';
import {
  EMPTY,
  formatDay,
  formatInt,
  formatIstDateTime,
  formatNumber,
  formatPct,
} from '../../lib/format';
import { actionTone, isTradeAction } from '../../lib/momentumWeekly';
import type {
  MomentumJournal,
  MomentumJournalCheckItem,
  MomentumJournalEntry,
} from '../../types/momentum';
import { Badge } from '../ui/Badge';
import { Card, CardHeader } from '../ui/Card';
import { CopyButton } from '../ui/CopyButton';
import { Select } from '../ui/Input';
import { RefreshButton } from '../ui/RefreshButton';
import { SkeletonRows } from '../ui/Skeleton';
import { StatCard } from '../ui/StatCard';
import { StateMessage } from '../ui/StateMessage';
import { THead, TRow, Table, Td, Th } from '../ui/Table';

/**
 * Momentum › Journal (BL-024): every weekly signal as it was recorded — unchangeable, so it can
 * later be scored against what happened — and the week's check that every favourite made it in.
 */
export function MomentumJournalView() {
  const [week, setWeek] = useState<string | null>(null);
  const url = week
    ? `/api/momentum/journal?week=${encodeURIComponent(week)}`
    : '/api/momentum/journal';
  const journal = usePolledResource<MomentumJournal>(url);
  const data = journal.data;

  if (journal.error) {
    return (
      <StateMessage
        variant="error"
        title="Could not load the journal"
        description={journal.error}
      />
    );
  }
  if (!data) {
    return (
      <Card>
        <SkeletonRows rows={6} />
      </Card>
    );
  }
  if (!data.available || data.weeks.length === 0) {
    return (
      <StateMessage
        variant="empty"
        title="Nothing recorded yet"
        description="The journal fills from the Friday weekly runs: the 14:40 preview (ETF favourites), the 16:45 final, and the 19:30 run for Stock and Broad favourites. The first entries appear after Friday's runs."
      />
    );
  }

  const check = data.check;
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Forward journal"
          description="Each weekly signal, written down when it was produced and never changed afterwards. A rerun with the same signal adds nothing; a changed one is added as a correction."
        />
        {/* Its own row, not CardHeader actions: beside the title it squeezes the text on a phone. */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Select
            aria-label="Signal week"
            value={week ?? data.week ?? ''}
            onChange={(event) => setWeek(event.target.value)}
            className="w-auto"
          >
            {data.weeks.map((item) => (
              <option key={item.week} value={item.week}>
                Week of {formatDay(item.week)} ({formatInt(item.entries)})
              </option>
            ))}
          </Select>
          <RefreshButton onClick={journal.refetch} loading={journal.loading} />
        </div>
        {check ? <JournalSummary check={check} /> : null}
      </Card>
      {check ? <JournalCheckCard items={check.items} week={check.week} /> : null}
      <JournalEntriesCard entries={data.entries} />
    </div>
  );
}

function JournalSummary({ check }: { check: NonNullable<MomentumJournal['check']> }) {
  const chainOk = check.chain.problems.length === 0;
  const allRecorded = check.recorded === check.expected;
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          label="Recorded this week"
          value={`${formatInt(check.recorded)} / ${formatInt(check.expected)}`}
          tone={allRecorded ? 'positive' : 'negative'}
          note={allRecorded ? 'Every expected signal is in' : 'Some signals are missing'}
          hint="Expected: each favourite's final, each ETF favourite's Friday preview, and the Nifty200 Momentum 30 level."
        />
        <StatCard
          label="Tamper check"
          value={chainOk ? 'Intact' : 'Broken'}
          tone={chainOk ? 'positive' : 'negative'}
          icon={chainOk ? <ShieldCheck className="h-4 w-4" /> : <ShieldAlert className="h-4 w-4" />}
          note={`${formatInt(check.chain.entries)} entries in the chain`}
          hint="Each entry stores a fingerprint of the one before it, so an edited, removed or reordered entry breaks the chain."
        />
        <StatCard
          label="Chain fingerprint"
          value={
            <span className="font-mono text-base">
              {check.chain.head ? check.chain.head.slice(0, 16) : EMPTY}
            </span>
          }
          note={
            check.chain.head ? (
              <CopyButton text={check.chain.head} label="Copy full fingerprint" />
            ) : null
          }
          hint="Should match the latest 'Forward journal' line in Telegram, whose timestamp proves what was recorded and when."
        />
      </div>
      {check.chain.problems.map((problem) => (
        <p key={problem} className="flex items-center gap-1.5 text-sm text-negative">
          <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
          {problem}
        </p>
      ))}
      {check.warnings.map((warning) => (
        <p key={warning} className="flex items-center gap-1.5 text-sm text-warning">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          {warning}
        </p>
      ))}
    </div>
  );
}

const STATUS_BADGE: Record<
  MomentumJournalCheckItem['status'],
  { label: string; tone: 'positive' | 'warning' | 'negative' }
> = {
  recorded: { label: 'Recorded', tone: 'positive' },
  wrong_week: { label: 'Wrong week', tone: 'warning' },
  missing: { label: 'Missing', tone: 'negative' },
};

function JournalCheckCard({ items, week }: { items: MomentumJournalCheckItem[]; week: string }) {
  return (
    <Card>
      <CardHeader
        title={`Week of ${formatDay(week)}: what should be here`}
        description="One row per expected signal. Stock and Broad favourites only get a final (they have no preview); they are evaluated by the 19:30 run."
      />
      <Table>
        <THead>
          <Th>Strategy</Th>
          <Th>Dataset</Th>
          <Th>Run</Th>
          <Th>Status</Th>
          <Th>Recorded</Th>
          <Th>Note</Th>
        </THead>
        <tbody>
          {items.map((item) => {
            const badge = STATUS_BADGE[item.status];
            return (
              <TRow key={`${item.config_id}-${item.run_kind}`}>
                <Td className="font-medium text-foreground">{item.name}</Td>
                <Td className="text-muted">{item.dataset}</Td>
                <Td className="capitalize">{item.run_kind}</Td>
                <Td className="whitespace-nowrap">
                  <Badge tone={badge.tone} dot>
                    {badge.label}
                  </Badge>
                </Td>
                <Td className="whitespace-nowrap text-muted">
                  {item.recorded_at ? formatIstDateTime(item.recorded_at) : EMPTY}
                </Td>
                <Td className="text-xs text-muted">
                  {item.status === 'wrong_week' && item.week
                    ? `Signal labelled week of ${formatDay(item.week)}`
                    : item.corrections > 0
                      ? `${formatInt(item.corrections)} correction(s)`
                      : ''}
                </Td>
              </TRow>
            );
          })}
        </tbody>
      </Table>
    </Card>
  );
}

function topHoldings(holdings: Record<string, number>, limit: number): string {
  const sorted = Object.entries(holdings).sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) return 'Nothing';
  const shown = sorted.slice(0, limit).map(([name, weight]) => `${name} ${formatPct(weight, 0)}`);
  return sorted.length > limit
    ? `${shown.join(', ')} +${formatInt(sorted.length - limit)}`
    : shown.join(', ');
}

function JournalEntriesCard({ entries }: { entries: MomentumJournalEntry[] }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <Card>
      <CardHeader
        title="Entries"
        description="Oldest first. Click an entry for its full actions and holdings. 'Held before' is the model portfolio at the signal's close, before that signal's own trades; next week's entry shows the result."
      />
      {entries.length === 0 ? (
        <p className="text-sm text-muted">No entries for this week.</p>
      ) : (
        <Table>
          <THead>
            <Th align="right">#</Th>
            <Th>Recorded</Th>
            <Th>Run</Th>
            <Th>Strategy</Th>
            <Th>Trades</Th>
            <Th>Held before</Th>
          </THead>
          <tbody>
            {entries.map((entry) => {
              const trades = entry.actions.filter((row) => isTradeAction(row.action));
              const isOpen = open === entry.entry_id;
              return (
                <Fragment key={entry.entry_id}>
                  <TRow selected={isOpen} onClick={() => setOpen(isOpen ? null : entry.entry_id)}>
                    <Td align="right" numeric>
                      {entry.entry_id}
                    </Td>
                    <Td className="whitespace-nowrap text-muted">
                      {formatIstDateTime(entry.recorded_at)}
                    </Td>
                    <Td className="capitalize">{entry.run_kind}</Td>
                    <Td>
                      <span className="font-medium text-foreground">{entry.config_name}</span>
                      {entry.supersedes != null ? (
                        <Badge tone="warning" className="ml-1.5">
                          corrects #{entry.supersedes}
                        </Badge>
                      ) : null}
                    </Td>
                    <Td>
                      {entry.source === 'benchmark' ? (
                        <span className="text-muted">Level {formatNumber(entry.level, 2)}</span>
                      ) : trades.length === 0 ? (
                        <span className="text-muted">No trades</span>
                      ) : (
                        <span className="flex flex-wrap gap-1">
                          {trades.map((row) => (
                            <Badge key={row.asset} tone={actionTone(row.action)}>
                              {row.action} {row.asset}
                            </Badge>
                          ))}
                        </span>
                      )}
                    </Td>
                    <Td className="text-xs text-muted">
                      {entry.source === 'benchmark' ? EMPTY : topHoldings(entry.holdings_before, 3)}
                    </Td>
                  </TRow>
                  {isOpen ? (
                    <tr className="border-b border-border/60 bg-surface-2/40">
                      <td colSpan={6} className="px-3 py-3">
                        <JournalEntryDetail entry={entry} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function JournalEntryDetail({ entry }: { entry: MomentumJournalEntry }) {
  const dirty = entry.code_commit.endsWith('+dirty');
  return (
    <div className="grid gap-4 text-sm md:grid-cols-2">
      <div>
        <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted">
          Actions in this signal
        </div>
        {entry.actions.length === 0 ? (
          <p className="text-muted">None</p>
        ) : (
          <ul className="space-y-1">
            {entry.actions.map((row) => (
              <li key={row.asset} className="flex items-center gap-2">
                <Badge tone={actionTone(row.action)}>{row.action}</Badge>
                <span className="text-foreground">{row.asset}</span>
                {row.rank != null ? (
                  <span className="text-xs text-muted">rank {formatInt(row.rank)}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="space-y-3">
        <div>
          <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted">
            Held before this signal
          </div>
          <p className="text-foreground">{topHoldings(entry.holdings_before, 50)}</p>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted">Code</dt>
          <dd className="flex items-center gap-1.5 font-mono">
            {entry.code_commit.slice(0, 12)}
            {dirty ? (
              <Badge status="attention">uncommitted changes</Badge>
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5 text-positive" aria-label="committed code" />
            )}
          </dd>
          <dt className="text-muted">Settings</dt>
          <dd className="font-mono">{entry.settings_hash}</dd>
          <dt className="text-muted">Data</dt>
          <dd className="break-all font-mono">{entry.data_fingerprint}</dd>
          <dt className="text-muted">Fingerprint</dt>
          <dd className="break-all font-mono">{entry.row_hash}</dd>
        </dl>
      </div>
    </div>
  );
}
