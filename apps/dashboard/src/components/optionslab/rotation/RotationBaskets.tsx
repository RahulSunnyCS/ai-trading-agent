/**
 * Today's baskets: the four lists side by side. Each pick shows its start time, its family, and
 * its composite score; the dots say how many lists hold the same pick, and the footer says what
 * changed since the entry before (the work list for re-setting AlgoTest).
 *
 * Before the first entry it shows the registered lists and when they start recording.
 */

import { formatDay, formatIstTime } from '../../../lib/format';
import { LIST_KEYS } from '../../../lib/rotationView';
import type {
  RotationBaskets as Baskets,
  RotationBasket,
  RotationListKey,
  RotationListSpec,
  RotationPick,
} from '../../../types/rotation';

const WEIGHT_LABEL: Record<string, string> = {
  recent: 'own',
  weekday: 'weekday',
  dte: 'DTE',
  vix: 'VIX',
  rfam: 'family',
};

function weightsLine(spec: RotationListSpec): string {
  return Object.entries(spec.weights)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${WEIGHT_LABEL[k] ?? k} ${v}`)
    .join(' · ');
}

function Pick({ pick, highlight }: { pick: RotationPick; highlight?: boolean }) {
  return (
    <li
      className={`flex h-7 items-center gap-2 rounded px-1 text-xs ${
        highlight ? 'bg-primary/10' : ''
      }`}
      title={`${pick.index} · ${pick.family} · starts ${pick.start}${
        pick.composite !== null ? ` · composite ${pick.composite}` : ''
      }`}
    >
      <span className="w-10 shrink-0 font-mono text-faint">{pick.start}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-foreground">{pick.name}</span>
      <span className="font-mono text-muted">
        {pick.composite === null ? '' : pick.composite.toFixed(3)}
      </span>
      <span
        className="font-mono text-[10px] tracking-tighter text-faint"
        title={`held by ${pick.shared_by} of 4 lists`}
      >
        {'●'.repeat(pick.shared_by)}
        <span className="opacity-30">{'●'.repeat(4 - pick.shared_by)}</span>
      </span>
    </li>
  );
}

function Basket({ k, basket }: { k: RotationListKey; basket: RotationBasket }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2">
      <div className="mb-1 flex items-center justify-between text-sm font-semibold text-foreground">
        <span>List {k}</span>
        {basket.overridden ? (
          <span
            className="rounded border border-warning/40 px-1.5 py-0.5 text-[10px] font-medium text-warning"
            title="The Widesl minimum replaced a higher-ranked Dir pick"
          >
            Widesl min
          </span>
        ) : null}
      </div>
      <ul>
        {[...basket.core]
          .sort((a, b) => a.start.localeCompare(b.start) || a.name.localeCompare(b.name))
          .map((p) => (
            <Pick key={p.name} pick={p} />
          ))}
      </ul>
      <div className="mt-1 border-t border-dashed border-border pt-1">
        {basket.buy.length > 0 ? (
          <ul>
            {basket.buy.map((p) => (
              <Pick key={p.name} pick={p} />
            ))}
          </ul>
        ) : (
          <p className="flex h-7 items-center text-xs text-faint">No Buy in the top 10</p>
        )}
      </div>
    </div>
  );
}

function Legend() {
  return (
    <p className="text-[11px] text-faint">
      Strategies are in start-time order. <span className="font-mono">●●○○</span> shows how many of
      the four lists hold the same strategy. Hover a row for its index and family.
    </p>
  );
}

export function RotationBaskets({
  baskets,
  specs,
  firstEntryDay,
}: {
  baskets: Baskets;
  specs: Record<RotationListKey, RotationListSpec>;
  firstEntryDay: string;
}) {
  const e = baskets.entry;
  if (!e) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted">
          First entry {formatDay(firstEntryDay)}, 09:16 IST. Each list's three strategies (and a Buy
          add-on when one ranks in the top 10) will appear here, with their scores and what changed
          since the day before. The registered lists:
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {LIST_KEYS.map((k) => (
            <div key={k} className="rounded-lg border border-border bg-surface px-3 py-2">
              <div className="text-sm font-semibold text-foreground">List {k}</div>
              <p className="mt-1 font-mono text-xs text-muted">{weightsLine(specs[k])}</p>
              <p className="mt-1 text-xs text-faint">{specs[k].description}</p>
            </div>
          ))}
        </div>
      </div>
    );
  }
  const changed = LIST_KEYS.filter(
    (k) => (baskets.changed[k]?.added.length ?? 0) + (baskets.changed[k]?.removed.length ?? 0) > 0,
  );
  return (
    <div className="space-y-3">
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        <span className="font-medium text-foreground">
          {e.weekday} {formatDay(e.day)}
        </span>
        <span>
          VIX {e.vix_open} ({e.vix_band})
        </span>
        <span>
          DTE NIFTY {e.dte.NIFTY} / SENSEX {e.dte.SENSEX}
        </span>
        <span>
          recorded {formatIstTime(e.recorded_at, { seconds: true })} IST{' '}
          {e.on_time ? '' : '· LATE, not a forward entry'}
        </span>
        <span className="font-mono">chain {e.hash.slice(0, 8)}</span>
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {LIST_KEYS.map((k) => {
          const b = baskets.lists[k];
          return b ? <Basket key={k} k={k} basket={b} /> : null;
        })}
      </div>
      <Legend />
      <div className="space-y-1 text-xs text-muted">
        <div className="font-medium text-foreground">Changed since the entry before</div>
        {changed.length === 0 ? (
          <p>Nothing.</p>
        ) : (
          changed.map((k) => {
            const c = baskets.changed[k];
            return (
              <div key={k} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="w-9 shrink-0 font-medium text-foreground">{k}</span>
                {c?.removed.map((n) => (
                  <span key={`r-${n}`} className="font-mono text-negative">
                    −{n}
                  </span>
                ))}
                {c?.added.map((n) => (
                  <span key={`a-${n}`} className="font-mono text-positive">
                    +{n}
                  </span>
                ))}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
