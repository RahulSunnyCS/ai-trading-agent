/**
 * The options collector's source status (GET /api/backtest/legwise/source, BL-079): which recent
 * days came from Angel One because no Fyers login was valid, and what each is missing. The
 * banner under the top bar is built from this; a Fyers login repairs the days on the next run.
 */

export interface SourceDay {
  /** ISO date, YYYY-MM-DD. */
  day: string;
  source: 'fyers' | 'angelone';
  /** One line per underlying with something missing (Angel One days only). */
  lines: string[];
  /** Contracts a repair could not refresh because they had expired. */
  kept_existing: number;
}

export interface SourceStatus {
  days: SourceDay[];
  /** Days that came from Angel One and are not repaired yet. */
  attention: string[];
}

/** The days that need a Fyers login, oldest first. */
export function attentionDays(status: SourceStatus | null): SourceDay[] {
  if (!status) return [];
  const wanted = new Set(status.attention);
  return status.days.filter((d) => wanted.has(d.day)).sort((a, b) => a.day.localeCompare(b.day));
}

/** Short headline for the banner: "Fri 9 Oct" or "3 days (7 Oct to 9 Oct)". */
export function bannerHeadline(days: SourceDay[]): string {
  const first = days[0];
  const last = days[days.length - 1];
  if (!first || !last) return '';
  const fmt = (iso: string) => {
    const [y = 1970, m = 1, d = 1] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    });
  };
  if (days.length === 1) {
    return `Options data for ${fmt(first.day)} came from Angel One, not Fyers`;
  }
  return `Options data for ${days.length} days (${fmt(first.day)} to ${fmt(last.day)}) came from Angel One, not Fyers`;
}
