/**
 * The decision half of dispatch.ts, kept free of child processes and network so it
 * can be unit-tested (same split as fyers-auth.ts / fyers.ts).
 */

/**
 * launchd fires a job that was missed during sleep as soon as the laptop wakes, so a
 * wake at 01:00, on a Saturday, or in the evening would otherwise dispatch a run that
 * AlgoTest can only refuse (it accepts broker logins 08:15-15:40 IST on trading days -
 * see main.ts). The window opens a little early because the workflow's own guard waits
 * for 08:16, and closes a few minutes short so the runner still has time to log in.
 */
const FIRST_DISPATCH_MINUTES = 7 * 60 + 45;
const LAST_DISPATCH_MINUTES = 15 * 60 + 35;

export interface IstClock {
  /** 0 = Sunday ... 6 = Saturday, as Date.getDay(). */
  weekday: number;
  minutes: number;
}

export function shouldDispatch({ weekday, minutes }: IstClock): boolean {
  const isWeekday = weekday >= 1 && weekday <= 5;
  return isWeekday && minutes >= FIRST_DISPATCH_MINUTES && minutes <= LAST_DISPATCH_MINUTES;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function istClock(at: Date): IstClock {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  // Some ICU versions render midnight as "24" with hour12: false.
  const hour = Number(part('hour')) % 24;
  return {
    weekday: WEEKDAYS.indexOf(part('weekday')),
    minutes: hour * 60 + Number(part('minute')),
  };
}

export interface WorkflowRun {
  createdAt: string;
  url: string;
}

/**
 * `gh workflow run` exits 0 as soon as GitHub accepts the request and prints no run
 * id, so the only proof a run exists is finding one created after we asked.
 */
export function findRunSince(runs: WorkflowRun[], sinceMs: number): WorkflowRun | null {
  return runs.find((run) => Date.parse(run.createdAt) >= sinceMs) ?? null;
}
