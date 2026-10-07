/**
 * The Guide's glossary (BL-041): one entry per term, written for someone who knows basic
 * options and investing but is new to this tool. The Glossary page lists every entry, and a
 * guide page links a term with `[text](glossary:<id>)`, which shows `short` on hover.
 *
 * Keep `short` to one or two sentences: it is the tooltip. `long` is shown only on the
 * Glossary page. Ids are lowercase-kebab and never change once used (pages link to them).
 */

export type GlossaryGroup = 'Options' | 'Momentum' | 'Metrics' | 'Data & tools';

export const GLOSSARY_GROUPS: readonly GlossaryGroup[] = [
  'Options',
  'Momentum',
  'Metrics',
  'Data & tools',
];

export interface GlossaryEntry {
  id: string;
  term: string;
  group: GlossaryGroup;
  /** One or two sentences; the hover text. */
  short: string;
  /** Extra detail for the Glossary page. */
  long?: string;
  /** Related entry ids. */
  seeAlso?: string[];
}

export const GLOSSARY: readonly GlossaryEntry[] = [
  // ---- Options -------------------------------------------------------------------------
  {
    id: 'leg',
    term: 'Leg',
    group: 'Options',
    short:
      'One option position inside a strategy, such as "sell 1 lot of the NIFTY ATM call". A straddle has two legs, an iron condor four.',
    long: 'Each leg in Options Lab has its own strike rule, stop loss, target and re-entry rule, and is tracked on its own. That is what "leg-wise" means.',
    seeAlso: ['leg-wise', 'lot'],
  },
  {
    id: 'leg-wise',
    term: 'Leg-wise backtest',
    group: 'Options',
    short:
      'A backtest that manages every leg separately, minute by minute, the way AlgoTest does: each leg can hit its own stop loss or target.',
    seeAlso: ['leg', 'square-off'],
  },
  {
    id: 'lot',
    term: 'Lot',
    group: 'Options',
    short:
      'The exchange’s fixed contract size, such as 65 NIFTY units (from January 2026). Options Lab shows results in ₹ per lot so strategies of different sizes compare fairly.',
    long: 'Lot sizes change over time; the tool reads the size that was in force on each day rather than today’s.',
  },
  {
    id: 'ce-pe',
    term: 'CE / PE',
    group: 'Options',
    short: 'Call option (CE) and put option (PE), as NSE names them.',
  },
  {
    id: 'atm',
    term: 'ATM, ITM, OTM',
    group: 'Options',
    short:
      'At the money: the strike nearest the index price. OTM1, OTM2… are one, two… strike steps out of the money; ITM1… are steps into the money.',
    long: 'A strike step is the gap between listed strikes: 50 points for NIFTY, 100 for BANKNIFTY and SENSEX. With NIFTY at 25,030, ATM is 25,050; the OTM1 call is 25,100 and the OTM1 put is 25,000.',
    seeAlso: ['closest-premium'],
  },
  {
    id: 'closest-premium',
    term: 'Closest premium',
    group: 'Options',
    short:
      'A strike rule that picks the strike whose premium at entry is nearest the rupee amount you give, instead of counting steps from ATM.',
  },
  {
    id: 'straddle',
    term: 'Straddle, strangle, iron condor',
    group: 'Options',
    short:
      'Straddle: a call and a put at the same strike. Strangle: a call and a put at different OTM strikes. Iron condor: a sold strangle with further-out options bought as protection.',
  },
  {
    id: 'expiry',
    term: 'Weekly / monthly expiry',
    group: 'Options',
    short:
      'The date an option contract ends. A leg can trade the nearest weekly contract or the monthly one.',
    seeAlso: ['dte'],
  },
  {
    id: 'dte',
    term: 'DTE (days to expiry)',
    group: 'Options',
    short:
      'Trading days left until the nearest weekly expiry. On expiry day itself premiums decay fastest.',
  },
  {
    id: 'stop-loss',
    term: 'Stop loss and target',
    group: 'Options',
    short:
      'Exit levels for a leg, set in points or in % of the entry premium. A sold leg stops out when its premium rises by that much, and books its target when it falls.',
  },
  {
    id: 'trailing-sl',
    term: 'Trailing stop loss',
    group: 'Options',
    short:
      'Every time the premium moves X in the leg’s favour, the stop loss moves Y in the same direction, locking in part of the gain.',
  },
  {
    id: 're-entry',
    term: 'Re-entry (RE COST, RE ASAP)',
    group: 'Options',
    short:
      'What a leg does after its stop loss or target is hit. RE COST re-enters the same contract when its price returns to the original entry; RE ASAP picks the strike again and re-enters on the next minute.',
  },
  {
    id: 'range-breakout',
    term: 'Range breakout',
    group: 'Options',
    short:
      'A leg that waits: it records the high and low from entry until a set time, then enters only when that high or low is broken.',
  },
  {
    id: 'square-off',
    term: 'Square off (Partial / Complete)',
    group: 'Options',
    short:
      'Partial closes only the leg whose stop loss or target was hit. Complete closes every leg as soon as any one of them is hit.',
  },
  {
    id: 'mtm',
    term: 'MTM (mark to market)',
    group: 'Options',
    short:
      'The profit or loss of open positions at current prices, minute by minute, before anything is closed.',
    seeAlso: ['worst-mtm'],
  },
  {
    id: 'india-vix',
    term: 'India VIX',
    group: 'Options',
    short:
      'NSE’s volatility index: how much movement option prices imply for NIFTY over the next month. High VIX means expensive options and an expected big move.',
    seeAlso: ['implied-move'],
  },
  {
    id: 'implied-move',
    term: 'Implied vs realised move',
    group: 'Options',
    short:
      'Implied: the range India VIX priced in for a stretch of the day. Realised: the range NIFTY actually covered. Option sellers do well when realised stays below implied.',
  },
  {
    id: 'gap',
    term: 'Opening gap',
    group: 'Options',
    short:
      'The index’s open against the previous close. A large gap means much of the day’s move happened before any strategy could enter.',
  },
  {
    id: 'slippage',
    term: 'Slippage',
    group: 'Options',
    short:
      'The gap between the price a backtest assumes and the price you would really get. Options Lab takes it as a % of premium; Momentum in basis points (5 bps = 0.05%).',
  },
  {
    id: 'day-type',
    term: 'Day type (Quiet, Chop, Trend up, Trend down)',
    group: 'Options',
    short:
      'A label for how NIFTY moved in a stretch of the day, judged against the move India VIX implied: Quiet (well under it), Chop (covered it, back and forth), Trend up / Trend down (covered it in a clean direction).',
    seeAlso: ['lag-1', 'implied-move'],
  },
  {
    id: 'lag-1',
    term: 'Previous-day lens (lag-1)',
    group: 'Options',
    short:
      'Grouping results by the day type of the trading day before. It is the only grouping you could act on in advance; the same-day type is only known once the day is over.',
  },
  {
    id: 'stale-version',
    term: 'Stale version',
    group: 'Options',
    short:
      'A saved result from an older version of a strategy file. It is greyed out and left out of totals, so edited strategies are never mixed with their old results.',
  },
  {
    id: 'margin',
    term: 'Margin / return on peak margin',
    group: 'Options',
    short:
      'Margin is the money the broker blocks to hold a position. Return on peak margin is net profit divided by the most margin the strategy ever needed.',
  },

  // ---- Momentum ------------------------------------------------------------------------
  {
    id: 'momentum',
    term: 'Momentum',
    group: 'Momentum',
    short:
      'The tendency of things that have been rising to keep rising for a while. A momentum strategy buys recent winners and sells them once they stop leading.',
  },
  {
    id: 'lookback',
    term: 'Lookback',
    group: 'Momentum',
    short:
      'How many weeks back a return is measured. The default uses five: 1, 4, 13, 26 and 52 weeks (about a week, a month, a quarter, six months and a year).',
  },
  {
    id: 'rank-sum',
    term: 'Rank-sum score',
    group: 'Momentum',
    short:
      'Rank every candidate by its return over each lookback (1 = best), add the ranks up, and the lowest total wins. One hot week is not enough to come first.',
    seeAlso: ['lookback', 'vol-adjusted'],
  },
  {
    id: 'vol-adjusted',
    term: 'Volatility-adjusted score',
    group: 'Momentum',
    short:
      'Return divided by volatility, so a steady climber beats a jumpy one with the same return.',
  },
  {
    id: 'top-n',
    term: 'Top N',
    group: 'Momentum',
    short: 'How many of the best-ranked names the strategy buys.',
    seeAlso: ['exit-rank'],
  },
  {
    id: 'exit-rank',
    term: 'Exit rank (Sell when rank >)',
    group: 'Momentum',
    short:
      'A holding is only sold once its rank falls past this number. The gap between Top N and the exit rank is a buffer that stops a name being sold the moment it slips a place.',
    long: 'This buffer is also called hysteresis. With Top N 5 and exit rank 10, a name bought at #3 that slides to #8 is kept; at #11 it is sold.',
  },
  {
    id: 'rebalance',
    term: 'Rebalance',
    group: 'Momentum',
    short:
      'The weekly (or every 2 weeks, every 4 weeks, monthly) moment the strategy acts on the ranking: sell what fell out, buy what came in.',
  },
  {
    id: 'buffer-slots',
    term: 'Buffer vs Fixed slots',
    group: 'Momentum',
    short:
      'Buffer keeps every holding until it fails the exit rank and spreads new money across the current Top N. Fixed slots holds exactly N equal positions and refills a slot when it is sold.',
  },
  {
    id: 'position-cap',
    term: 'Position cap',
    group: 'Momentum',
    short:
      'The most any one holding may be of the portfolio. A holding that grows past it (by more than the trim band) is cut back.',
  },
  {
    id: 'crash-protection',
    term: 'Crash protection (defensive mode)',
    group: 'Momentum',
    short:
      'Whether the strategy may sit in cash or bonds when everything looks weak. Off by default: on its own tests it did not help.',
  },
  {
    id: 'etf-rotation',
    term: 'ETF Rotation',
    group: 'Momentum',
    short:
      'The momentum dataset that rotates between about two dozen sector, broad-market, commodity, international and debt ETFs. Rankings use the index; trades use the ETF.',
  },
  {
    id: 'broad-momentum',
    term: 'Broad Momentum',
    group: 'Momentum',
    short:
      'The momentum dataset that picks individual stocks through a funnel: the strongest stocks form a pool, the strongest sectors in that pool are chosen, and the top stocks of each sector are bought.',
    seeAlso: ['coverage-floor'],
  },
  {
    id: 'coverage-floor',
    term: 'Coverage floor',
    group: 'Momentum',
    short:
      'In Broad Momentum, a sector only counts if at least this share of its stocks made the pool, so one lucky stock cannot carry a whole sector.',
  },
  {
    id: 'survivorship',
    term: 'Survivorship bias',
    group: 'Momentum',
    short:
      'The flattering error of testing only companies that still exist or are in an index today. The stock data here uses who was really listed and in the index on each past date.',
  },
  {
    id: 'circuit',
    term: 'Circuit limit (UC / LC)',
    group: 'Momentum',
    short:
      'NSE’s daily price band for a stock. A stock locked at its upper circuit cannot be bought, and one locked at its lower circuit cannot be sold, so a realistic backtest must respect that.',
  },
  {
    id: 'turnover-filter',
    term: 'Tradability filter',
    group: 'Momentum',
    short:
      'Each week, keeps only stocks that trade enough (median daily turnover) and are not stuck at a circuit limit, using only data known on that date.',
  },
  {
    id: 'ter',
    term: 'TER / tracking',
    group: 'Momentum',
    short:
      'An ETF’s yearly fee (total expense ratio). Because of it, and because an ETF can trade above or below its value, an ETF’s return differs slightly from its index.',
  },
  {
    id: 'preview-final',
    term: 'Preview vs final signal',
    group: 'Momentum',
    short:
      'Fridays at 14:40 a preview is computed on live prices so you can trade near the close; at 16:45 the final signal uses the official close. Stock-based strategies get only a final, at 19:30.',
  },
  {
    id: 'favourite',
    term: 'Favourite / Telegram-active run',
    group: 'Momentum',
    short:
      'Favourite saved runs are re-evaluated every Friday and recorded in the journal. Exactly one of them is Telegram-active: its signal is the one sent to Telegram.',
  },
  {
    id: 'forward-journal',
    term: 'Forward journal',
    group: 'Momentum',
    short:
      'Every weekly signal, written down when it was produced and never changed afterwards. It is the honest record of what the strategy said in real time, as opposed to a backtest.',
  },
  {
    id: 'benchmark',
    term: 'Benchmark',
    group: 'Momentum',
    short:
      'What a strategy is compared against, such as Nifty 50 with dividends. A strategy only earns its keep if it beats a cheap index fund after costs and tax.',
  },

  // ---- Metrics -------------------------------------------------------------------------
  {
    id: 'cagr',
    term: 'CAGR',
    group: 'Metrics',
    short:
      'Compound annual growth rate: the steady yearly return that would turn the starting value into the ending value over the period.',
  },
  {
    id: 'edge',
    term: 'Edge vs benchmark',
    group: 'Metrics',
    short: 'Strategy CAGR minus benchmark CAGR: how much faster it compounded per year.',
  },
  {
    id: 'max-drawdown',
    term: 'Max drawdown',
    group: 'Metrics',
    short:
      'The worst fall from a peak to a later low. It is the pain you would have had to sit through.',
  },
  {
    id: 'sharpe',
    term: 'Sharpe ratio',
    group: 'Metrics',
    short:
      'Return above cash per unit of total volatility. Above 1 is generally considered good, above 2 very good.',
    seeAlso: ['sortino'],
  },
  {
    id: 'sortino',
    term: 'Sortino ratio',
    group: 'Metrics',
    short:
      'Like Sharpe, but only downside swings count as risk, so a strategy is not penalised for jumping up.',
  },
  {
    id: 'churn',
    term: 'Churn (turnover)',
    group: 'Metrics',
    short:
      'Share of the portfolio sold and replaced per year. Higher means more trading, more cost and more short-term tax.',
  },
  {
    id: 'win-rate',
    term: 'Win rate',
    group: 'Metrics',
    short:
      'Share of trades (Momentum) or days (Options Lab) that made money. A low win rate can still be profitable if the wins are large.',
  },
  {
    id: 'expectancy',
    term: 'Expectancy',
    group: 'Metrics',
    short:
      'Average net ₹ per lot per day: total net divided by the number of days. What one more average day is worth.',
  },
  {
    id: 'profit-factor',
    term: 'Profit factor',
    group: 'Metrics',
    short:
      'Sum of the winning days divided by the sum of the losing days. Above 1 means the wins outweigh the losses.',
  },
  {
    id: 'worst-mtm',
    term: 'Worst MTM',
    group: 'Metrics',
    short:
      'The deepest intraday loss on any day, before the day closed, even if it recovered. It tells you how much stomach (and margin) the strategy needs.',
  },
  {
    id: 'net-gross',
    term: 'Net vs gross',
    group: 'Metrics',
    short: 'Gross is profit before costs and slippage; net is after. Always judge on net.',
  },

  // ---- Data & tools --------------------------------------------------------------------
  {
    id: 'backtest',
    term: 'Backtest',
    group: 'Data & tools',
    short:
      'Replaying a trading rule over stored history to see what it would have done. It shows how a rule behaved, not what it will do.',
    seeAlso: ['overfitting'],
  },
  {
    id: 'overfitting',
    term: 'Overfitting',
    group: 'Data & tools',
    short:
      'Tuning settings until they fit the past perfectly. Try enough variations and one will look great by luck; it usually disappoints on new data.',
  },
  {
    id: 'out-of-sample',
    term: 'In-sample / out-of-sample',
    group: 'Data & tools',
    short:
      'In-sample is the history used to choose settings; out-of-sample is history kept aside and only looked at once, to check the choice was not luck.',
  },
  {
    id: 'fyers-token',
    term: 'Fyers token',
    group: 'Data & tools',
    short:
      'The daily login key for Fyers, the broker this tool uses for market data only. It dies at 06:00 IST every day; a scheduled job logs in again at 08:05.',
  },
  {
    id: 'algotest',
    term: 'AlgoTest',
    group: 'Data & tools',
    short:
      'The outside platform where real option strategies run on the owner’s broker accounts. This tool logs the brokers into it each morning; it places no orders itself.',
  },
  {
    id: 'evening-run',
    term: 'Evening run',
    group: 'Data & tools',
    short:
      'The 16:15 job on trading days: collects that day’s 1-minute option data from Fyers and runs every saved Options Lab strategy over it.',
  },
  {
    id: 'one-minute-data',
    term: '1-minute data',
    group: 'Data & tools',
    short:
      'Open, high, low and close for every minute of the session. Option contracts disappear after expiry, so the daily collection is the only way to keep their history.',
  },
  {
    id: 'corporate-action',
    term: 'Corporate action',
    group: 'Data & tools',
    short:
      'A split, bonus or dividend that changes a share’s price without changing what it is worth. Prices are adjusted for them so a split does not look like a crash.',
  },
  {
    id: 'credits',
    term: 'Credits',
    group: 'Data & tools',
    short:
      'Tokens some actions (such as an Options Lab backtest) cost when billing is switched on. Billing is off today, so runs are free.',
  },
];

const BY_ID = new Map(GLOSSARY.map((entry) => [entry.id, entry]));

export function glossaryEntry(id: string): GlossaryEntry | undefined {
  return BY_ID.get(id);
}

/** The DOM id of an entry on the Glossary page. */
export function glossaryAnchor(id: string): string {
  return `term-${id}`;
}
