/**
 * One day of the rotation log in a drawer: what each list picked at 09:16, what each pick then did,
 * the context the entry was scored on, the chain hash, and the owner's placement record.
 *
 * The three things are kept apart in the words: SCHEDULED is the journal (what the rule picked),
 * SIMULATED is the stored result (what the pick did on the data), EXECUTED is what the owner
 * marks here by hand. Nothing here changes a pick, a list or a result: the placement form appends
 * one row to its own file, and what it shows afterwards is what the server read back.
 */

import { useState } from 'react';

import { useRotationDay, useSavePlacement } from '../../hooks/useRotationDailyLog';
import { cn } from '../../lib/cn';
import {
  EMPTY,
  formatDay,
  formatInr,
  formatIstDateTimeShort,
  formatNumber,
} from '../../lib/format';
import {
  LIST_KEYS,
  NOTE_MAX,
  PLACEMENT_LABEL,
  STATUS_LABEL,
  STATUS_TONE,
  pickLabel,
  placementProblem,
  rowFlags,
} from '../../lib/rotationDailyLogView';
import type {
  PlacementStatus,
  RotationDay,
  RotationListBlock,
  RotationListKey,
  RotationPlacement,
} from '../../types/rotationDailyLog';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { CopyButton } from '../ui/CopyButton';
import { Drawer } from '../ui/Drawer';
import { Input } from '../ui/Input';
import { SegmentedControl, type SegmentedOption } from '../ui/SegmentedControl';
import { Skeleton } from '../ui/Skeleton';
import { StateMessage } from '../ui/StateMessage';
import { toast } from '../ui/Toast';
import { pnlClass } from './shared';

const PLACEMENT_OPTIONS: SegmentedOption<PlacementStatus>[] = (
  ['placed', 'changed', 'not_placed'] as const
).map((value) => ({ value, label: PLACEMENT_LABEL[value] }));

function Section({
  title,
  children,
  aside,
}: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-faint">{title}</h4>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right text-foreground">{children}</dd>
    </div>
  );
}

function Basket({
  listKey,
  block,
  description,
  sameAs,
  day,
  onReplay,
}: {
  listKey: RotationListKey;
  block: RotationListBlock;
  description: string | undefined;
  sameAs: RotationListKey | null;
  day: string;
  onReplay: (variant: string, day: string) => void;
}) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <span className="text-sm font-semibold text-foreground">List {listKey}</span>
          {sameAs ? (
            <span className="ml-2 text-xs text-faint">same strategies as {sameAs}</span>
          ) : null}
        </div>
        <div className="text-right">
          {block.per_lot_day !== null && block.gross !== null ? (
            <span
              className={cn('metric text-sm', pnlClass(block.per_lot_day))}
              title={`${formatInr(block.gross, { sign: true })} gross for ${block.lots} lots`}
            >
              {formatInr(block.per_lot_day, { sign: true })}
              <span className="ml-1 text-xs text-faint">/ lot-day</span>
            </span>
          ) : (
            <span className="text-xs text-faint" title={block.missing.join(', ')}>
              {block.missing.length > 0
                ? `no result for ${block.missing.length} of ${block.picks.length}`
                : 'no result yet'}
            </span>
          )}
        </div>
      </div>
      {description ? (
        <p className="mt-0.5 truncate text-xs text-faint" title={description}>
          {description}
        </p>
      ) : null}
      <table className="mt-2 w-full text-xs">
        <thead>
          <tr className="text-faint">
            <th className="py-1 text-left font-medium">Strategy (1 lot)</th>
            <th className="py-1 text-right font-medium">Gross</th>
            <th className="py-1 text-right font-medium">Worst MTM</th>
            <th className="py-1 text-right font-medium">Stop</th>
          </tr>
        </thead>
        <tbody>
          {block.picks.map((p) => (
            <tr key={p.name} className="h-8 border-t border-border/60">
              <td className="py-1 pr-2">
                <div className="truncate text-foreground" title={p.name}>
                  {pickLabel(p)}
                  {p.role === 'buy' ? <span className="ml-1.5 text-faint">add-on</span> : null}
                </div>
                <div className="flex items-center gap-1 font-mono text-[11px] text-faint">
                  <span className="truncate">
                    {p.name}
                    {p.composite !== null ? ` · score ${formatNumber(p.composite, 3)}` : ''}
                  </span>
                  {p.result !== null ? (
                    <button
                      type="button"
                      onClick={() => onReplay(p.name, day)}
                      className="shrink-0 rounded px-1 font-sans text-[11px] font-medium text-primary hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`Replay ${p.name} on ${formatDay(day)}`}
                      title="Replay this strategy's day minute by minute"
                    >
                      Replay
                    </button>
                  ) : null}
                </div>
              </td>
              {p.result === null ? (
                <td className="py-1 text-right text-faint" colSpan={3}>
                  no stored result yet
                </td>
              ) : (
                <>
                  <td className={cn('metric py-1 text-right', pnlClass(p.result.gross))}>
                    {formatInr(p.result.gross, { sign: true })}
                  </td>
                  <td className="metric py-1 text-right text-muted">
                    {p.result.worst_mtm === null ? EMPTY : formatInr(p.result.worst_mtm)}
                  </td>
                  <td className="py-1 text-right">
                    {p.result.stop ? (
                      <span
                        className={p.result.stop === 'sl' ? 'text-negative' : 'text-positive'}
                        title={p.result.stopped_by}
                      >
                        {p.result.stopped_by.replace(/^overall /i, '')}
                      </span>
                    ) : (
                      <span className="text-faint">none</span>
                    )}
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1.5 text-[11px] text-faint">
        {block.overridden ? 'The Widesl minimum replaced a top-ranked Dir. ' : ''}
        {block.buy_qualified
          ? 'A Buy strategy ranked in the overall top 10 and was added. '
          : 'No Buy strategy was in the overall top 10. '}
        {block.lots} lots in total, 2 a strategy.
      </p>
    </div>
  );
}

function PlacementRow({
  day,
  listKey,
  saved,
  onSaved,
}: {
  day: string;
  listKey: RotationListKey;
  /** The row the day's last read gave for this list. */
  saved: RotationPlacement | undefined;
  onSaved: () => void;
}) {
  // The saved state is what the server last answered: the day's read, or the POST's own reply,
  // whichever is newer, so a failed re-read after a successful save cannot offer the same Save
  // again (a second click would append a duplicate).
  const [answered, setAnswered] = useState<RotationPlacement | undefined>(saved);
  const current = latest(saved, answered);
  const [status, setStatus] = useState<PlacementStatus | ''>(current?.status ?? '');
  const [note, setNote] = useState(current?.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const { save, saving } = useSavePlacement();
  const problem = placementProblem(status, note);
  const unchanged =
    current !== undefined && current.status === status && current.note === note.trim();

  async function submit() {
    if (status === '' || problem !== null) return;
    setError(null);
    const result = await save({ day, list: listKey, status, note: note.trim() });
    if (result.ok) {
      setAnswered(result.data.row);
      toast(
        result.data.written === false
          ? `List ${listKey}: already marked ${PLACEMENT_LABEL[result.data.row.status].toLowerCase()}`
          : `List ${listKey}: ${PLACEMENT_LABEL[result.data.row.status].toLowerCase()} saved`,
      );
      onSaved();
    } else {
      setError(result.error);
    }
  }

  return (
    <div className="space-y-1.5 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold text-foreground">List {listKey}</span>
        <span className="text-xs text-faint">
          {current
            ? `saved: ${PLACEMENT_LABEL[current.status]}, ${formatIstDateTimeShort(current.at)}`
            : 'not marked yet'}
        </span>
      </div>
      <SegmentedControl
        value={status as PlacementStatus}
        options={PLACEMENT_OPTIONS}
        onChange={(v) => {
          setStatus(v);
          setError(null);
        }}
        ariaLabel={`Placement of list ${listKey}`}
        size="sm"
      />
      <Input
        value={note}
        maxLength={NOTE_MAX + 50}
        onChange={(e) => {
          setNote(e.target.value);
          setError(null);
        }}
        placeholder={status === 'changed' ? 'What was changed (required)' : 'Note (optional)'}
        aria-label={`Note for list ${listKey}`}
      />
      <div className="flex items-start justify-between gap-2">
        {error ? (
          <span role="alert" className="text-xs font-medium text-negative">
            Not saved: {error}
          </span>
        ) : (
          <span
            className={cn('text-xs', problem && status !== '' ? 'text-negative' : 'text-faint')}
          >
            {status === ''
              ? 'Choose one to enable Save.'
              : (problem ?? `${note.trim().length}/${NOTE_MAX}`)}
          </span>
        )}
        <Button
          size="sm"
          variant="primary"
          loading={saving}
          disabled={status === '' || problem !== null || unchanged}
          onClick={() => void submit()}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

/** The newer of two placement rows for the same list (ISO stamps in one zone compare as text). */
function latest(
  a: RotationPlacement | undefined,
  b: RotationPlacement | undefined,
): RotationPlacement | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return b.at > a.at ? b : a;
}

function DayBody({
  d,
  onChanged,
  onReplay,
  refreshError,
}: {
  d: RotationDay;
  onChanged: () => void;
  onReplay: (variant: string, day: string) => void;
  /** The latest re-read of the day failed: what is shown is from before it. */
  refreshError: string | null;
}) {
  const flags = rowFlags(d);
  const keys = LIST_KEYS.filter((k) => d.lists[k] !== undefined);
  const sameAs = (k: RotationListKey): RotationListKey | null => {
    const group = d.groups.find((g) => g.includes(k));
    const first = group?.[0] as RotationListKey | undefined;
    return first && first !== k ? first : null;
  };
  const recorded = d.recorded;
  const rescore = d.rescore;
  return (
    <div className="space-y-5">
      {refreshError ? (
        <StateMessage
          variant="error"
          title="The day could not be re-read"
          description={`What is shown may be out of date; anything you saved was written. ${refreshError}`}
        />
      ) : null}
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={STATUS_TONE[d.status]}>{STATUS_LABEL[d.status]}</Badge>
          {d.source === 'reconstructed' ? <Badge tone="neutral">Reconstructed</Badge> : null}
          {flags
            .filter((f) => f.id !== 'reconstructed' && f.id !== 'late')
            .map((f) => (
              <span key={f.id} title={f.title}>
                <Badge tone={f.tone}>{f.label}</Badge>
              </span>
            ))}
        </div>
        {d.status_detail ? <p className="text-sm text-muted">{d.status_detail}</p> : null}
        {d.source === 'reconstructed' ? (
          <p className="text-sm text-muted">
            Re-scored afterwards from the results before this day and this day's VIX open, weekday
            and days to expiry. It is what the rule would have picked, not an entry written at
            09:16, and the weights were chosen on this history.
          </p>
        ) : null}
      </div>

      {keys.length > 0 ? (
        <Section title="Scheduled and simulated (gross, one lot per strategy)">
          <div className="space-y-3">
            {keys.map((k) => {
              const block = d.lists[k];
              if (block === undefined) return null;
              return (
                <Basket
                  key={k}
                  listKey={k}
                  block={block}
                  description={d.list_info[k]?.description}
                  sameAs={sameAs(k)}
                  day={d.day}
                  onReplay={onReplay}
                />
              );
            })}
          </div>
        </Section>
      ) : null}

      {d.vix || d.dte ? (
        <Section title="What the entry was scored on">
          <dl className="space-y-1">
            {d.vix ? (
              <Fact label="India VIX 09:15 open">
                <span className="metric">{formatNumber(d.vix.open, 2)}</span>
                <span className="ml-1.5 text-faint">
                  {d.vix.band ?? EMPTY}
                  {d.vix.source ? ` · ${d.vix.source}` : ''}
                </span>
              </Fact>
            ) : null}
            {d.dte ? (
              <Fact label="Days to expiry NIFTY / SENSEX">
                <span className="metric">
                  {d.dte.NIFTY ?? EMPTY} / {d.dte.SENSEX ?? EMPTY}
                </span>
                {d.dte.source ? <span className="ml-1.5 text-faint">{d.dte.source}</span> : null}
              </Fact>
            ) : null}
            {d.entry?.inputs_days != null ? (
              <Fact label="Results ranked on">
                <span className="metric">{d.entry.inputs_days}</span>
                <span className="ml-1.5 text-faint">earlier days</span>
              </Fact>
            ) : null}
          </dl>
        </Section>
      ) : null}

      {recorded ? (
        <Section
          title="The record"
          aside={
            recorded.hash ? <CopyButton text={recorded.hash} label="Copy chain hash" /> : undefined
          }
        >
          <dl className="space-y-1">
            <Fact label="Recorded">
              <span className="metric">{recorded.time ?? EMPTY}</span>
              <span className="ml-1.5 text-faint">
                IST, {recorded.on_time ? 'before 09:17' : 'after 09:17: not forward'}
              </span>
            </Fact>
            <Fact label="Chain hash">
              <span className="font-mono text-xs" title={recorded.hash ?? ''}>
                {recorded.hash_short}
              </span>
              <span className="ml-1.5 text-faint">entry {recorded.position}</span>
            </Fact>
            <Fact label="Code commit">
              <span className="font-mono text-xs">{recorded.commit ?? EMPTY}</span>
            </Fact>
            <Fact label="Chain">
              {recorded.chain_ok && d.journal_intact ? (
                <span className="text-positive">intact</span>
              ) : (
                <span className="text-negative">does not verify: run obt rotation verify</span>
              )}
            </Fact>
            {rescore?.checked ? (
              <Fact label="Re-scored today">
                {rescore.same_picks ? (
                  <span className="text-positive">same picks</span>
                ) : (
                  <span className="text-negative">
                    different picks in {(rescore.differs ?? []).join(', ')}
                  </span>
                )}
                <span className="ml-1.5 text-faint">
                  {rescore.same_inputs
                    ? 'on the same stored results'
                    : 'stored results have changed'}
                </span>
              </Fact>
            ) : rescore?.note ? (
              <Fact label="Re-scored today">
                <span className="text-faint" title={rescore.note}>
                  not possible now
                </span>
              </Fact>
            ) : null}
          </dl>
        </Section>
      ) : null}

      {d.source === 'recorded' ? (
        <Section title="Executed: what you placed on AlgoTest">
          <p className="text-xs text-muted">
            Mark each list by hand. This is your own record; it never changes a pick or a result,
            and a later mark for a list replaces the earlier one in the view (the earlier rows are
            kept).
          </p>
          <div className="space-y-3">
            {keys.map((k) => (
              <PlacementRow
                key={k}
                day={d.day}
                listKey={k}
                saved={d.placement[k]}
                onSaved={onChanged}
              />
            ))}
          </div>
          {d.placement_history.length > Object.keys(d.placement).length ? (
            <details className="text-xs text-muted">
              <summary className="cursor-pointer">
                History ({d.placement_history.length} rows)
              </summary>
              <ul className="mt-1 space-y-0.5">
                {d.placement_history.map((p, i) => (
                  <li key={`${i}-${p.list}-${p.at}`}>
                    {formatIstDateTimeShort(p.at)}: {p.list}{' '}
                    {PLACEMENT_LABEL[p.status].toLowerCase()}
                    {p.note ? ` (${p.note})` : ''}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </Section>
      ) : (
        <p className="text-xs text-faint">
          A placement can only be marked on a day with a recorded entry.
        </p>
      )}
    </div>
  );
}

/**
 * The drawer. The inner body mounts only while a day is open, so the day's request is made then
 * and not before. `onChanged` is called after a placement is saved, so the log behind it reloads.
 */
export function RotationDailyLogDrawer({
  day,
  onClose,
  onChanged,
  onReplay,
}: {
  day: string | null;
  onClose: () => void;
  onChanged: () => void;
  /** Open one pick's day in Day forensics (the caller closes the drawer and shows it). */
  onReplay: (variant: string, day: string) => void;
}) {
  return (
    <Drawer
      open={day !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={day ? formatDay(day) : 'Day'}
      subtitle="Rotation daily log"
    >
      {day ? <DayLoader key={day} day={day} onChanged={onChanged} onReplay={onReplay} /> : null}
    </Drawer>
  );
}

function DayLoader({
  day,
  onChanged,
  onReplay,
}: {
  day: string;
  onChanged: () => void;
  onReplay: (variant: string, day: string) => void;
}) {
  const res = useRotationDay(day);
  if (res.error && !res.data) {
    return (
      <div className="space-y-3">
        <StateMessage variant="error" title="Could not load this day" description={res.error} />
        <Button size="sm" onClick={res.refetch}>
          Retry
        </Button>
      </div>
    );
  }
  if (!res.data) {
    return (
      <output aria-busy="true" aria-label="Loading the day" className="block space-y-3">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </output>
    );
  }
  return (
    <DayBody
      d={res.data}
      refreshError={res.error}
      onReplay={onReplay}
      onChanged={() => {
        res.refetch();
        onChanged();
      }}
    />
  );
}
