'use client';

import { Pencil } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';

import { usePolledResource } from '../../../hooks/usePolledResource';
import { cn } from '../../../lib/cn';
import {
  formatDay,
  formatIstDateTimeShort,
  formatNumber,
  formatPct,
  formatPp,
} from '../../../lib/format';
import { sparklinePath } from '../../../lib/momentumCompare';
import { isFollowed } from '../../../lib/momentumFavourites';
import {
  CHANGE,
  DATASET_SHORT,
  TRUST,
  cagrMove,
  changeSentence,
  extendedKpis,
  extendedSentence,
  shortVersion,
  strategyDifferences,
  universeTag,
} from '../../../lib/momentumSaved';
import type { SavedStrategy } from '../../../types/momentum';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Drawer } from '../../ui/Drawer';
import { Input, inputClass } from '../../ui/Input';
import { THead, TRow, Table, Td, Th } from '../../ui/Table';
import { StrategyStatusMenu } from './StrategyStatusMenu';

const CURVE_WIDTH = 440;
const CURVE_HEIGHT = 120;

/** Both curves on one log scale, matched by date, so the twin is drawn beside the strategy. */
function scaledPaths(
  dates: string[],
  values: Array<number | null>,
  twin: { dates: string[]; values: Array<number | null> } | null,
): [string | null, string | null] {
  const alone = sparklinePath(values, CURVE_WIDTH, CURVE_HEIGHT, 160);
  if (!twin) return [alone, null];
  const twinBy = new Map(twin.dates.map((date, i) => [date, twin.values[i] ?? null]));
  const pairs: Array<[number, number]> = [];
  dates.forEach((date, i) => {
    const own = values[i];
    const other = twinBy.get(date);
    if (typeof own === 'number' && typeof other === 'number' && own > 0 && other > 0) {
      pairs.push([own, other]);
    }
  });
  if (pairs.length < 2) return [alone, null];
  const logs = pairs.flatMap(([a, b]) => [Math.log(a), Math.log(b)]);
  const low = Math.min(...logs);
  const span = Math.max(...logs) - low || 1;
  const path = (pick: 0 | 1) =>
    pairs
      .map((pair, i) => {
        const x = Math.round((i / (pairs.length - 1)) * CURVE_WIDTH * 10) / 10;
        const y =
          Math.round((1 + (1 - (Math.log(pair[pick]) - low) / span) * (CURVE_HEIGHT - 2)) * 10) /
          10;
        return `${i === 0 ? 'M' : 'L'}${x},${y}`;
      })
      .join(' ');
  return [path(0), path(1)];
}

function Curve({
  values,
  dates,
  twin,
}: {
  values: Array<number | null>;
  dates: string[];
  /** The tradable version of a Not-tradable strategy, drawn dashed beside it. */
  twin: { name: string; dates: string[]; values: Array<number | null> } | null;
}) {
  const [path, twinPath] = scaledPaths(dates, values, twin);
  if (!path) return <p className="text-xs text-faint">No stored curve.</p>;
  return (
    <figure className="space-y-1">
      {twinPath && twin ? (
        <p className="flex flex-wrap gap-x-3 text-xs text-muted">
          <span className="text-primary">— this strategy</span>
          <span>- - {twin.name} (the tradable version)</span>
        </p>
      ) : null}
      <svg
        role="img"
        aria-label="The latest run's equity curve"
        viewBox={`0 0 ${CURVE_WIDTH} ${CURVE_HEIGHT}`}
        className="block h-28 w-full text-primary"
        preserveAspectRatio="none"
      >
        {twinPath ? (
          <path
            d={twinPath}
            fill="none"
            className="stroke-muted"
            strokeWidth={1.5}
            strokeDasharray="4 3"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        <path
          d={path}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <figcaption className="flex justify-between font-mono text-[11px] text-faint">
        <span>{dates[0] ? formatDay(dates[0]) : ''}</span>
        <span>{dates.length ? formatDay(dates[dates.length - 1]) : ''}</span>
      </figcaption>
    </figure>
  );
}

function Section({ title, meta, children }: { title: string; meta?: string; children: ReactNode }) {
  return (
    <section className="space-y-2 border-b border-border pb-4 last:border-b-0">
      <h3 className="flex items-baseline justify-between gap-2 text-sm font-semibold text-foreground">
        {title}
        {meta ? <span className="truncate text-xs font-normal text-muted">{meta}</span> : null}
      </h3>
      {children}
    </section>
  );
}

/**
 * One saved strategy (BL-052): its name, status and result, how its settings differ from the
 * defaults, every run of those settings with why a result moved, notes, and its actions. Opened
 * from the Saved runs list with `?strategy=<id>`.
 */
export function SavedStrategyDrawer({
  strategy,
  twin,
  twinName,
  name,
  defaults,
  ignored,
  followed,
  atLimit,
  onClose,
  onPatch,
  onRemove,
  onReviewed,
  onOpenInBacktest,
  onRerun,
}: {
  /** Null closes the drawer. */
  strategy: SavedStrategy | null;
  /** For a Not-tradable strategy, the same settings with both rules on, if saved. */
  twin: SavedStrategy | null;
  twinName: string;
  name: string;
  defaults: Record<string, unknown> | undefined;
  ignored: ReadonlyArray<string>;
  followed: number | null;
  atLimit: boolean;
  onClose: () => void;
  /** Resolves true once the change is saved. */
  onPatch: (id: string, body: Record<string, unknown>) => Promise<boolean>;
  onRemove: (id: string) => Promise<boolean>;
  onReviewed: (changeId: string) => Promise<void>;
  onOpenInBacktest: (strategy: SavedStrategy) => void;
  onRerun: (strategy: SavedStrategy) => void;
}) {
  return (
    <Drawer
      open={strategy !== null}
      onOpenChange={(open) => (open ? undefined : onClose())}
      title="Saved strategy"
      subtitle={
        strategy
          ? `${DATASET_SHORT[strategy.dataset] ?? strategy.dataset} · ${strategy.runs} ${strategy.runs === 1 ? 'run' : 'runs'}`
          : undefined
      }
    >
      {strategy ? (
        <DrawerBody
          key={strategy.id}
          strategy={strategy}
          twin={twin}
          twinName={twinName}
          name={name}
          defaults={defaults}
          ignored={ignored}
          followed={followed}
          atLimit={atLimit}
          onClose={onClose}
          onPatch={onPatch}
          onRemove={onRemove}
          onReviewed={onReviewed}
          onOpenInBacktest={onOpenInBacktest}
          onRerun={onRerun}
        />
      ) : null}
    </Drawer>
  );
}

function DrawerBody({
  strategy,
  twin,
  twinName,
  name,
  defaults,
  ignored,
  followed,
  atLimit,
  onClose,
  onPatch,
  onRemove,
  onReviewed,
  onOpenInBacktest,
  onRerun,
}: Omit<Parameters<typeof SavedStrategyDrawer>[0], 'strategy'> & { strategy: SavedStrategy }) {
  // The run history comes with the strategy's own record; refetched after a change here.
  const detail = usePolledResource<SavedStrategy>(`/api/momentum/saved-strategies/${strategy.id}`);
  const history = detail.data?.history ?? [];
  const [renaming, setRenaming] = useState<string | null>(null);
  const [notes, setNotes] = useState(strategy.notes ?? '');
  const [confirm, setConfirm] = useState<'headline' | 'remove' | null>(null);
  useEffect(() => setNotes(strategy.notes ?? ''), [strategy.notes]);

  const isGroup = strategy.group !== null;
  const kpis = strategy.latest.kpis;
  const universe = universeTag(strategy);
  const extended = isGroup ? null : extendedKpis(kpis);
  const differences = defaults ? strategyDifferences(strategy.config, defaults, ignored) : null;
  const trust = strategy.trust ? TRUST[strategy.trust] : null;
  const moved = strategy.change ? cagrMove(strategy.change) : null;
  const refresh = detail.refetch;

  async function patch(body: Record<string, unknown>): Promise<boolean> {
    const ok = await onPatch(strategy.id, body);
    if (ok) refresh();
    return ok;
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {renaming !== null ? (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const next = renaming.trim();
              if (!next) return;
              void patch({ name: next }).then((ok) => ok && setRenaming(null));
            }}
          >
            <Input
              aria-label="Strategy name"
              value={renaming}
              maxLength={64}
              autoFocus
              onChange={(event) => setRenaming(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation();
                  setRenaming(null);
                }
              }}
            />
            <Button type="submit" size="sm" variant="primary">
              Save
            </Button>
          </form>
        ) : (
          <div className="flex items-start gap-2">
            <h2 className="min-w-0 flex-1 text-base font-semibold leading-snug text-foreground">
              {name}
            </h2>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Rename ${name}`}
              onClick={() => setRenaming(strategy.name_typed ? strategy.name : name)}
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden />
              Rename
            </Button>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          {strategy.active ? (
            <Badge tone="primary" dot>
              Headline
            </Badge>
          ) : null}
          {trust ? (
            <span title={trust.hint}>
              <Badge tone={trust.tone}>{trust.label}</Badge>
            </span>
          ) : null}
          {strategy.change ? (
            <span title={CHANGE[strategy.change.label].hint}>
              <Badge tone={CHANGE[strategy.change.label].tone}>
                Moved {formatPp(moved)} · {CHANGE[strategy.change.label].label}
              </Badge>
            </span>
          ) : null}
          {isGroup ? <Badge tone="neutral">Group · {strategy.group?.length} runs</Badge> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {strategy.member_of ? (
            <span className="text-xs text-muted">Follows its group's status.</span>
          ) : (
            <StrategyStatusMenu
              name={name}
              status={strategy.status}
              isGroup={isGroup}
              followed={followed}
              atLimit={atLimit}
              onChange={(value) => void patch({ status: value })}
            />
          )}
          {strategy.favorite && !strategy.active && !strategy.member_of ? (
            confirm === 'headline' ? (
              <span className="flex items-center gap-1.5 text-xs text-muted">
                Send this one to Telegram instead?
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => void patch({ active: true }).then(() => setConfirm(null))}
                >
                  Make headline
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                  Cancel
                </Button>
              </span>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                disabled={atLimit && !isFollowed(strategy.status)}
                onClick={() => setConfirm('headline')}
              >
                Make headline
              </Button>
            )
          ) : null}
        </div>
      </div>

      {isGroup ? (
        <Section title="Members" meta="each a strategy of its own, run and journalled every Friday">
          <ul className="space-y-1 text-sm">
            {(strategy.members ?? []).map((member) => (
              <li key={member.id} className="flex justify-between gap-2">
                <span className="truncate">{member.name}</span>
                <span className="font-mono text-xs text-muted">
                  {formatPct(member.latest.kpis.cagr)}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : (
        <>
          <Section
            title="Result"
            meta={`latest run ${formatIstDateTimeShort(strategy.latest.created_at)}${strategy.latest.data_through ? ` · data to ${formatDay(strategy.latest.data_through)}` : ''}`}
          >
            <dl className="grid grid-cols-4 gap-2">
              {[
                ['CAGR', formatPct(kpis.cagr), ''],
                [
                  'vs benchmark',
                  formatPp(kpis.excess_cagr),
                  (kpis.excess_cagr ?? 0) >= 0 ? 'text-positive' : 'text-negative',
                ],
                ['Max DD', formatPct(kpis.max_drawdown), 'text-negative'],
                ['Sharpe', formatNumber(kpis.sharpe, 2), ''],
              ].map(([label, value, tone]) => (
                <div key={label} className="rounded-lg border border-border px-2.5 py-2">
                  <dt className="text-[10.5px] font-semibold uppercase tracking-wider text-faint">
                    {label}
                  </dt>
                  <dd className={cn('font-mono text-base font-semibold', tone)}>{value}</dd>
                </div>
              ))}
            </dl>
            {universe || extended ? (
              <p className="mt-2 text-xs text-muted">
                {universe ? `Universe: ${universe}.` : null}
                {universe && extended ? ' ' : null}
                {extended ? `${extendedSentence(extended)}.` : null}
              </p>
            ) : null}
            <Curve
              values={strategy.latest.strategy}
              dates={strategy.latest.dates}
              twin={
                twin
                  ? { name: twinName, dates: twin.latest.dates, values: twin.latest.strategy }
                  : null
              }
            />
          </Section>

          <Section title={`Different from the ${DATASET_SHORT[strategy.dataset] ?? ''} defaults`}>
            {differences === null ? (
              <p className="text-xs text-muted">Loading the defaults…</p>
            ) : differences.length === 0 ? (
              <p className="text-xs text-muted">Every setting is the default.</p>
            ) : (
              <Table>
                <THead>
                  <Th>Setting</Th>
                  <Th>This strategy</Th>
                  <Th>Default</Th>
                </THead>
                <tbody>
                  {differences.map((difference) => (
                    <TRow key={difference.key}>
                      <Td className="max-w-40 truncate">{difference.label}</Td>
                      <Td className="max-w-32 truncate text-warning" title={difference.values[0]}>
                        {difference.values[0]}
                      </Td>
                      <Td className="max-w-32 truncate text-muted" title={difference.values[1]}>
                        {difference.values[1]}
                      </Td>
                    </TRow>
                  ))}
                </tbody>
              </Table>
            )}
            <p className="text-xs text-faint">
              Settings this dataset never reads are not compared; they are why some runs that looked
              different were one strategy.
            </p>
          </Section>

          <Section title="Run history" meta="the list shows the latest; earlier results stay here">
            {/* One line per run, like every table here. */}
            {detail.loading && !detail.data ? (
              <p className="text-xs text-muted">Loading the runs…</p>
            ) : (
              <Table className="[&_td]:whitespace-nowrap">
                <THead>
                  <Th>Ran</Th>
                  <Th align="right">CAGR</Th>
                  <Th>Code</Th>
                  <Th>Data</Th>
                  <Th>Why it moved</Th>
                </THead>
                <tbody>
                  {history.map((run) => (
                    <TRow key={run.id}>
                      <Td className="text-xs text-muted" title={run.name ?? undefined}>
                        {formatIstDateTimeShort(run.created_at)}
                      </Td>
                      <Td align="right" numeric>
                        {formatPct(run.kpis.cagr)}
                      </Td>
                      <Td className="font-mono text-xs text-muted">
                        {shortVersion(run.versions?.code)}
                      </Td>
                      <Td className="font-mono text-xs text-muted">
                        {shortVersion(run.versions?.data)}
                      </Td>
                      <Td>
                        {run.change ? (
                          <span
                            className="flex items-center gap-1.5"
                            title={changeSentence(run.change)}
                          >
                            <Badge tone={CHANGE[run.change.label].tone}>
                              {formatPp(cagrMove(run.change))} · {CHANGE[run.change.label].label}
                            </Badge>
                            {run.change.needs_review ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 px-1.5"
                                onClick={() =>
                                  void onReviewed(run.change?.change_id ?? '').then(refresh)
                                }
                              >
                                Mark reviewed
                              </Button>
                            ) : run.change.reviewed_at ? (
                              <span className="text-xs text-faint">reviewed</span>
                            ) : null}
                          </span>
                        ) : (
                          <span className="text-xs text-faint">
                            {run.outcome === 'repeat'
                              ? 'same result'
                              : run.outcome === 'new'
                                ? 'first run'
                                : ''}
                          </span>
                        )}
                      </Td>
                    </TRow>
                  ))}
                </tbody>
              </Table>
            )}
            {strategy.change ? (
              <p className="text-xs text-muted">{changeSentence(strategy.change)}</p>
            ) : null}
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => onRerun(strategy)}>
                Re-run now to check
              </Button>
              <span className="text-xs text-faint">
                today's code and data, compared with the latest
              </span>
            </div>
          </Section>
        </>
      )}

      <Section title="Notes">
        <textarea
          aria-label="Notes"
          className={cn(inputClass, 'min-h-16 resize-y')}
          placeholder="Why you kept it"
          maxLength={500}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          onBlur={() => {
            if (notes !== (strategy.notes ?? '')) void patch({ notes });
          }}
        />
        <p className="text-xs text-faint">Saved with the strategy when you leave the box.</p>
      </Section>

      <div className="flex flex-wrap gap-2">
        {isGroup ? null : (
          <>
            <Button size="sm" variant="primary" onClick={() => onOpenInBacktest(strategy)}>
              Open in Backtest
            </Button>
            <Button size="sm" onClick={() => void patch({ overlay: !strategy.overlay })}>
              {strategy.overlay ? 'Hide from Backtest chart' : 'Show on Backtest chart'}
            </Button>
          </>
        )}
        <span className="grow" />
        {confirm === 'remove' ? (
          <span className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="danger"
              onClick={() => void onRemove(strategy.id).then((ok) => ok && onClose())}
            >
              {isGroup
                ? 'Remove group (keeps its runs)'
                : `Remove ${strategy.runs} ${strategy.runs === 1 ? 'run' : 'runs'}`}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
          </span>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="text-negative"
            onClick={() => setConfirm('remove')}
          >
            Remove
          </Button>
        )}
      </div>
    </div>
  );
}
