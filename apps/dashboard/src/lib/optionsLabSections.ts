/**
 * What each Options Lab screen answers (BL-102 Phase 1): the workspace it sits in, a question as
 * its title and one plain sentence under it. Kept free of React so a test can check that every
 * section has an entry and that the workspaces match the sidebar's groups.
 */

import type { OptionsLabSection } from './routes';

export interface SectionMeta {
  /** The workspace: Today, Explore data, Build and test or Advanced. Matches the sidebar's groups. */
  workspace: 'Today' | 'Explore data' | 'Build and test' | 'Advanced';
  /** The screen's title, written as the question it answers. */
  question: string;
  /** One sentence saying what is on the screen and how to read it. */
  explanation: string;
}

export const SECTION_META: Readonly<Record<OptionsLabSection, SectionMeta>> = {
  rotation: {
    workspace: 'Today',
    question: 'How is the Adaptive list doing?',
    explanation:
      'Adaptive picks its strategies from the Core pool (298 variants) at 09:16, before the market opens, and is scored every evening on days nobody had seen.',
  },
  heatmap: {
    workspace: 'Explore data',
    question: 'When is a short straddle worth entering, and with what stop?',
    explanation:
      'What one ATM short straddle made at each entry time and stop loss. Green made money, red lost it.',
  },
  matrix: {
    workspace: 'Explore data',
    question: 'Where do the strategy variants make or lose money?',
    explanation:
      'Average result per one-lot strategy-day, by start time, date or market condition, with the recorded picks laid over it.',
  },
  correlation: {
    workspace: 'Explore data',
    question: 'Do these lose on the same days?',
    explanation:
      'How alike the strategies’ daily results are. Strategies that lose together give little protection to each other.',
  },
  // Archived: hidden from the sidebar, still routed.
  regimes: {
    workspace: 'Advanced',
    question: 'Do quiet or trending days come in runs?',
    explanation:
      'Each day is labelled Quiet, Chop or Trend from the index and India VIX, then tested for whether the labels persist.',
  },
  strategies: {
    workspace: 'Build and test',
    question: 'Everything you can trade, in one place',
    explanation:
      'The rotation baskets and the saved strategies the evening run tests every day. Star the ones you care about: starred items are the default in Correlation.',
  },
  builder: {
    workspace: 'Build and test',
    question: 'How would this strategy have done?',
    explanation:
      'Build a strategy, test it over a date range on real 1-minute prices, and save it.',
  },
};
