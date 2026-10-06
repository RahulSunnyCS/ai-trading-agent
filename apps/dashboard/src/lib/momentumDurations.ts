/**
 * How long a Momentum backtest of each dataset usually takes, remembered in this browser so the
 * run banner can say "usually about 20 s" (BL-005 Phase 4). The last few real computations per
 * dataset are kept and the middle one is shown. A run served from the server's result cache says
 * nothing about how long a real one takes, so it is not recorded.
 */

const STORAGE_KEY = 'ata-momentum-durations';
const KEEP = 5;

type Store = Record<string, number[]>;

function read(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Store) : {};
  } catch {
    return {}; // storage blocked or corrupt: no memory, never an error
  }
}

function write(store: Store): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // nothing to do: the next run just starts without a remembered duration
  }
}

/** Remember how long one computation of `dataset` took, in milliseconds. */
export function recordDuration(dataset: string, ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) return;
  const store = read();
  store[dataset] = [...(store[dataset] ?? []), ms].slice(-KEEP);
  write(store);
}

/** The median of the remembered durations for `dataset`, or null when there are none. */
export function usualDuration(dataset: string): number | null {
  const kept = (read()[dataset] ?? []).filter((ms) => Number.isFinite(ms) && ms > 0);
  if (kept.length === 0) return null;
  const sorted = [...kept].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/** "about 20 s" / "about 1 min 5 s", for a banner. */
export function describeDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `about ${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `about ${minutes} min` : `about ${minutes} min ${rest} s`;
}
