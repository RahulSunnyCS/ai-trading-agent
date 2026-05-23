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
 */

import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import {
  buildAuthUrl,
  exchangeAuthCode,
  loadFyersOAuthConfig,
  loadStoredToken,
  saveToken,
} from "../services/fyers-auth.js";

export const fyersAuthRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {
  server.get("/api/auth/fyers/login", async (_request, reply) => {
    const cfg = loadFyersOAuthConfig();
    if (!cfg) {
      return reply
        .code(503)
        .send({ error: "fyers_oauth_not_configured", message: "Set FYERS_APP_ID and FYERS_APP_SECRET in the server environment." });
    }
    const state = randomBytes(16).toString("hex");
    return reply.send({ url: buildAuthUrl(cfg, state), state });
  });

  server.get("/api/auth/fyers/callback", async (request, reply) => {
    const cfg = loadFyersOAuthConfig();
    if (!cfg) {
      return reply.code(503).send({ error: "fyers_oauth_not_configured" });
    }
    const query = request.query as Record<string, string | undefined>;
    const authCode = query.auth_code ?? query.code;
    if (!authCode) {
      return reply.code(400).send({ error: "missing_auth_code", details: query });
    }

    try {
      const token = await exchangeAuthCode(cfg, authCode);
      await saveToken(server.db, token);
      reply.header("Content-Type", "text/html; charset=utf-8");
      return reply.send(`<!doctype html>
<html><body style="font-family:system-ui;background:#0f172a;color:#e2e8f0;padding:2rem">
<h2>Fyers connected ✓</h2>
<p>Access token stored. Expires at ${token.expiresAt.toISOString()}.</p>
<p>You can close this tab.</p>
<script>setTimeout(() => window.close(), 1500);</script>
</body></html>`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      request.log.error({ err }, "[fyers-auth] token exchange failed");
      return reply.code(502).send({ error: "token_exchange_failed", message });
    }
  });

  server.get("/api/auth/fyers/status", async (_request, reply) => {
    const cfg = loadFyersOAuthConfig();
    if (!cfg) {
      return reply.send({ configured: false, connected: false });
    }
    const token = await loadStoredToken(server.db);
    if (!token) {
      return reply.send({ configured: true, connected: false });
    }
    const expired = token.expiresAt.getTime() <= Date.now();
    return reply.send({
      configured: true,
      connected: !expired,
      expiresAt: token.expiresAt.toISOString(),
      appId: token.appId,
    });
  });
};
