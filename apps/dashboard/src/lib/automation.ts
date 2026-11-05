import { formatInr } from './format';

/**
 * Shapes, labels and small rules for the automation settings (BL-140), served by the
 * scheduler at `/api/scheduler/settings/automation` (apps/scheduler/src/automation.ts holds the
 * same shapes and the validation). Kept free of React so it can be unit-tested.
 */

export type List = 'none' | 'core' | 't1';
export type RowKey =
  | 'algotest.finvasia'
  | 'algotest.angelone'
  | 'quantiply.angelone'
  | 'quantiply.finvasia';

/** The platform multiplier a row may run at: a whole number in this range. */
export const MULTIPLIER_MIN = 1;
export const MULTIPLIER_MAX = 10;

/** The broker accounts that have a capital figure. */
export type Broker = 'finvasia' | 'angelone';
export const BROKERS: { key: Broker; label: string }[] = [
  { key: 'angelone', label: 'Angel One' },
  { key: 'finvasia', label: 'Shoonya' },
];

/** The capital an account may be given (whole rupees in this range) and what it reads as when the
 * scheduler predates the field. Same rule as the scheduler's. */
export const CAPITAL_MIN = 10_000;
export const CAPITAL_MAX = 100_000_000;
export const DEFAULT_CAPITAL = 850_000;

/** The evening message's margin block (BL-205): its buffer (percent) and how many days of each
 * day type it looks back over. Same ranges and defaults as the scheduler's. */
export const MARGIN_BUFFER_MIN = 0;
export const MARGIN_BUFFER_MAX = 50;
export const MARGIN_DAYS_MIN = 1;
export const MARGIN_DAYS_MAX = 30;
export const DEFAULT_MARGIN: Margin = { bufferPct: 10, days: 6 };

/** The Quantiply clientwise MTM SL a row may ask for (BL-172): whole rupees in this range. */
export const MTM_SL_MIN = 500;
export const MTM_SL_MAX = 100_000;

/**
 * What a row's MTM SL reads as when the scheduler predates the field: the list's portfolio stop on
 * a Quantiply row (Adaptive Tuned ₹9,000, Adaptive Classic ₹8,000), none on AlgoTest. Same rule as
 * the scheduler's `defaultMtmSl`.
 */
export function defaultMtmSl(key: RowKey, list: List | undefined): number | null {
  if (!key.startsWith('quantiply.')) return null;
  return list === 't1' ? 9000 : list === 'core' ? 8000 : null;
}

export interface Row {
  login: boolean;
  list: List;
  upload: boolean;
  /** the platform multiplier (Quantiply's algo multiplier, AlgoTest's deploy-sheet multiplier) */
  multiplier: number;
  /** include the Buy add-on picks */
  addon: boolean;
  /** BL-183: the picked Dir at 2 lots (its MTM SL doubled) on a non-expiry day */
  dirBoost: boolean;
  /** Quantiply only: the clientwise MTM SL (rupees) kept each morning at 08:00; null = leave it */
  mtmSl: number | null;
}

export interface Pause {
  /** no uploads or deploys for any session up to and including this IST day; null = none */
  until: string | null;
}

export interface Masters {
  logins: boolean;
  uploads: boolean;
  deploy: boolean;
}

export interface Margin {
  bufferPct: number;
  days: number;
}

/** BL-211: day-type rules. The most a version may hold, and what a rule can be written on. */
export const MAX_RULES = 20;
export const INDICES = ['NIFTY', 'SENSEX'] as const;
/** Weekdays to the nearest expiry as the rotation labels them (BL-109). */
export const DTE_LABELS = ['0', '1', '2', '3', '4', '5', '6', '7+'] as const;
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] as const;
export type Index = (typeof INDICES)[number];
export type Weekday = (typeof WEEKDAYS)[number];

export type RuleWhen =
  | { kind: 'dte'; index: Index; dte: (typeof DTE_LABELS)[number] }
  | { kind: 'weekday'; weekday: Weekday };

/** On a day where `when` holds, `row` trades `list` instead of its own. */
export interface DayRule {
  row: RowKey;
  when: RuleWhen;
  list: List;
  note?: string;
}

/** A session's day type (`GET /legwise/rotation/day-type`, rotation/day_type.py). */
export interface DayType {
  day: string;
  weekday: string;
  dte: Record<Index, string>;
  source: string;
}

export interface DayTypes {
  today: DayType | null;
  tomorrow: DayType | null;
  errors: string[];
}

export interface AutomationSettings {
  masters: Masters;
  rows: Record<RowKey, Row>;
  pause: Pause;
  /** BL-211: day-type rules, tried in order, the first that matches a row wins */
  rules: DayRule[];
  /** rupees in each broker account, for the evening result message's capital lines */
  capital: Record<Broker, number>;
  /** the evening result message's margin block (BL-205) */
  margin: Margin;
  /** BL-209: T1 split across the two AlgoTest accounts (effective while both upload T1) */
  splitT1: boolean;
}

export interface SettingsVersion {
  version: number;
  saved_at: string;
  settings: AutomationSettings;
  github: string | null;
}

export interface AutomationView {
  current: SettingsVersion;
  effective: Record<RowKey, Row>;
  github: Record<string, string>;
  history: SettingsVersion[];
  /** the first session an upload or deploy would change (today before 09:21 IST, else the next trading day) */
  next_session?: string;
}

/**
 * Settings from a scheduler that predates the multiplier, add-on and pause have none of them:
 * 1, yes and no pause, what the jobs did; before BL-183 no Dir ×2 (off); before 2026-10-29 no
 * capital (₹8.5 lakh an account); before BL-205 no margin block settings (a 10% buffer over 6
 * days); before BL-209 no T1 split (off); before BL-211 no day-type rules. Applied to everything read, so the page never meets a
 * missing field.
 */
export function withDefaults(settings: AutomationSettings): AutomationSettings {
  const rows = Object.fromEntries(
    Object.entries(settings.rows).map(([key, row]) => [
      key,
      {
        ...row,
        multiplier: row.multiplier ?? 1,
        addon: row.addon ?? true,
        dirBoost: row.dirBoost ?? false,
        mtmSl: row.mtmSl === undefined ? defaultMtmSl(key as RowKey, row.list) : row.mtmSl,
      },
    ]),
  ) as Record<RowKey, Row>;
  const capital = Object.fromEntries(
    BROKERS.map(({ key }) => [key, settings.capital?.[key] ?? DEFAULT_CAPITAL]),
  ) as Record<Broker, number>;
  const margin = {
    bufferPct: settings.margin?.bufferPct ?? DEFAULT_MARGIN.bufferPct,
    days: settings.margin?.days ?? DEFAULT_MARGIN.days,
  };
  return {
    ...settings,
    rows,
    pause: { until: settings.pause?.until ?? null },
    rules: settings.rules ?? [],
    capital,
    margin,
    splitT1: settings.splitT1 ?? false,
  };
}

/**
 * BL-209: whether the T1 split changes the export: the switch on, uploads on and both AlgoTest
 * rows uploading T1 (the Python export's `split_t1`).
 */
export function splitApplies(settings: AutomationSettings): boolean {
  return (
    settings.splitT1 &&
    settings.masters.uploads &&
    BROKERS.every(({ key }) => {
      const row = settings.rows[`algotest.${key}` as RowKey];
      return row.upload && row.list === 't1';
    })
  );
}

/** `settings` with the margin block's buffer or look-back changed. */
export function withMargin(
  settings: AutomationSettings,
  change: Partial<Margin>,
): AutomationSettings {
  return { ...settings, margin: { ...settings.margin, ...change } };
}

/** `settings` with one account's capital changed. */
export function withCapital(
  settings: AutomationSettings,
  broker: Broker,
  rupees: number,
): AutomationSettings {
  return { ...settings, capital: { ...settings.capital, [broker]: rupees } };
}

/** Every account's capital added up (the evening message's total). */
export function totalCapital(settings: AutomationSettings): number {
  return BROKERS.reduce((sum, { key }) => sum + settings.capital[key], 0);
}

/** The view with its settings (current and history) filled in by `withDefaults`. */
export function withViewDefaults(view: AutomationView): AutomationView {
  const version = (v: SettingsVersion): SettingsVersion => ({
    ...v,
    settings: withDefaults(v.settings),
  });
  return { ...view, current: version(view.current), history: view.history.map(version) };
}

/** `settings` with the pause's last day changed (null clears it). */
export function withPause(settings: AutomationSettings, until: string | null): AutomationSettings {
  return { ...settings, pause: { until } };
}

/** The page's row order: AlgoTest first, each platform's usual broker first. */
export const ROWS: { key: RowKey; platform: string; broker: string }[] = [
  { key: 'algotest.finvasia', platform: 'AlgoTest', broker: 'Shoonya' },
  { key: 'algotest.angelone', platform: 'AlgoTest', broker: 'Angel One' },
  { key: 'quantiply.angelone', platform: 'Quantiply', broker: 'Angel One' },
  { key: 'quantiply.finvasia', platform: 'Quantiply', broker: 'Shoonya' },
];

export const LIST_LABEL: Record<List, string> = {
  none: 'None',
  core: 'Adaptive Classic',
  t1: 'Adaptive Tuned',
};

export const MASTER_LABEL: Record<keyof Masters, string> = {
  logins: 'Automated logins',
  uploads: 'Automated uploads',
  deploy: 'Automated deployment',
};

export function rowLabel(key: RowKey): string {
  const row = ROWS.find((r) => r.key === key);
  return row ? `${row.platform} · ${row.broker}` : key;
}

/** `settings` with one row changed; choosing no list also turns its upload off. */
export function withRow(
  settings: AutomationSettings,
  key: RowKey,
  change: Partial<Row>,
): AutomationSettings {
  const row = { ...settings.rows[key], ...change };
  if (row.list === 'none') row.upload = false;
  return { ...settings, rows: { ...settings.rows, [key]: row } };
}

export function withMaster(
  settings: AutomationSettings,
  key: keyof Masters,
  on: boolean,
): AutomationSettings {
  return { ...settings, masters: { ...settings.masters, [key]: on } };
}

/** The rule a new "Add a rule" starts from: the owner's first case. */
export const NEW_RULE: DayRule = {
  row: 'algotest.finvasia',
  when: { kind: 'dte', index: 'SENSEX', dte: '0' },
  list: 'core',
};

export function withRules(settings: AutomationSettings, rules: DayRule[]): AutomationSettings {
  return { ...settings, rules };
}

export function addRule(settings: AutomationSettings): AutomationSettings {
  if (settings.rules.length >= MAX_RULES) return settings;
  return withRules(settings, [...settings.rules, { ...NEW_RULE, when: { ...NEW_RULE.when } }]);
}

export function updateRule(
  settings: AutomationSettings,
  index: number,
  change: Partial<DayRule>,
): AutomationSettings {
  return withRules(
    settings,
    settings.rules.map((r, i) => {
      if (i !== index) return r;
      // an emptied note is no note, so equal rules serialise the same
      const { note, ...rest } = { ...r, ...change };
      return note ? { ...rest, note } : rest;
    }),
  );
}

export function removeRule(settings: AutomationSettings, index: number): AutomationSettings {
  return withRules(
    settings,
    settings.rules.filter((_, i) => i !== index),
  );
}

/** Move a rule one place up (-1) or down (+1); the order is the order they are tried in. */
export function moveRule(
  settings: AutomationSettings,
  index: number,
  by: -1 | 1,
): AutomationSettings {
  const to = index + by;
  if (to < 0 || to >= settings.rules.length) return settings;
  const rules = [...settings.rules];
  const [moved] = rules.splice(index, 1);
  if (moved) rules.splice(to, 0, moved);
  return withRules(settings, rules);
}

/** Switch a rule's condition kind, starting the new kind from its first value. */
export function ruleWhenOfKind(kind: RuleWhen['kind']): RuleWhen {
  return kind === 'dte'
    ? { kind: 'dte', index: 'SENSEX', dte: '0' }
    : { kind: 'weekday', weekday: 'Fri' };
}

const sameWhen = (a: RuleWhen, b: RuleWhen): boolean =>
  a.kind === 'dte' && b.kind === 'dte'
    ? a.index === b.index && a.dte === b.dte
    : a.kind === 'weekday' && b.kind === 'weekday' && a.weekday === b.weekday;

/** Why the rules cannot be saved (the scheduler refuses the same); empty when they can. */
export function rulesProblems(rules: DayRule[]): string[] {
  const out: string[] = [];
  if (rules.length > MAX_RULES) out.push(`At most ${MAX_RULES} rules.`);
  rules.forEach((rule, i) => {
    const first = rules.findIndex((e) => e.row === rule.row && sameWhen(e.when, rule.when));
    if (first >= 0 && first < i)
      out.push(
        `Rule ${i + 1} can never apply: rule ${first + 1} tests the same thing on the same row and is tried first.`,
      );
  });
  return out;
}

/** The condition in words: "SENSEX has 0 weekdays to expiry", "it is a Friday". */
export function whenText(when: RuleWhen): string {
  if (when.kind === 'weekday') return `it is a ${WEEKDAY_NAME[when.weekday]}`;
  const n = when.dte;
  return `${when.index} has ${n} weekday${n === '1' ? '' : 's'} to expiry`;
}

const WEEKDAY_NAME: Record<Weekday, string> = {
  Mon: 'Monday',
  Tue: 'Tuesday',
  Wed: 'Wednesday',
  Thu: 'Thursday',
  Fri: 'Friday',
};

/** A rule on one line, as the save summary says it: "AlgoTest · Shoonya on SENSEX 0 DTE → Adaptive Classic". */
export function ruleText(rule: DayRule): string {
  const when =
    rule.when.kind === 'dte' ? `${rule.when.index} ${rule.when.dte} DTE` : rule.when.weekday;
  return `${rowLabel(rule.row)} on ${when} → ${LIST_LABEL[rule.list]}`;
}

/** The rule as a sentence under it, against the row's own list in `settings`. */
export function ruleSentence(rule: DayRule, settings: AutomationSettings): string {
  const own = LIST_LABEL[settings.rows[rule.row].list];
  const trades = rule.list === 'none' ? 'trades nothing' : `trades ${LIST_LABEL[rule.list]}`;
  return `On a day ${whenText(rule.when)}, ${rowLabel(rule.row)} ${trades} instead of its own list (${own}).`;
}

/** What one row trades on a session: its list, the rule that decided it, or why that is unknown. */
export interface ResolvedRow {
  list: List;
  /** the deciding rule's number (1-based), or null when the row's own list stands */
  rule: number | null;
  /** set when a rule needed a days-to-expiry label that is not known */
  unknown?: string;
}

/**
 * The same as the jobs' resolvers (Python `automation_settings.resolve`, broker-login
 * `resolveAutomation`; one shared fixture tests all three): each row's list is the first matching
 * rule's, else its own. A rule on a label that is not known cannot be decided; that row is marked
 * `unknown` and keeps its own list.
 */
export function resolveRows(
  settings: AutomationSettings,
  dayType: DayType,
): Record<RowKey, ResolvedRow> {
  const out = {} as Record<RowKey, ResolvedRow>;
  for (const { key } of ROWS) {
    const own = settings.rows[key].list;
    out[key] = { list: own, rule: null };
    for (const [i, rule] of settings.rules.entries()) {
      if (rule.row !== key) continue;
      if (rule.when.kind === 'weekday') {
        if (dayType.weekday !== rule.when.weekday) continue;
      } else {
        const label = String(dayType.dte[rule.when.index] ?? 'unknown');
        if (!(DTE_LABELS as readonly string[]).includes(label)) {
          out[key] = {
            list: own,
            rule: null,
            unknown: `${rule.when.index} days to expiry not known`,
          };
          break;
        }
        if (label !== rule.when.dte) continue;
      }
      out[key] = { list: rule.list, rule: i + 1 };
      break;
    }
  }
  return out;
}

const onOff = (v: boolean) => (v ? 'on' : 'off');

/** Plain-English lines for what differs between two versions, in page order. */
export function describeChanges(before: AutomationSettings, after: AutomationSettings): string[] {
  const lines: string[] = [];
  for (const key of ['logins', 'uploads', 'deploy'] as const) {
    if (before.masters[key] !== after.masters[key]) {
      lines.push(
        `${MASTER_LABEL[key]}: ${onOff(before.masters[key])} → ${onOff(after.masters[key])}`,
      );
    }
  }
  for (const { key } of ROWS) {
    const a = before.rows[key];
    const b = after.rows[key];
    if (a.login !== b.login)
      lines.push(`${rowLabel(key)} login: ${onOff(a.login)} → ${onOff(b.login)}`);
    if (a.list !== b.list)
      lines.push(`${rowLabel(key)} list: ${LIST_LABEL[a.list]} → ${LIST_LABEL[b.list]}`);
    if (a.upload !== b.upload)
      lines.push(`${rowLabel(key)} upload: ${onOff(a.upload)} → ${onOff(b.upload)}`);
    if (a.multiplier !== b.multiplier)
      lines.push(`${rowLabel(key)} multiplier: ${a.multiplier} → ${b.multiplier}`);
    if (a.addon !== b.addon)
      lines.push(`${rowLabel(key)} Buy add-on: ${onOff(a.addon)} → ${onOff(b.addon)}`);
    if (a.dirBoost !== b.dirBoost)
      lines.push(`${rowLabel(key)} Dir ×2: ${onOff(a.dirBoost)} → ${onOff(b.dirBoost)}`);
    if (a.mtmSl !== b.mtmSl)
      lines.push(`${rowLabel(key)} MTM SL: ${mtmSlText(a.mtmSl)} → ${mtmSlText(b.mtmSl)}`);
  }
  for (const { key, label } of BROKERS) {
    if (before.capital[key] !== after.capital[key])
      lines.push(
        `${label} capital: ${formatInr(before.capital[key])} → ${formatInr(after.capital[key])}`,
      );
  }
  if (before.margin.bufferPct !== after.margin.bufferPct)
    lines.push(`Margin buffer: ${before.margin.bufferPct}% → ${after.margin.bufferPct}%`);
  if (before.margin.days !== after.margin.days)
    lines.push(`Margin look-back: ${before.margin.days} → ${after.margin.days} days of a type`);
  lines.push(...describeRuleChanges(before.rules, after.rules));
  if (before.splitT1 !== after.splitT1)
    lines.push(
      `T1 split across the AlgoTest accounts: ${onOff(before.splitT1)} → ${onOff(after.splitT1)}`,
    );
  if (before.pause.until !== after.pause.until) {
    lines.push(
      `Pause: ${before.pause.until ? `until ${before.pause.until}` : 'none'} → ${after.pause.until ? `until ${after.pause.until}` : 'none'}`,
    );
  }
  return lines;
}

const ruleLine = (r: DayRule) => `${ruleText(r)}${r.note ? ` (${r.note})` : ''}`;

/** Rules added, removed, or just reordered, in plain words. */
function describeRuleChanges(before: DayRule[], after: DayRule[]): string[] {
  const b = before.map(ruleLine);
  const a = after.map(ruleLine);
  const left = [...b];
  const added: string[] = [];
  for (const line of a) {
    const at = left.indexOf(line);
    if (at >= 0) left.splice(at, 1);
    else added.push(line);
  }
  const lines = [...left.map((x) => `Rule removed: ${x}`), ...added.map((x) => `Rule added: ${x}`)];
  if (!lines.length && b.join('\n') !== a.join('\n')) lines.push('Rules reordered');
  return lines;
}

function mtmSlText(value: number | null): string {
  return value === null ? 'not managed' : formatInr(value);
}

/** Why a row will not do what it says: its master switch is off. Null when nothing is held back. */
export function heldByMaster(settings: AutomationSettings, key: RowKey): string | null {
  const row = settings.rows[key];
  const held: string[] = [];
  if (row.login && !settings.masters.logins) held.push('login');
  if (row.upload && !settings.masters.uploads) held.push('upload');
  return held.length ? `${held.join(' and ')} held off by the master switch` : null;
}

/** The GitHub sync outcome in a few words, and whether it failed. */
export function githubOutcome(github: string | null): { text: string; failed: boolean } | null {
  if (!github) return null;
  if (github.startsWith('ok')) return { text: 'GitHub backstop updated', failed: false };
  if (github.startsWith('PARTIAL')) {
    return {
      text: `GitHub backstop partly updated: ${github.replace(/^PARTIAL:\s*/, '')}`,
      failed: true,
    };
  }
  return { text: `GitHub backstop NOT updated: ${github.replace(/^FAILED\s*/, '')}`, failed: true };
}

/**
 * Apply now runs a platform's evening upload, which replaces today's strategies with tomorrow's:
 * only once today's session is over (15:30 IST), when none of today's picks can still trade. The
 * uploaders refuse earlier anyway; the page says so instead of starting a run that fails.
 */
export function applyNowOpen(now: Date = new Date()): boolean {
  const ist = new Date(now.getTime() + 330 * 60_000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes() >= 15 * 60 + 30;
}
