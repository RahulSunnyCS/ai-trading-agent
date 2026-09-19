/**
 * Shared runtime broker authentication state.
 *
 * This module holds the LIVE/runtime socket auth state — it is set to true when
 * the broker WebSocket disconnects with AUTH_FAILURE (e.g. Fyers daily token
 * expired mid-session). This is distinct from the DB-token validity computed in
 * token-validity-check.ts, which checks whether the stored token has passed its
 * expiry timestamp before market open. The server (src/server/) merges both
 * mechanisms into one status payload for the dashboard operator.
 *
 * A module-private boolean is appropriate here: this is process-local state that
 * must outlive the disconnect callback scope. It resets to false on every process
 * restart, which is the correct behaviour — a Fyers token re-login already
 * requires restarting the process with a fresh token.
 *
 * Nothing outside the entry-point (src/index.ts) and the status endpoint should
 * need to call setAuthDegraded(). Prefer isAuthDegraded() for all reads.
 */

// Module-private flag — not exported directly to prevent unsupervised mutation.
let authDegraded = false;

/**
 * Mark the broker feed as auth-degraded (or clear the flag).
 * Call this from the onDisconnect AUTH_FAILURE handler in src/index.ts.
 */
export function setAuthDegraded(value: boolean): void {
  authDegraded = value;
}

/**
 * Returns true when the broker WebSocket disconnected with AUTH_FAILURE since
 * the last process start. The server status endpoint reads this to surface a
 * "re-login required" banner to the operator.
 */
export function isAuthDegraded(): boolean {
  return authDegraded;
}
