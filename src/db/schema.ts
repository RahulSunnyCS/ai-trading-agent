/**
 * TypeScript interfaces for every database table in migration 001.
 *
 * IMPORTANT — NUMERIC columns are typed as `string`, not `number`.
 *
 * Reason: the pg client is configured with `pg.types.setTypeParser(1700, val => val)`
 * in src/db/client.ts. OID 1700 is the PostgreSQL NUMERIC type. This parser
 * returns the raw wire-format string instead of coercing it to a JS float.
 * Typing these columns as `number` would be a lie: callers receive a string at
 * runtime and must use string arithmetic or a decimal library (e.g. `decimal.js`)
 * for any precision math. Using `number` would silently introduce floating-point
 * rounding errors in P&L calculations, which are unacceptable in a trading context.
 *
 * All column names are camelCase to match TypeScript conventions. The pg driver
 * returns column names in lowercase by default, so the SQL column names use
 * snake_case and callers alias or map as needed when the column name differs
 * from camelCase.
 */

// ---------------------------------------------------------------------------
// paper_trades
// ---------------------------------------------------------------------------

/**
 * One simulated straddle paper trade opened by a personality.
 *
 * Nullable columns (entry/exit legs, context data) use `string | null` rather
 * than optional `?` to make it explicit that these fields always come back from
 * the database — they are simply NULL-valued, not absent from the row object.
 *
 * status is narrowed to the literal union to match the CHECK constraint in the
 * migration rather than being typed as plain `string`.
 *
 * Milestone 2 columns (personalityId, parentTradeId, signalId):
 * These three columns were added in migration 004. All rows created before
 * Milestone 2 (i.e. all Sprint 1 paper trades) will have NULL for these fields.
 * NULL means "trade was created before the personality engine existed" — it is
 * not a data error. Callers must treat NULL as "pre-M2 trade" and not assume
 * a missing personality association is a bug.
 */
export interface PaperTrade {
  id: string;
  entryTime: Date;
  exitTime: Date | null;
  entryCeStrike: string | null;
  entryPeStrike: string | null;
  entryCePrice: string | null;
  entryPePrice: string | null;
  exitCePrice: string | null;
  exitPePrice: string | null;
  lots: number;
  lotSize: number;
  straddleAtEntry: string;
  lowestStraddleValueSeen: string;
  vixAtEntry: string | null;
  spotAtEntry: string | null;
  exitReason: string | null;
  grossPnl: string | null;
  netPnl: string | null;
  maxDrawdown: string | null;
  status: "open" | "closed";
  notes: string | null;
  // Milestone 2 fields — NULL for all pre-M2 (Sprint 1) rows
  personalityId: string | null;
  parentTradeId: string | null; // non-null only for rolled legs (Adjuster)
  signalId: string | null;      // null for Clockwork fixed-time entries and pre-M2 rows
}

// ---------------------------------------------------------------------------
// market_ticks
// ---------------------------------------------------------------------------

/**
 * One raw tick from the broker WebSocket or simulator.
 *
 * volume and oi are nullable because the Fyers WebSocket does not always
 * include them in every tick message.
 *
 * time is typed as Date because pg automatically parses TIMESTAMPTZ columns
 * to JS Date objects (unlike NUMERIC, there is no custom type parser needed).
 */
export interface MarketTick {
  time: Date;
  symbol: string;
  lastPrice: string;
  volume: bigint | null;
  oi: bigint | null;
}

// ---------------------------------------------------------------------------
// straddle_snapshots
// ---------------------------------------------------------------------------

/**
 * One 15-second ATM straddle snapshot produced by straddle-calc.ts.
 *
 * vix is nullable: the VIX poller may not have a value at startup before the
 * NSE API responds.
 *
 * roc and acceleration were added in migration 003. They are nullable because
 * the first few snapshots do not have enough history to compute a meaningful
 * rate-of-change or second derivative value.
 */
export interface StraddleSnapshot {
  time: Date;
  underlying: string;
  spot: string;
  atmStrike: string;
  cePrice: string;
  pePrice: string;
  straddleValue: string;
  vix: string | null;
  roc: string | null;          // rate-of-change of straddle value; null until history exists
  acceleration: string | null; // second derivative of straddle value; null until history exists
}

// ---------------------------------------------------------------------------
// personality_configs
// ---------------------------------------------------------------------------

/**
 * One trading personality and its full configuration.
 *
 * params is typed as Record<string, unknown> rather than a narrow interface
 * because each personality has a different params schema (e.g. Adjuster has
 * roll_trigger_points, Precision has entry_delay_secs). Callers that need
 * strongly-typed params should cast after a personality-name guard.
 *
 * is_frozen marks the Clockwork benchmark: the evolution engine must throw
 * FROZEN_VIOLATION (never silently skip) if asked to modify a frozen personality.
 *
 * phase gates personalities behind major feature milestones. A personality with
 * phase = 2 must not be activated until the Phase 2 engine is deployed.
 */
export interface PersonalityConfig {
  id: string;
  name: string;
  displayName: string;
  groupType: "reference" | "learning";
  entryType: "fixed_time" | "momentum_exhaustion" | "any_signal" | "sr_anchored";
  managementStyle: "hold" | "roll" | "cut_reenter";
  isFrozen: boolean;
  isActive: boolean;
  phase: number;
  params: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// personality_audit_log
// ---------------------------------------------------------------------------

/**
 * One immutable audit record capturing a parameter change on a personality.
 *
 * Both oldParams and newParams are stored as full JSONB blobs so any change can
 * be reviewed or rolled back without querying external systems. reason is nullable
 * because automated evolution-engine changes may not carry a human-readable reason.
 *
 * changedBy defaults to 'api' for REST-triggered changes and should be set to
 * 'evolution_engine' for automated retrospection-driven changes.
 */
export interface PersonalityAuditLog {
  id: string;
  personalityId: string;
  changedAt: Date;
  changedBy: string;
  oldParams: Record<string, unknown>;
  newParams: Record<string, unknown>;
  reason: string | null;
}

// ---------------------------------------------------------------------------
// straddle_signals
// ---------------------------------------------------------------------------

/**
 * One signal event produced by the peak detection engine.
 *
 * adjustedProbability is the final score after VIX and time-of-day context
 * adjustments have been applied. rawExhaustionScore is the pre-adjustment value.
 * Both are NUMERIC in the DB and therefore typed as string here (see file header).
 *
 * confidenceTier is a pre-computed categorical bucket derived from
 * adjustedProbability so the personality filter stages can use simple equality
 * checks rather than numeric threshold comparisons.
 *
 * Algorithm-specific columns (expansionPct, rocDeclineCandles, accelerationValue)
 * are nullable: SCHEDULED signals are not produced by the peak detection algorithm
 * and will have NULL for all of these.
 *
 * adjustmentBreakdown is a free-text explanation of how the VIX and time-of-day
 * multipliers shifted the raw score, stored for retrospection analysis.
 *
 * This table is a TimescaleDB hypertable — all queries must include a time-range
 * filter (WHERE time > ...) to avoid full hypertable scans.
 */
export interface StraddleSignal {
  id: string;
  time: Date;
  underlying: string;
  signalType: "MOMENTUM_EXHAUSTION" | "SCHEDULED" | "PULLBACK";
  atmStrike: string;
  spot: string;
  straddleValue: string;
  vix: string | null;
  rawExhaustionScore: string | null;  // null for SCHEDULED signals
  adjustedProbability: string;
  confidenceTier: "HIGH" | "MEDIUM" | "LOW";
  expansionPct: string | null;        // null for SCHEDULED signals
  rocDeclineCandles: number | null;   // INTEGER column, not NUMERIC — stays as number
  accelerationValue: string | null;   // null for SCHEDULED signals
  adjustmentBreakdown: string | null;
}

// ---------------------------------------------------------------------------
// OpenPosition (runtime shape — not a DB table)
// ---------------------------------------------------------------------------

/**
 * The in-memory shape consumed by the trigger engine (T-16) to evaluate
 * whether an open position should be closed, rolled, or held.
 *
 * This is derived from `paper_trades` rows where status = 'open'. It carries
 * only the fields the trigger engine needs — the full `PaperTrade` row is not
 * required at decision time.
 *
 * entryTimeMs is epoch milliseconds (Date.getTime()) rather than a Date object
 * because the trigger engine compares it to Date.now() for time-in-trade
 * calculations, and arithmetic on numbers is simpler than Date subtraction.
 *
 * todayNetPnl is a running P&L string computed by the trigger engine from the
 * current straddle value versus straddleAtEntry, not stored directly in the DB.
 */
export interface OpenPosition {
  id: string;
  entryStraddleValue: string;
  lowestStraddleValueSeen: string;
  entryTimeMs: number;
  todayNetPnl: string;
}
