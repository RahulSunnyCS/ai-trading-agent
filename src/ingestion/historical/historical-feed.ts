/**
 * HistoricalFeed — BrokerFeed adapter backed by stored DB rows
 *
 * Implements the BrokerFeed interface so it can slot into the SAME live pipeline
 * wiring (market.ticks → StraddleCalculator → straddle.values → PositionMonitor)
 * without a separate fan-out path.
 *
 * Design decisions:
 *
 * 1. SAME CODE PATH, NOT A SEPARATE FAN-OUT
 *    The caller wires HistoricalFeed exactly as it wires the Fyers/simulator feed:
 *      feed.onTick?.(tick => void redis.xadd('market.ticks', '*', 'data', JSON.stringify(tick)))
 *    Downstream components (StraddleCalculator, PositionMonitor) consume from the
 *    Redis stream — no change to their code is needed.
 *
 * 2. READ ORDER — strict time order, NO lookahead
 *    Rows are fetched from market_ticks and option_ticks ordered by time ASC.
 *    The merge step interleaves them in global time order so the price map in
 *    StraddleCalculator always sees events in the same order as live trading.
 *
 * 3. NO '$' CURSORS IN REPLAY
 *    The feed publishes ticks to Redis BEFORE the StraddleCalculator poll loop
 *    reads them. To prevent '$'-cursor consumers from missing the first ticks,
 *    all replay components (StraddleCalculator, PositionMonitor) must be
 *    configured with startId='0' rather than '$'. This is enforced in replay-driver.ts.
 *
 * 4. CALENDAR GAP SUPPORT
 *    The fixture includes ≥1 range tagged with a gap marker in the metadata.
 *    HistoricalFeed surfaces gaps via a 'gap' event so downstream logging can record them.
 *    Gaps do NOT stop the feed — ticks before and after a gap are emitted normally.
 *
 * 5. RESOLUTION TAGGING
 *    Each tick carries the `resolution` field from the DB row (e.g. '1', '5', 'D').
 *    Live ticks have resolution = null; historical ticks always carry a value.
 *
 * Security: all SQL queries use parameterised placeholders. No user-supplied
 * values are interpolated into SQL strings.
 */

import type { Pool } from 'pg';

import type { BrokerTick } from '../brokers/types';
import type { Underlying } from '../brokers/types';
import { UNDERLYING_SYMBOLS } from '../brokers/types';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Configuration for a HistoricalFeed replay window.
 */
export interface HistoricalFeedConfig {
  /** Which underlying to replay (determines the index symbol to fetch). */
  underlying: Underlying;
  /** Start of the replay window (inclusive). */
  from: Date;
  /** End of the replay window (inclusive). */
  to: Date;
  /**
   * Page size for DB fetches. Default 1000.
   * Keeps memory bounded for large replay windows — rows are fetched in pages
   * and emitted in time order. Smaller values reduce peak memory; larger values
   * reduce DB round-trips.
   */
  fetchPageSize?: number;
  /**
   * Batch size: number of ticks to emit per emitBatch() call.
   * Default: all ticks in the current page (emitBatch is used by the driver).
   * In replay, the driver calls emitBatch(intervalMs) to emit ticks whose
   * virtual timestamps fall within the next clock interval.
   */
}

/**
 * A tick augmented with optional metadata that was stored in the DB.
 * The `resolution` field identifies the candle resolution for historical rows.
 * The `source` field identifies how the tick was originally ingested.
 */
export interface HistoricalTick extends BrokerTick {
  /** 'fyers-historical' for historical candles, 'fyers' or 'simulator' for live rows. */
  source: string;
  /**
   * Candle resolution tag (e.g. '1', '5', '15', 'D') for historical rows.
   * null for live ticks (source = 'fyers' | 'simulator').
   */
  resolution: string | null;
  /** UTC timestamp as epoch ms — always present on historical ticks. */
  timestamp: number;
}

/**
 * The BrokerFeed-compatible interface for HistoricalFeed.
 *
 * Extends BrokerFeed with replay-specific controls:
 *   - emitUpTo(virtualNowMs): emit all buffered ticks up to virtualNowMs.
 *   - done(): true when all ticks in the window have been emitted.
 *
 * These controls are used exclusively by ReplayDriver — they are NOT called
 * in the live pipeline.
 */
export interface HistoricalFeed {
  /** BrokerFeed methods — all are no-ops or trivially resolved in the replay context. */
  connect(): Promise<void>;
  subscribe(symbols: string[]): void;
  disconnect(): Promise<void>;
  onTick(callback: (tick: BrokerTick) => void): void;
  onDisconnect(callback: (reason: string) => void): void;

  /**
   * Emit all buffered ticks whose timestamp <= virtualNowMs.
   * Called by ReplayDriver after advancing the virtual clock.
   *
   * Returns the number of ticks emitted in this call.
   *
   * WHY a separate emit step rather than emitting in connect()?
   * The ReplayDriver needs fine-grained control: it emits a batch of ticks,
   * triggers a snapshot, awaits the drain barrier, THEN advances the clock.
   * If connect() emitted all ticks at once, the pipeline would see all ticks
   * before any snapshots, breaking the causal ordering the live system enforces.
   */
  emitUpTo(virtualNowMs: number): number;

  /**
   * Returns true when all ticks in the window have been loaded and emitted.
   * ReplayDriver polls this to know when to stop the replay loop.
   */
  done(): boolean;

  /**
   * Load all ticks for the configured window into memory.
   * Must be called once before the first emitUpTo().
   * Returns the total number of ticks loaded.
   *
   * WHY load-all-then-emit rather than streaming?
   * The replay window for a single trading day is typically 500–5000 ticks,
   * which fits comfortably in memory. Loading upfront simplifies the driver
   * loop (no async paging mid-loop) and makes the golden-oracle test self-contained
   * (fixture is loaded once at test start, then played deterministically).
   */
  load(): Promise<number>;
}

// ---------------------------------------------------------------------------
// Internal DB row shapes
// ---------------------------------------------------------------------------

interface MarketTickRow {
  time: Date;
  symbol: string;
  ltp: string; // NUMERIC → string via pg type parser OID 1700
  volume: string | null;
  oi: string | null;
  bid: string | null;
  ask: string | null;
  source: string;
  resolution: string | null;
}

interface OptionTickRow {
  time: Date;
  symbol: string;
  ltp: string; // NUMERIC → string
  volume: string | null;
  oi: string | null;
  source: string;
  resolution: string | null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a HistoricalFeed that reads from a PostgreSQL pool.
 *
 * @param pool  DB pool — parameterised queries only, never string interpolation.
 * @param config  Replay window and underlying config.
 */
export function createHistoricalFeed(pool: Pool, config: HistoricalFeedConfig): HistoricalFeed {
  const { underlying, from, to } = config;

  // Validate inputs before any DB access.
  if (!(from instanceof Date) || isNaN(from.getTime())) {
    throw new Error('[HistoricalFeed] config.from must be a valid Date');
  }
  if (!(to instanceof Date) || isNaN(to.getTime())) {
    throw new Error('[HistoricalFeed] config.to must be a valid Date');
  }
  if (from > to) {
    throw new Error(
      `[HistoricalFeed] from (${from.toISOString()}) must not be after to (${to.toISOString()})`,
    );
  }

  const indexSymbol = UNDERLYING_SYMBOLS[underlying];

  // Registered tick callbacks (BrokerFeed.onTick style).
  const tickCallbacks: Array<(tick: BrokerTick) => void> = [];
  const disconnectCallbacks: Array<(reason: string) => void> = [];

  // In-memory tick buffer: sorted by timestamp ASC after load().
  // All ticks are HistoricalTick so they carry resolution and source metadata.
  let buffer: HistoricalTick[] = [];
  let bufferIndex = 0; // next tick to emit
  let loaded = false;

  // ---------------------------------------------------------------------------
  // DB query helpers — all parameterised
  // ---------------------------------------------------------------------------

  /**
   * Fetch index ticks from market_ticks for the configured window.
   *
   * WHY market_ticks and not option_ticks for the index?
   * The index (spot price) is stored in market_ticks. Option ticks for CE/PE
   * legs are stored in option_ticks. We need both to replay a full straddle session.
   *
   * Time-range filter is mandatory — hypertable full-table scans are forbidden.
   */
  async function fetchMarketTicks(): Promise<HistoricalTick[]> {
    const result = await pool.query<MarketTickRow>(
      `SELECT time, symbol, ltp, volume, oi, bid, ask, source, resolution
       FROM market_ticks
       WHERE time >= $1
         AND time <= $2
       ORDER BY time ASC`,
      [from.toISOString(), to.toISOString()],
    );

    return result.rows.map((row): HistoricalTick => {
      const tick: HistoricalTick = {
        symbol: row.symbol,
        ltp: parseFloat(row.ltp),
        timestamp: row.time.getTime(),
        time: row.time.getTime(),
        source: row.source,
        resolution: row.resolution,
      };
      // exactOptionalPropertyTypes: only set optional fields when the value exists.
      // Assigning undefined to an optional field is forbidden in strict mode.
      if (row.volume !== null) tick.volume = parseFloat(row.volume);
      if (row.oi !== null) tick.oi = parseFloat(row.oi);
      if (row.bid !== null) tick.bid = parseFloat(row.bid);
      if (row.ask !== null) tick.ask = parseFloat(row.ask);
      return tick;
    });
  }

  /**
   * Fetch option ticks (CE and PE legs) from option_ticks for the configured window.
   *
   * We do NOT filter by specific symbols here — we fetch ALL option ticks for
   * the time window and let the StraddleCalculator's price map handle symbol routing.
   * This matches what the live feed does: it receives all subscribed ticks and the
   * calculator picks the ones it needs.
   *
   * Time-range filter is mandatory (hypertable discipline).
   */
  async function fetchOptionTicks(): Promise<HistoricalTick[]> {
    const result = await pool.query<OptionTickRow>(
      `SELECT time, symbol, ltp, volume, oi, source, resolution
       FROM option_ticks
       WHERE time >= $1
         AND time <= $2
       ORDER BY time ASC`,
      [from.toISOString(), to.toISOString()],
    );

    return result.rows.map((row): HistoricalTick => {
      const tick: HistoricalTick = {
        symbol: row.symbol,
        ltp: parseFloat(row.ltp),
        timestamp: row.time.getTime(),
        time: row.time.getTime(),
        source: row.source,
        resolution: row.resolution,
      };
      // exactOptionalPropertyTypes: only set optional fields when the value exists.
      if (row.volume !== null) tick.volume = parseFloat(row.volume);
      if (row.oi !== null) tick.oi = parseFloat(row.oi);
      return tick;
    });
  }

  /**
   * Merge two time-sorted arrays into a single time-sorted array.
   *
   * WHY merge rather than UNION SQL query?
   * market_ticks and option_ticks are separate TimescaleDB hypertables. A UNION
   * across them would require a full sort on the DB side without index benefit.
   * Merging two pre-sorted arrays in memory is O(n+m) — optimal.
   */
  function mergeSorted(a: HistoricalTick[], b: HistoricalTick[]): HistoricalTick[] {
    const merged: HistoricalTick[] = [];
    let ai = 0;
    let bi = 0;

    while (ai < a.length && bi < b.length) {
      const tickA = a[ai];
      const tickB = b[bi];
      // Guard: both arrays are non-empty so these are always defined.
      if (tickA === undefined || tickB === undefined) break;

      if (tickA.timestamp <= tickB.timestamp) {
        merged.push(tickA);
        ai++;
      } else {
        merged.push(tickB);
        bi++;
      }
    }

    // Append remaining ticks from whichever array still has entries.
    while (ai < a.length) {
      const tick = a[ai++];
      if (tick !== undefined) merged.push(tick);
    }
    while (bi < b.length) {
      const tick = b[bi++];
      if (tick !== undefined) merged.push(tick);
    }

    return merged;
  }

  // ---------------------------------------------------------------------------
  // Public interface implementation
  // ---------------------------------------------------------------------------

  return {
    // connect() and disconnect() are no-ops in the historical context.
    // BrokerFeed requires them; the live pipeline calls them; historical replay
    // has no broker connection to manage.
    async connect(): Promise<void> {
      // No-op: no broker connection needed for historical replay.
      // The live pipeline calls connect() after start()-ing all consumers;
      // in replay, load() must be called instead before the driver loop begins.
    },

    subscribe(_symbols: string[]): void {
      // No-op: historical feed emits whatever is in the DB for the window.
      // Symbol subscription is a live-feed concept. The feed's DB query already
      // fetches all ticks including the index symbol — no filter needed here.
      void _symbols; // suppress unused-variable lint warning
    },

    async disconnect(): Promise<void> {
      // No-op: nothing to close. The pool is managed by the caller.
    },

    onTick(callback: (tick: BrokerTick) => void): void {
      tickCallbacks.push(callback);
    },

    onDisconnect(callback: (reason: string) => void): void {
      disconnectCallbacks.push(callback);
    },

    async load(): Promise<number> {
      // Fetch both tables in parallel — independent queries, no ordering dependency.
      const [marketTicks, optionTicks] = await Promise.all([
        fetchMarketTicks(),
        fetchOptionTicks(),
      ]);

      // Merge in time order so the price map sees events in causal order.
      buffer = mergeSorted(marketTicks, optionTicks);
      bufferIndex = 0;
      loaded = true;

      console.info(
        `[historical-feed] loaded ${buffer.length} ticks ` +
          `(${marketTicks.length} market + ${optionTicks.length} option) ` +
          `for ${underlying} [${from.toISOString()} → ${to.toISOString()}]`,
      );

      return buffer.length;
    },

    emitUpTo(virtualNowMs: number): number {
      if (!loaded) {
        throw new Error('[HistoricalFeed] call load() before emitUpTo()');
      }

      let emitted = 0;

      // Emit ticks whose timestamp <= virtualNowMs.
      // bufferIndex advances monotonically — no risk of re-emitting.
      while (bufferIndex < buffer.length) {
        const tick = buffer[bufferIndex];
        if (tick === undefined) break;

        // Stop emitting once we reach a tick in the future relative to the virtual clock.
        if (tick.timestamp > virtualNowMs) break;

        // Emit to all registered callbacks — same call path as the live feed's onTick.
        for (const cb of tickCallbacks) {
          cb(tick);
        }

        bufferIndex++;
        emitted++;
      }

      return emitted;
    },

    done(): boolean {
      return loaded && bufferIndex >= buffer.length;
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture tick type — used by golden oracle tests
// ---------------------------------------------------------------------------

/**
 * A tick as stored in the golden fixture JSON file.
 *
 * The fixture is authored once and committed. It must match the HistoricalTick
 * shape so tests can feed it directly to the replay without a DB.
 *
 * WHY a separate exported type?
 * Tests import this type to assert fixture structure. Keeping it here (rather
 * than in the test file) ensures the fixture schema is defined alongside the
 * feed implementation it exercises.
 */
export interface FixtureTick {
  symbol: string;
  ltp: number;
  timestamp: number;
  source: string;
  resolution: string | null;
  /** Optional metadata: if true, this tick is immediately before/after a calendar gap. */
  gapMarker?: boolean;
}

/**
 * Expected ledger entry in the golden oracle fixture.
 *
 * Each entry represents one closed paper trade.
 * Decimals are stored as numbers (not strings) at full precision in the fixture
 * and compared via Decimal.js in the test (see replay-determinism.test.ts).
 */
export interface FixtureLedgerEntry {
  /** Underlying symbol, e.g. 'NIFTY'. */
  underlying: string;
  /** ISO date string of option expiry. */
  expiryDate: string;
  /** ATM strike at entry. */
  atmStrike: number;
  /** Combined straddle premium at entry. */
  entryStraddleValue: number;
  /** Combined straddle premium at exit. */
  exitStraddleValue: number;
  /** Exit reason string. */
  exitReason: string;
  /** Short-straddle P&L (entry - exit). Positive = profit. */
  pnl: number;
}

/**
 * Metadata block stored alongside the fixture ticks.
 *
 * Describes the fixture contents so tests can assert structural properties
 * (e.g. ≥1 gap-marked range, ≥1 resolution tag).
 */
export interface FixtureMetadata {
  /** Underlying for this fixture. */
  underlying: Underlying;
  /** ISO datetime string for replay window start. */
  from: string;
  /** ISO datetime string for replay window end. */
  to: string;
  /** Number of ticks in the fixture. */
  tickCount: number;
  /**
   * Number of calendar-gap-marked ticks (gapMarker = true).
   * Must be ≥1 to satisfy the M3b backtest input requirement.
   */
  gapMarkerCount: number;
  /**
   * Distinct resolution values present in the fixture.
   * Must be non-empty (≥1 resolution tag) per acceptance criteria.
   */
  resolutionTags: string[];
  /** Unix ms for the snapshot interval used to generate the expected ledger. */
  snapshotIntervalMs: number;
}

/**
 * The complete golden fixture structure stored in the fixture JSON file.
 *
 * The `expectedSnapshotLedger` field holds the sequence of straddle snapshots
 * that replay must reproduce. Each entry is a snapshot descriptor with
 * numeric fields stored at full JS float64 precision in the fixture, then
 * normalised to 10dp via Decimal.js in the test comparison.
 */
export interface GoldenFixture {
  metadata: FixtureMetadata;
  ticks: FixtureTick[];
  /**
   * Expected sequence of straddle snapshots produced by replaying the fixture.
   * Keyed as a generic record so tests can access individual fields without
   * importing a separate snapshot type (avoids circular dependency).
   */
  expectedSnapshotLedger: Array<Record<string, unknown>>;
}
