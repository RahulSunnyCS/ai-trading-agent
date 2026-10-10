/**
 * The Guide's table of contents (BL-041): every chapter and page, in reading order. It drives
 * the Guide's own index, previous/next, the filter box, and the "How this works" link on each
 * documented screen (`guidePageForScreen`).
 *
 * A page's text is a Markdown file under ./content, imported as a string (`?raw`, see
 * next.config.ts). Inside it, three link forms are understood by GuideMarkdown:
 *   [text](app:/momentum/backtest)       opens a dashboard screen
 *   [text](guide:momentum/journal)       opens another guide page
 *   [text](glossary:cagr)                a term with its definition on hover
 * A test checks that every one of them resolves.
 *
 * When a screen's controls or numbers change, update its page here in the same commit.
 */

import type { Tab } from '../components/shell/nav';
import { buildPath } from '../lib/routes';

import glossaryIntro from './content/glossary/terms.md?raw';
import momentumBacktestResults from './content/momentum/backtest-results.md?raw';
import momentumBacktestSettings from './content/momentum/backtest-settings.md?raw';
import momentumHowItWorks from './content/momentum/how-it-works.md?raw';
import momentumJournal from './content/momentum/journal.md?raw';
import momentumRebalance from './content/momentum/rebalance.md?raw';
import momentumSavedRuns from './content/momentum/saved-runs.md?raw';
import momentumScores from './content/momentum/scores.md?raw';
import momentumThisWeek from './content/momentum/this-week.md?raw';
import momentumFirstBacktest from './content/momentum/walkthrough-first-backtest.md?raw';
import momentumReadSignal from './content/momentum/walkthrough-weekly-signal.md?raw';
import opsBrokerLogins from './content/operations/broker-logins.md?raw';
import opsCoverage from './content/operations/coverage.md?raw';
import opsJobs from './content/operations/jobs.md?raw';
import opsOverview from './content/operations/overview.md?raw';
import opsSettings from './content/operations/settings.md?raw';
import optionsBuilderForm from './content/optionslab/builder-form.md?raw';
import optionsBuilderYaml from './content/optionslab/builder-yaml.md?raw';
import optionsCorrelation from './content/optionslab/correlation.md?raw';
import optionsDailyResults from './content/optionslab/daily-results.md?raw';
import optionsHowItWorks from './content/optionslab/how-it-works.md?raw';
import optionsRegimes from './content/optionslab/regimes.md?raw';
import optionsRotationDailyLog from './content/optionslab/rotation-daily-log.md?raw';
import optionsRotationExplain from './content/optionslab/rotation-explain.md?raw';
import optionsRotationMatrix from './content/optionslab/rotation-matrix.md?raw';
import optionsRotationPulse from './content/optionslab/rotation-pulse.md?raw';
import optionsRotationShadow from './content/optionslab/rotation-shadow.md?raw';
import optionsRotation from './content/optionslab/rotation.md?raw';
import optionsRuns from './content/optionslab/runs.md?raw';
import optionsStrategies from './content/optionslab/strategies.md?raw';
import optionsLosingDays from './content/optionslab/walkthrough-losing-days.md?raw';
import optionsShortStraddle from './content/optionslab/walkthrough-short-straddle.md?raw';
import startAlerts from './content/start/alerts.md?raw';
import startDailyRoutine from './content/start/daily-routine.md?raw';
import startLimits from './content/start/limits.md?raw';
import startTour from './content/start/tour.md?raw';
import startWelcome from './content/start/welcome.md?raw';

/** Must match the Guide nav item's children, in order (a test checks it). */
export const GUIDE_CHAPTERS = [
  { id: 'start', title: 'Start here' },
  { id: 'momentum', title: 'Momentum' },
  { id: 'optionslab', title: 'Options Lab' },
  { id: 'operations', title: 'Data & operations' },
  { id: 'glossary', title: 'Glossary' },
] as const;

export type GuideChapterId = (typeof GUIDE_CHAPTERS)[number]['id'];

/** What kind of page it is; shown as a small label so a reader knows what to expect. */
export type GuidePageKind = 'Introduction' | 'Explainer' | 'Screen' | 'Walkthrough' | 'Reference';

export interface GuidePage {
  chapter: GuideChapterId;
  slug: string;
  title: string;
  /** One sentence; shown in the index and matched by the filter box. */
  summary: string;
  kind: GuidePageKind;
  body: string;
  /** The dashboard screen this page documents: its tab and the segments after it. */
  screen?: { tab: Tab; rest?: string[] };
  /** Show the shared "not advice, no live orders" notice above the page. */
  disclaimer?: boolean;
}

export const GUIDE_PAGES: readonly GuidePage[] = [
  // ---- Start here ----------------------------------------------------------------------
  {
    chapter: 'start',
    slug: 'welcome',
    title: 'Welcome',
    summary: 'What this workbench is, what it is not, and how the Guide is organised.',
    kind: 'Introduction',
    body: startWelcome,
    disclaimer: true,
  },
  {
    chapter: 'start',
    slug: 'tour',
    title: 'A tour of the screens',
    summary: 'One paragraph on every screen in the sidebar, with a link to open it.',
    kind: 'Introduction',
    body: startTour,
  },
  {
    chapter: 'start',
    slug: 'daily-routine',
    title: 'A day and a week',
    summary: 'What runs on its own each trading day and each Friday, and when to look.',
    kind: 'Introduction',
    body: startDailyRoutine,
  },
  {
    chapter: 'start',
    slug: 'alerts',
    title: 'Alerts: the bell and the pop-up',
    summary:
      'What the bell in the top bar and the once-a-day pop-up tell you, and what clears them.',
    kind: 'Introduction',
    body: startAlerts,
  },
  {
    chapter: 'start',
    slug: 'limits',
    title: 'Limits & caveats',
    summary: 'What a backtest here can and cannot tell you. Read this before trusting any number.',
    kind: 'Introduction',
    body: startLimits,
    disclaimer: true,
  },

  // ---- Momentum ------------------------------------------------------------------------
  {
    chapter: 'momentum',
    slug: 'how-it-works',
    title: 'How weekly momentum rotation works',
    summary: 'Rank by past returns, hold the leaders, sell the laggards: the idea in one page.',
    kind: 'Explainer',
    body: momentumHowItWorks,
  },
  {
    chapter: 'momentum',
    slug: 'backtest-settings',
    title: 'Backtest: the settings',
    summary: 'Every group of settings on the Backtest screen, what it does and where to start.',
    kind: 'Screen',
    body: momentumBacktestSettings,
    screen: { tab: 'momentum', rest: ['backtest'] },
  },
  {
    chapter: 'momentum',
    slug: 'backtest-results',
    title: 'Backtest: reading the results',
    summary:
      'The headline cards, the equity chart and the sections below it, and what good looks like.',
    kind: 'Screen',
    body: momentumBacktestResults,
    screen: { tab: 'momentum', rest: ['backtest'] },
  },
  {
    chapter: 'momentum',
    slug: 'scores',
    title: 'Momentum Scores',
    summary: "Today's momentum of every stock and sector, as a 0–100 score per lookback.",
    kind: 'Screen',
    body: momentumScores,
    screen: { tab: 'momentum', rest: ['scores'] },
  },
  {
    chapter: 'momentum',
    slug: 'saved-runs',
    title: 'Saved runs & favourites',
    summary:
      'Every backtest you ran, how to compare them, and how a run becomes the Friday signal.',
    kind: 'Screen',
    body: momentumSavedRuns,
    screen: { tab: 'momentum', rest: ['saved'] },
  },
  {
    chapter: 'momentum',
    slug: 'this-week',
    title: 'This week',
    summary:
      "Friday's signal for every favourite: the day's steps, your rules, what needs you, split reviews.",
    kind: 'Screen',
    body: momentumThisWeek,
    screen: { tab: 'momentum', rest: ['week'] },
  },
  {
    chapter: 'momentum',
    slug: 'rebalance',
    title: 'Rebalance preview',
    summary:
      'Compare what you actually hold with what the model holds, and see the trades to match.',
    kind: 'Screen',
    body: momentumRebalance,
    screen: { tab: 'momentum', rest: ['rebalance'] },
  },
  {
    chapter: 'momentum',
    slug: 'journal',
    title: 'Journal',
    summary: 'The permanent, tamper-checked record of every weekly signal as it was sent.',
    kind: 'Screen',
    body: momentumJournal,
    screen: { tab: 'momentum', rest: ['journal'] },
  },
  {
    chapter: 'momentum',
    slug: 'walkthrough-first-backtest',
    title: 'Walkthrough: your first momentum backtest',
    summary: 'Run the default ETF Rotation strategy, change one setting, and compare the two.',
    kind: 'Walkthrough',
    body: momentumFirstBacktest,
  },
  {
    chapter: 'momentum',
    slug: 'walkthrough-weekly-signal',
    title: "Walkthrough: read this week's signal",
    summary: "From Friday's Telegram message to a rebalanced portfolio, step by step.",
    kind: 'Walkthrough',
    body: momentumReadSignal,
    disclaimer: true,
  },

  // ---- Options Lab ---------------------------------------------------------------------
  {
    chapter: 'optionslab',
    slug: 'how-it-works',
    title: 'How a leg-wise options backtest works',
    summary: 'Legs, strikes, stops, re-entries and costs, minute by minute over real data.',
    kind: 'Explainer',
    body: optionsHowItWorks,
  },
  {
    chapter: 'optionslab',
    slug: 'strategies',
    title: 'Strategies',
    summary: 'The saved strategies the evening run tests every trading day.',
    kind: 'Screen',
    body: optionsStrategies,
    screen: { tab: 'optionslab', rest: ['strategies'] },
  },
  {
    chapter: 'optionslab',
    slug: 'builder-form',
    title: 'Builder: Form mode',
    summary: 'Build a strategy leg by leg, backtest it over a date range, and save it.',
    kind: 'Screen',
    body: optionsBuilderForm,
    screen: { tab: 'optionslab', rest: ['builder'] },
  },
  {
    chapter: 'optionslab',
    slug: 'builder-yaml',
    title: 'Builder: YAML mode',
    summary:
      'The older rule engine, where a strategy is written as text rather than built in a form.',
    kind: 'Screen',
    body: optionsBuilderYaml,
    screen: { tab: 'optionslab', rest: ['builder', 'yaml'] },
  },
  {
    chapter: 'optionslab',
    slug: 'runs',
    title: 'Runs',
    summary: 'Every backtest run in one list, and a side-by-side comparison of two.',
    kind: 'Screen',
    body: optionsRuns,
    screen: { tab: 'optionslab', rest: ['runs'] },
  },
  {
    chapter: 'optionslab',
    slug: 'daily-results',
    title: 'Daily results',
    summary: 'How each saved strategy did on every collected day, with a minute-by-minute replay.',
    kind: 'Screen',
    body: optionsDailyResults,
    screen: { tab: 'optionslab', rest: ['results'] },
  },
  {
    chapter: 'optionslab',
    slug: 'regimes',
    title: 'Regimes',
    summary: 'Label each day Quiet, Chop or Trend, and see whether those labels persist.',
    kind: 'Screen',
    body: optionsRegimes,
    screen: { tab: 'optionslab', rest: ['regimes'] },
  },
  {
    chapter: 'optionslab',
    slug: 'correlation',
    title: 'Correlation',
    summary: 'Which strategies lose on the same days, and a basket whose parts are not alike.',
    kind: 'Screen',
    body: optionsCorrelation,
    screen: { tab: 'optionslab', rest: ['correlation'] },
  },
  {
    chapter: 'optionslab',
    slug: 'rotation',
    title: 'Rotation',
    summary:
      'The four forward lists against REF, the fixed base and random baskets, and today’s picks.',
    kind: 'Screen',
    body: optionsRotation,
    screen: { tab: 'optionslab', rest: ['rotation'] },
  },
  {
    // The two explain widgets of the Rotation page. After the page's own entry, so that one stays
    // the first match for the screen (`guidePageForScreen` keeps the first of equal depth).
    chapter: 'optionslab',
    slug: 'rotation-explain',
    title: 'Rotation: why a pick, and does rank predict results',
    summary:
      'Why each list picked what it did, criterion by criterion, and whether the morning ranking orders the day.',
    kind: 'Screen',
    body: optionsRotationExplain,
    screen: { tab: 'optionslab', rest: ['rotation'] },
  },
  {
    chapter: 'optionslab',
    slug: 'rotation-shadow',
    title: 'Rotation: Shadow scoreboard',
    summary: 'Ideas kept for forward observation, each against the pick it would have replaced.',
    kind: 'Screen',
    body: optionsRotationShadow,
    screen: { tab: 'optionslab', rest: ['rotation'] },
  },
  {
    chapter: 'optionslab',
    slug: 'rotation-pulse',
    title: 'Rotation: the Family pulse',
    summary:
      'Is morning short-premium working right now: the twelve family-band cells, what the ranking sees, where the picks fall.',
    kind: 'Screen',
    body: optionsRotationPulse,
    screen: { tab: 'optionslab', rest: ['rotation'] },
  },
  {
    chapter: 'optionslab',
    slug: 'rotation-daily-log',
    title: 'Rotation: the daily log',
    summary:
      'What each list picked at 09:16 and what those picks did, day by day, with what you placed.',
    kind: 'Screen',
    body: optionsRotationDailyLog,
    screen: { tab: 'optionslab', rest: ['rotation'] },
  },
  {
    chapter: 'optionslab',
    slug: 'rotation-matrix',
    title: 'Matrix',
    summary: 'Where the rotation variants make or lose money by start time, date and condition.',
    kind: 'Screen',
    body: optionsRotationMatrix,
    screen: { tab: 'optionslab', rest: ['matrix'] },
  },
  {
    chapter: 'optionslab',
    slug: 'walkthrough-short-straddle',
    title: 'Walkthrough: build and backtest a short straddle',
    summary: 'From the template to a saved strategy the evening run will track.',
    kind: 'Walkthrough',
    body: optionsShortStraddle,
  },
  {
    chapter: 'optionslab',
    slug: 'walkthrough-losing-days',
    title: 'Walkthrough: find the days a strategy loses on',
    summary: 'Use the day grid, the replay and the day-type card to understand bad days.',
    kind: 'Walkthrough',
    body: optionsLosingDays,
  },

  // ---- Data & operations ---------------------------------------------------------------
  {
    chapter: 'operations',
    slug: 'overview',
    title: 'Overview',
    summary: 'The landing screen: one card per daily question, each linking to the detail.',
    kind: 'Screen',
    body: opsOverview,
    screen: { tab: 'overview' },
  },
  {
    chapter: 'operations',
    slug: 'jobs',
    title: 'Jobs',
    summary: 'Every scheduled job, when it runs, how its last run went, and its log.',
    kind: 'Screen',
    body: opsJobs,
    screen: { tab: 'jobs' },
  },
  {
    chapter: 'operations',
    slug: 'broker-logins',
    title: 'Broker logins',
    summary:
      'The Fyers market-data login, why it expires daily, and the automatic AlgoTest logins.',
    kind: 'Screen',
    body: opsBrokerLogins,
    screen: { tab: 'brokerLogins' },
  },
  {
    chapter: 'operations',
    slug: 'coverage',
    title: 'Data › Coverage',
    summary: 'Backfill and Replay: historical candles for the paused live engine.',
    kind: 'Screen',
    body: opsCoverage,
    screen: { tab: 'coverage' },
  },
  {
    chapter: 'operations',
    slug: 'settings',
    title: 'Settings',
    summary: 'Appearance, defaults, which tabs show, and which Telegram alerts you get.',
    kind: 'Screen',
    body: opsSettings,
    screen: { tab: 'settings' },
  },

  // ---- Glossary ------------------------------------------------------------------------
  {
    chapter: 'glossary',
    slug: 'terms',
    title: 'Glossary',
    summary: 'Every term the Guide uses, in plain words.',
    kind: 'Reference',
    body: glossaryIntro,
  },
];

export function guidePath(page: GuidePage): string {
  return buildPath('guide', page.chapter, page.slug);
}

export function chapterTitle(chapter: GuideChapterId): string {
  return GUIDE_CHAPTERS.find((c) => c.id === chapter)?.title ?? chapter;
}

export function chapterPages(chapter: GuideChapterId): GuidePage[] {
  return GUIDE_PAGES.filter((page) => page.chapter === chapter);
}

/**
 * The page a Guide route names (`rest` is what follows /guide), and whether the route was
 * already its canonical path. A bare chapter opens its first page; anything unknown opens the
 * first page of all.
 */
export function resolveGuidePage(rest: readonly string[]): { page: GuidePage; exact: boolean } {
  const [chapter, slug] = rest;
  const exact = GUIDE_PAGES.find((p) => p.chapter === chapter && p.slug === slug);
  if (exact && rest.length === 2) return { page: exact, exact: true };
  const first = GUIDE_PAGES.find((p) => p.chapter === chapter) ?? GUIDE_PAGES[0];
  return { page: exact ?? (first as GuidePage), exact: false };
}

export function guidePageByRef(ref: string): GuidePage | undefined {
  const [chapter, slug] = ref.split('/');
  return GUIDE_PAGES.find((p) => p.chapter === chapter && p.slug === slug);
}

/**
 * The page that documents a screen: among pages on that tab whose `screen.rest` is a prefix of
 * `rest`, the most specific one (`/optionslab/builder/yaml` gets the YAML page, not the form's).
 * Ties go to the earlier page, so a screen with two pages links to its first.
 */
export function guidePageForScreen(tab: Tab, rest: readonly string[] = []): GuidePage | undefined {
  let best: GuidePage | undefined;
  for (const page of GUIDE_PAGES) {
    if (page.screen?.tab !== tab) continue;
    const want = page.screen.rest ?? [];
    if (!want.every((segment, index) => rest[index] === segment)) continue;
    if (!best || want.length > (best.screen?.rest?.length ?? 0)) best = page;
  }
  return best;
}

export function neighbours(page: GuidePage): {
  previous: GuidePage | undefined;
  next: GuidePage | undefined;
} {
  const index = GUIDE_PAGES.indexOf(page);
  return { previous: GUIDE_PAGES[index - 1], next: GUIDE_PAGES[index + 1] };
}

/** A page's text as a reader sees it: link targets (`app:/…`, `guide:…`, `glossary:…`) dropped. */
function readableText(body: string): string {
  return body.replace(/\]\([^)]*\)/g, ']');
}

const HAYSTACKS = new Map<GuidePage, string>();

function haystack(page: GuidePage): string {
  let text = HAYSTACKS.get(page);
  if (text === undefined) {
    text = `${page.title}\n${page.summary}\n${readableText(page.body)}`.toLowerCase();
    HAYSTACKS.set(page, text);
  }
  return text;
}

/** Pages whose title, summary or text contains every word of the query (case-insensitive). */
export function searchGuide(query: string): GuidePage[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...GUIDE_PAGES];
  return GUIDE_PAGES.filter((page) => words.every((word) => haystack(page).includes(word)));
}
