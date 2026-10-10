'use client';

/**
 * Options Lab → Rotation → Shadow scoreboard: the ideas kept for forward observation, each
 * against the pick it would have replaced, on days the research never saw.
 *
 *   1. The four intraday triggers against their placebo, per template (event minus placebo,
 *      day-clustered), beside the research's figures.
 *   2. The override against the pick it displaces: on a day with a pivot-cross or RSI event, the
 *      Dir at that minute minus the list's next not-yet-started core pick, per day and running.
 *   3. The research comparison: what the research found for the same override.
 *   4. The two forward candidates from the hourly-checkpoint study, which have no scoring yet.
 *
 * The figures come from `GET /legwise/rotation/shadow` (`rotation/shadow.py`), read-only. Gross
 * rupees throughout. A day that is not scored shows why; it is never a zero. Nothing here changes
 * a list, a weight or a pick.
 */

import { useState } from 'react';

import { useRotationShadow } from '../../hooks/useRotationShadow';
import { EMPTY, formatDay, formatInr, formatInt, formatPct } from '../../lib/format';
import {
  bannerText,
  dayCells,
  emptyState,
  overrideEmpty,
  researchRows,
  statusSummary,
  triggerCells,
} from '../../lib/rotationShadowView';
import type {
  RotationShadowResponse,
  ShadowListKey,
  ShadowListSummary,
} from '../../types/rotationShadow';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { RefreshButton } from '../ui/RefreshButton';
import { SegmentedControl, type SegmentedOption } from '../ui/SegmentedControl';
import { SkeletonRows } from '../ui/Skeleton';
import { StatCard } from '../ui/StatCard';
import { StateMessage } from '../ui/StateMessage';
import { THead, TRow, Table, Td, Th } from '../ui/Table';
import { RotationShadowChart } from './RotationShadowChart';

const TONE_CLASS = {
  positive: 'text-positive',
  negative: 'text-negative',
  muted: 'text-muted',
} as const;

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

function ChainBadge({ j }: { j: RotationShadowResponse['journal'] }) {
  if (j.error) return <Badge tone="negative">Journal unreadable</Badge>;
  if (!j.exists) return <Badge tone="neutral">No journal yet</Badge>;
  if (j.chain_intact === false) return <Badge tone="negative">Journal chain broken</Badge>;
  return <Badge tone="positive">Journal chain intact</Badge>;
}

function Banner({ r }: { r: RotationShadowResponse }) {
  const b = r.banner;
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-medium text-foreground">{bannerText(b)}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="info">Gross</Badge>
          <ChainBadge j={r.journal} />
          {r.journal.late > 0 ? (
            <Badge tone="warning">
              {formatInt(r.journal.late)} late {r.journal.late === 1 ? 'entry' : 'entries'} excluded
            </Badge>
          ) : null}
        </div>
      </div>
      <p className="mt-1.5 text-xs text-muted">
        {b.remaining > 0
          ? `${formatInt(b.remaining)} more sessions to the judgement. `
          : 'The judgement point has been reached. '}
        Until then every figure is descriptive: a handful of days cannot confirm or refute an idea
        that won on two years of one regime.
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 1. Triggers
// ---------------------------------------------------------------------------

function TriggerTable({ r }: { r: RotationShadowResponse }) {
  return (
    <Card>
      <CardHeader
        title="Triggers against their placebo"
        description="Each template entered the minute after the trigger, minus the same template at the same minute on the 20 earlier days with no event. ₹ per lot, gross."
      />
      <Table>
        <THead>
          <Th>Trigger</Th>
          <Th>Template</Th>
          <Th align="right">Event days</Th>
          <Th align="right">Event avg</Th>
          <Th align="right">Placebo avg</Th>
          <Th align="right">Difference</Th>
          <Th align="right">t</Th>
          <Th align="right">Research, last 2 years</Th>
          <Th align="right">Research, 2022-24</Th>
        </THead>
        <tbody>
          {r.triggers.map((row) => {
            const c = triggerCells(row);
            return (
              <TRow key={c.key} highlighted={c.candidate}>
                <Td dense className="whitespace-nowrap">
                  {c.trigger}
                </Td>
                <Td dense className="whitespace-nowrap">
                  {c.template}
                  {c.candidate ? (
                    <Badge tone="primary" className="ml-2">
                      Candidate
                    </Badge>
                  ) : null}
                </Td>
                <Td dense align="right" numeric>
                  {c.days}
                  {c.flag ? <span className="ml-2 text-xs text-faint">{c.flag}</span> : null}
                </Td>
                <Td dense align="right" numeric>
                  {c.eventAvg}
                </Td>
                <Td dense align="right" numeric>
                  {c.placeboAvg}
                </Td>
                <Td dense align="right" numeric className={TONE_CLASS[c.diffTone]}>
                  {c.diff}
                </Td>
                <Td dense align="right" numeric>
                  {c.t}
                </Td>
                <Td dense align="right" numeric className="text-muted">
                  {c.explore}
                </Td>
                <Td dense align="right" numeric className="text-muted">
                  {c.confirm}
                </Td>
              </TRow>
            );
          })}
        </tbody>
      </Table>
      <p className="mt-3 text-xs text-faint">
        An event day is a day on which the trigger fired on either index (both indices on one day
        count once). t is shown from 5 event days; below that the row says n &lt; 5. The research
        columns are the same difference over 2024-10 to 2026-10 (both indices) and 2022 to 2024
        (NIFTY), ₹ per lot.
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 2. Override against the displaced pick
// ---------------------------------------------------------------------------

function listOptions(lists: readonly ShadowListSummary[]): SegmentedOption<ShadowListKey>[] {
  return lists.map((l) => ({
    value: l.list,
    label: l.candidate ? `${l.list} (candidate)` : l.list,
  }));
}

function OverrideCard({ r }: { r: RotationShadowResponse }) {
  const [key, setKey] = useState<ShadowListKey>('B');
  const list = r.override.lists.find((l) => l.list === key) ?? r.override.lists[0];
  if (!list) return null;
  const rule = r.override.rule;
  const rows = r.override.days.filter((d) => d.list === list.list);
  const empty =
    list.scored === 0 ? overrideEmpty(list.forward_days, list.event_days, r.journal.forward) : null;
  const random = r.override.controls.random_time;
  const placebo = r.override.controls.placebo;

  return (
    <Card>
      <CardHeader
        title="Override against the pick it displaces"
        description={`On a day with a pivot-cross (T1) or RSI-exhaustion (T4) event, the earliest one fires a Dir at that minute and replaces the list's next not-yet-started core pick, one starting ${rule.min_lead_minutes} or more minutes later; skipped if fewer than ${rule.min_widesl} Widesl would remain. Lots are conserved (${rule.lots_per_strategy} per strategy). Each figure is the Dir minus the pick it replaced, gross.`}
        actions={
          <SegmentedControl
            value={key}
            options={listOptions(r.override.lists)}
            onChange={setKey}
            ariaLabel="List"
            size="sm"
          />
        }
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Event days"
          value={formatInt(list.event_days)}
          note={statusSummary(list)}
        />
        <StatCard
          label="Override minus pick"
          value={formatInr(list.total_basket, { sign: true, compact: true })}
          tone={
            list.total_basket === null ? 'muted' : list.total_basket >= 0 ? 'positive' : 'negative'
          }
          note={
            list.scored > 0
              ? `${formatInt(list.scored)} scored days, ${rule.lots_per_strategy} lots`
              : 'no scored day yet'
          }
          hint="The running sum, over the scored days, of the Dir's result at the event minute minus the displaced pick's result, on the list's lots. Pending days are not in it."
        />
        <StatCard
          label="Per lot-day"
          value={formatInr(list.mean_lot, { sign: true })}
          tone={list.mean_lot === null ? 'muted' : list.mean_lot >= 0 ? 'positive' : 'negative'}
          note="mean of the scored days, 1 lot"
        />
        <StatCard
          label="Days it beat the pick"
          value={list.beat_share === null ? EMPTY : formatPct(list.beat_share, 0)}
          note={list.scored > 0 ? `of ${formatInt(list.scored)} scored days` : 'no scored day yet'}
        />
      </div>

      <div className="mt-5">
        {empty ? (
          <StateMessage variant="empty" title={empty.title} description={empty.description} />
        ) : (
          <>
            <RotationShadowChart series={list.series} />
            <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted">
              <span className="flex items-center gap-2">
                <span className="inline-block h-0.5 w-6 bg-primary" aria-hidden="true" />
                The Dir at the event minute minus the displaced pick
              </span>
              <span className="flex items-center gap-2">
                <span
                  className="inline-block h-0 w-6 border-t-2 border-dashed border-accent"
                  aria-hidden="true"
                />
                {list.control_days > 0
                  ? `The same Dir at that minute on the 20 earlier no-event days, minus that pick (${formatInt(list.control_days)} days, ${formatInr(list.control_total_basket, { sign: true, compact: true })})`
                  : 'The time-matched placebo Dir: not enough placebo days yet'}
              </span>
            </div>
          </>
        )}
      </div>

      <div className="mt-3 rounded-lg border border-border bg-surface-2/60 px-4 py-3 text-xs text-muted">
        <p>
          <span className="font-medium text-foreground">Random-time control: </span>
          {random.reason}
        </p>
        <p className="mt-1.5">
          <span className="font-medium text-foreground">What the dashed line is: </span>
          {placebo.reason} The gap between the two lines is the trigger's timing; what is left above
          or below zero is "a Dir in place of that pick on that day".
        </p>
      </div>

      {rows.length > 0 ? (
        <div className="mt-5">
          <Table maxHeight={360}>
            <THead>
              <Th>Day</Th>
              <Th>Event</Th>
              <Th>Displaced pick</Th>
              <Th align="right">Dir (1 lot)</Th>
              <Th align="right">Pick (1 lot)</Th>
              <Th align="right">Diff (1 lot)</Th>
              <Th align="right">Diff ({rule.lots_per_strategy} lots)</Th>
              <Th
                align="right"
                title="The same Dir at the same minute on ordinary days, minus that pick"
              >
                Placebo minus pick
              </Th>
              <Th>Status</Th>
            </THead>
            <tbody>
              {rows.map((row) => {
                const c = dayCells(row);
                return (
                  <TRow key={c.key}>
                    <Td dense className="whitespace-nowrap">
                      {c.day}
                    </Td>
                    <Td dense className="whitespace-nowrap font-mono text-xs">
                      {c.event}
                    </Td>
                    <Td dense className="whitespace-nowrap font-mono text-xs">
                      {c.displaced}
                    </Td>
                    <Td dense align="right" numeric>
                      {c.dirNet}
                    </Td>
                    <Td dense align="right" numeric>
                      {c.displacedGross}
                    </Td>
                    <Td dense align="right" numeric className={TONE_CLASS[c.diffTone]}>
                      {c.diffLot}
                    </Td>
                    <Td dense align="right" numeric className={TONE_CLASS[c.diffTone]}>
                      {c.diffBasket}
                    </Td>
                    <Td dense align="right" numeric className="text-muted">
                      {c.control}
                    </Td>
                    <Td dense className="whitespace-nowrap">
                      <span title={c.reason || undefined}>
                        <Badge tone={c.tone}>{c.status}</Badge>
                      </span>
                    </Td>
                  </TRow>
                );
              })}
            </tbody>
          </Table>
          <p className="mt-2 text-xs text-faint">
            Pending means the displaced pick's result or the Dir simulation is not stored yet; it
            fills in after the evening update. Hover a status for the reason.
          </p>
        </div>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 3. Research comparison
// ---------------------------------------------------------------------------

function ResearchCard({ r }: { r: RotationShadowResponse }) {
  const rows = researchRows(r);
  return (
    <Card>
      <CardHeader
        title="What the research found"
        description={`The same override over ${r.research.periods.explore} (the last two years) and ${r.research.periods.confirm}. ₹ on the list's ${r.override.rule.lots_per_strategy} lots per strategy, gross, over the whole window; the controls are the 90th percentile of 200 random draws.`}
      />
      <Table>
        <THead>
          <Th>List</Th>
          <Th align="right">Gain, last 2 years</Th>
          <Th align="right">Time P90</Th>
          <Th align="right">Day P90</Th>
          <Th>Controls</Th>
          <Th align="right">Gain, 2022-24</Th>
          <Th align="right">Time P90</Th>
          <Th align="right">Day P90</Th>
          <Th align="right">Forward so far</Th>
        </THead>
        <tbody>
          {rows.map((row) => (
            <TRow key={row.list} highlighted={row.candidate}>
              <Td dense className="whitespace-nowrap">
                {row.list}
                {row.candidate ? (
                  <Badge tone="primary" className="ml-2">
                    Candidate
                  </Badge>
                ) : null}
              </Td>
              <Td dense align="right" numeric>
                {row.exploreGain}
              </Td>
              <Td dense align="right" numeric className="text-muted">
                {row.exploreTime}
              </Td>
              <Td dense align="right" numeric className="text-muted">
                {row.exploreDay}
              </Td>
              <Td dense className="whitespace-nowrap">
                {row.exploreAbove}
              </Td>
              <Td dense align="right" numeric>
                {row.confirmGain}
              </Td>
              <Td dense align="right" numeric className="text-muted">
                {row.confirmTime}
              </Td>
              <Td dense align="right" numeric className="text-muted">
                {row.confirmDay}
              </Td>
              <Td dense align="right" numeric>
                {row.forward}
              </Td>
            </TRow>
          ))}
        </tbody>
      </Table>
      <p className="mt-3 text-xs text-faint">
        Time P90 and Day P90 are the 90th percentile of the gain over 200 draws of the random-time
        control (the same Dir at a random minute) and the random-day control (the same minute on a
        random day with no event). Controls says whether the gain beat both.
      </p>
      <p className="mt-1 text-xs text-faint">{r.research.applied}</p>
      <p className="mt-1 text-xs text-faint">{r.research.note}</p>
      <p className="mt-1 text-xs text-faint">
        The forward column is the running total over the days scored so far. It is not the same size
        as a two-year figure and says nothing until the judgement point.
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 4. Forward candidates with no scoring yet
// ---------------------------------------------------------------------------

function CandidatesCard({ r }: { r: RotationShadowResponse }) {
  return (
    <Card>
      <CardHeader
        title="Other candidates kept for forward observation"
        description="Two small versions of the hourly-checkpoint study passed every control on the last two years and lost on 2022 to 2024. They are kept for observation only."
      />
      <div className="grid gap-4 lg:grid-cols-2">
        {r.candidates.map((c) => (
          <div key={c.id} className="rounded-lg border border-border bg-surface-2/60 px-4 py-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium text-foreground">{c.title}</p>
              <Badge tone="warning">Not scored</Badge>
            </div>
            <p className="mt-2 text-xs text-muted">{c.definition}</p>
            <dl className="mt-3 space-y-1 text-xs">
              <div className="flex gap-2">
                <dt className="shrink-0 text-faint">Last two years</dt>
                <dd className="text-muted">{c.research.explore}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="shrink-0 text-faint">2022 to 2024</dt>
                <dd className="text-muted">{c.research.confirm}</dd>
              </div>
            </dl>
            <p className="mt-3 text-xs text-muted">{c.reason}</p>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The widget
// ---------------------------------------------------------------------------

export function RotationShadowScoreboard() {
  const res = useRotationShadow();
  const r = res.data;

  return (
    <section aria-label="Shadow scoreboard" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight text-foreground">
            Shadow scoreboard
          </h2>
          <p className="mt-0.5 max-w-3xl text-sm text-muted">
            Ideas kept for forward observation, each against the pick it would have replaced, on
            days the research never saw. Every figure is the idea minus a comparator, gross.
          </p>
        </div>
        <RefreshButton onClick={res.refetch} loading={res.loading} />
      </div>

      {res.error && r === null ? (
        <StateMessage
          variant="error"
          title="Could not load the shadow scoreboard"
          description={
            <span className="flex flex-wrap items-center gap-3">
              {res.error}
              <Button size="sm" onClick={res.refetch}>
                Retry
              </Button>
            </span>
          }
        />
      ) : null}

      {r === null && !res.error ? <SkeletonRows rows={6} /> : null}

      {r !== null ? <Loaded r={r} /> : null}
    </section>
  );
}

function Loaded({ r }: { r: RotationShadowResponse }) {
  const empty = emptyState(r);
  return (
    <div className="space-y-4">
      <Banner r={r} />
      {empty ? (
        <StateMessage variant="empty" title={empty.title} description={empty.description} />
      ) : null}
      <TriggerTable r={r} />
      <OverrideCard r={r} />
      <ResearchCard r={r} />
      <CandidatesCard r={r} />
      <p className="text-xs text-faint">
        {r.journal.error ? `The journal could not be read: ${r.journal.error}. ` : ''}
        Forward window from {formatDay(r.forward_from)}; sessions on or before{' '}
        {formatDay(r.research_end)} were inside the research and are not counted.
      </p>
    </div>
  );
}
