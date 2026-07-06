/**
 * Quantiply stub — no-op implementation of QuantiplyClient for MVP.
 *
 * The real Quantiply integration is deferred to a later phase. This stub
 * satisfies the QuantiplyClient interface so PaperTradeExecutor can be
 * constructed and tested without live Quantiply credentials.
 *
 * We export the interface here (rather than in paper-trade-executor.ts) because
 * the stub must implement it without creating a circular import. Callers that
 * only need the interface can import it from this file; PaperTradeExecutor
 * re-exports it for convenience.
 */

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/**
 * Contract for the Quantiply paper-trade recording client.
 * The real implementation POSTs to the Quantiply API; the stub is a no-op.
 *
 * `trade` is typed as `unknown` so callers must narrow it before use — the
 * Quantiply API payload shape is not yet finalised for Phase 1. Using `unknown`
 * is safer than `any` and satisfies Biome's noExplicitAny rule; the real client
 * will cast to a typed payload once the API shape is locked.
 */
export interface QuantiplyClient {
  recordTrade(trade: unknown): Promise<void>;
}

// ---------------------------------------------------------------------------
// Stub implementation
// ---------------------------------------------------------------------------

/**
 * No-op Quantiply client for MVP / development.
 *
 * Logs at INFO level so developers can see when recordTrade is called without
 * needing to wire up real Quantiply credentials. The log message is intentionally
 * brief — no trade payload is printed to avoid leaking position data into logs.
 */
export class QuantiplyStub implements QuantiplyClient {
  async recordTrade(_trade: unknown): Promise<void> {
    console.info('Quantiply stub: recordTrade called (no-op in MVP)');
  }
}
