/**
 * Fyers OAuth routes — in-dashboard login flow.
 *
 *   GET  /api/auth/fyers/login    → returns the Fyers authorization URL
 *   GET  /api/auth/fyers/callback → exchanges auth_code for access_token, stores it
 *   GET  /api/auth/fyers/status   → reports whether a non-expired token is stored
 *
 * The frontend opens /login in a new tab. After approving on fyers.in the user
 * is redirected to /callback, which writes the token to the broker_tokens
 * table and returns a small HTML page that closes itself.
 *
 * CSRF protection: /login generates a random `state` token and stores it in
 * the module-level pendingStates map (TTL = 10 minutes). Fyers echoes the
 * state back in the redirect URL (?state=...). /callback verifies the echoed
 * state is present in the map and removes it (one-time use). Mismatches are
 * rejected with HTTP 400. This prevents cross-site request forgery where an
 * attacker could craft a callback URL with a stolen auth_code.
 */

import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { checkTokenValidity, deriveStatusFlags } from '../../jobs/token-validity-check.js';
import {
  buildAuthUrl,
  exchangeAuthCode,
  loadFyersOAuthConfig,
  loadStoredToken,
  redactToken,
  saveToken,
} from '../services/fyers-auth.js';

// ---------------------------------------------------------------------------
// OAuth state store — CSRF protection
// ---------------------------------------------------------------------------
// We use a module-level Map (rather than @fastify/cookie or a DB) because:
//  1. @fastify/cookie is not a current dependency — adding it just for state
//     would introduce unnecessary churn.
//  2. The app is single-instance (see business.md); no distributed state
//     needed across multiple processes.
//  3. State tokens are short-lived (STATE_TTL_MS) and single-use.
// The Map is pruned on every /login call to avoid unbounded growth.
// ---------------------------------------------------------------------------

/** How long a pending OAuth state is valid, in milliseconds. */
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes — enough for any human to complete login

/**
 * Map of state token → expiry timestamp (ms since epoch).
 * Kept module-level so it survives across requests within the same process.
 */
const pendingStates = new Map<string, number>();

/** Remove expired entries from pendingStates to prevent unbounded growth. */
function pruneExpiredStates(): void {
  const now = Date.now();
  for (const [token, expiry] of pendingStates) {
    if (now > expiry) pendingStates.delete(token);
  }
}

export const fyersAuthRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {
  server.get('/api/auth/fyers/login', async (_request, reply) => {
    const cfg = loadFyersOAuthConfig();
    if (!cfg) {
      return reply.code(503).send({
        error: 'fyers_oauth_not_configured',
        message: 'Set FYERS_APP_ID and FYERS_APP_SECRET in the server environment.',
      });
    }

    // Prune stale entries before inserting a new one.
    pruneExpiredStates();

    const state = randomBytes(16).toString('hex');
    pendingStates.set(state, Date.now() + STATE_TTL_MS);

    return reply.send({ url: buildAuthUrl(cfg, state), state });
  });

  server.get('/api/auth/fyers/callback', async (request, reply) => {
    const cfg = loadFyersOAuthConfig();
    if (!cfg) {
      return reply.code(503).send({ error: 'fyers_oauth_not_configured' });
    }

    const query = request.query as Record<string, string | undefined>;

    // -----------------------------------------------------------------------
    // CSRF: verify the echoed state matches a pending (non-expired) entry.
    // Fyers echoes the state value we sent in the authorization URL back as
    // ?state=... on the redirect. We reject anything that didn't originate
    // from our own /login route — which blocks CSRF replay attacks.
    // -----------------------------------------------------------------------
    const incomingState = query.state;
    if (!incomingState) {
      return reply
        .code(400)
        .send({ error: 'missing_state', message: 'OAuth state parameter is required.' });
    }
    const stateExpiry = pendingStates.get(incomingState);
    if (stateExpiry === undefined) {
      // State not found — either forged or already consumed (replay attempt).
      request.log.warn(
        '[fyers-auth] OAuth callback received unknown state — possible CSRF attempt',
      );
      return reply.code(400).send({
        error: 'invalid_state',
        message: 'OAuth state mismatch — please start the login flow again.',
      });
    }
    if (Date.now() > stateExpiry) {
      // State found but expired.
      pendingStates.delete(incomingState);
      request.log.warn('[fyers-auth] OAuth callback received expired state');
      return reply.code(400).send({
        error: 'expired_state',
        message: 'OAuth state expired — please start the login flow again.',
      });
    }
    // Consume the state (one-time use) regardless of subsequent success/failure.
    pendingStates.delete(incomingState);

    const authCode = query.auth_code ?? query.code;
    if (!authCode) {
      return reply.code(400).send({ error: 'missing_auth_code', details: query });
    }

    try {
      const token = await exchangeAuthCode(cfg, authCode);
      await saveToken(server.db, token);

      // Fire the in-process broker reload hook fire-and-forget. The token is
      // already persisted at this point, so even if the reload fails the operator
      // still sees the success page. The callback response must not wait on feed
      // reconnection — that can take seconds and is best-effort. Any reload error
      // is logged via request.log and the authDegraded flag remains true until the
      // next successful reload attempt (e.g. the 30-second /api/meta poll will
      // flip it once the feed is live).
      void Promise.resolve(server.onTokenStored?.()).catch((e) => {
        request.log.error(e, '[fyers-auth] broker reload after login failed');
      });

      reply.header('Content-Type', 'text/html; charset=utf-8');
      return reply.send(`<!doctype html>
<html><body style="font-family:system-ui;background:#0f172a;color:#e2e8f0;padding:2rem">
<h2>Fyers connected ✓</h2>
<p>Access token stored. Expires at ${token.expiresAt.toISOString()}.</p>
<p>You can close this tab.</p>
<script>setTimeout(() => window.close(), 1500);</script>
</body></html>`);
    } catch (err) {
      // Log only a redacted token reference (first 4 chars) — never the full
      // token or secret. The error message from Fyers may embed the auth code,
      // so we log the safe message string only, not the raw error object.
      const safeMessage = err instanceof Error ? err.message : String(err);
      request.log.error(
        { authCode: redactToken(authCode) },
        `[fyers-auth] token exchange failed: ${safeMessage}`,
      );
      return reply.code(502).send({ error: 'token_exchange_failed', message: safeMessage });
    }
  });

  server.get('/api/auth/fyers/status', async (_request, reply) => {
    const cfg = loadFyersOAuthConfig();
    if (!cfg) {
      // No OAuth config → cannot be connected. Degraded/needsReauth are also
      // true so the dashboard banner can prompt the operator to configure
      // the env vars, not just re-authenticate.
      return reply.send({
        configured: false,
        connected: false,
        degraded: true,
        needsReauth: true,
      });
    }

    const token = await loadStoredToken(server.db);

    // Reuse checkTokenValidity from token-validity-check.ts so the validity
    // computation lives in exactly one place — the status route and the
    // scheduled job share identical logic with no duplication.
    const state = checkTokenValidity(token?.expiresAt ?? null);
    const { degraded, needsReauth } = deriveStatusFlags(state);

    if (!token) {
      return reply.send({
        configured: true,
        connected: false,
        degraded,
        needsReauth,
      });
    }

    return reply.send({
      configured: true,
      // connected reflects whether the token is usable right now:
      // near-expiry tokens are still technically valid, so connected=true.
      // Only missing/expired tokens make connected=false.
      connected: !needsReauth,
      expiresAt: token.expiresAt.toISOString(),
      appId: token.appId,
      degraded,
      needsReauth,
    });
  });
};
