/**
 * Effective-dated NSE/BSE reference data for the TypeScript side.
 *
 * Reads the same CSVs as packages/option-backtesting, so the live engine and
 * the backtest engine cannot disagree about a lot size or a strike interval —
 * which they did, silently, for months.
 *
 * Never hard-code a lot size or strike interval. NSE has changed both within
 * a single year, and a number that was right last quarter is a wrong answer
 * dressed up as a constant.
 */
export { lotSize, strikeStep } from './loader.js';
export type { Underlying } from './loader.js';
