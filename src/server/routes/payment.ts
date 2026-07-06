/**
 * Payment API routes — Fastify plugin.
 *
 * Registers:
 *  GET  /api/payment/status       — payment system status + geolocation
 *  GET  /api/payment/plans        — available payment plans with prices
 *  POST /api/payment/create-order — create a Razorpay order
 *  POST /api/payment/verify       — verify payment signature + record grant
 *  POST /api/payment/webhook      — Razorpay webhook (raw-body HMAC verification)
 *  GET  /api/payment/balance      — current credit balance
 *
 * Security decisions:
 * - RAZORPAY_KEY_SECRET is never echoed in any response body or log line.
 * - RAZORPAY_WEBHOOK_SECRET is never echoed in any response body or log line.
 * - The webhook route uses a scoped content-type parser so only that route
 *   receives raw bytes — other routes in this plugin continue to receive
 *   parsed JSON normally.
 * - verifyWebhookSignature receives a Buffer (raw bytes from the HTTP body),
 *   never a re-serialised JSON string, preventing HMAC mismatch due to key
 *   ordering or whitespace differences.
 * - verifyPaymentSignature uses timing-safe comparison (see razorpay.ts).
 * - No default export (project convention).
 */

import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

import { extractClientIp, getClientCountry } from '../../payment/geolocation';
import {
  createOrder,
  getCreditBalance,
  isPaymentEnabled,
  isTestMode,
  verifyPaymentSignature,
  verifyWebhookSignature,
} from '../../payment/razorpay';

// ---------------------------------------------------------------------------
// Plan definitions
// ---------------------------------------------------------------------------

// Plan IDs are a fixed union — unknown plan IDs from the client must be
// rejected at the API boundary.
type PlanId = 'monthly_pass' | 'credits_50' | 'credits_200';

interface Plan {
  id: PlanId;
  name: string;
  pricePaise: number;
  description: string;
}

/**
 * Returns the plan list. Prices are read from env vars at call time so that
 * tests can set env vars before calling and see the expected values without
 * restarting the process.
 */
function buildPlans(): Plan[] {
  // parseInt with a fallback string is needed to satisfy noUncheckedIndexedAccess —
  // process.env[key] is string | undefined, so we always supply a default.
  const monthlyPricePaise = Number.parseInt(
    process.env.RAZORPAY_MONTHLY_PASS_PRICE_PAISE || '99900',
    10,
  );
  const credits50PricePaise = Number.parseInt(
    process.env.RAZORPAY_CREDITS_PACK_50_PRICE_PAISE || '49900',
    10,
  );
  const credits200PricePaise = Number.parseInt(
    process.env.RAZORPAY_CREDITS_PACK_200_PRICE_PAISE || '149900',
    10,
  );

  return [
    {
      id: 'monthly_pass',
      name: 'Monthly Access Pass',
      pricePaise: monthlyPricePaise,
      description: '30 days full access',
    },
    {
      id: 'credits_50',
      name: '50 Credits Pack',
      pricePaise: credits50PricePaise,
      description: '50 feature tokens',
    },
    {
      id: 'credits_200',
      name: '200 Credits Pack',
      pricePaise: credits200PricePaise,
      description: '200 feature tokens',
    },
  ];
}

/** Returns the credits amount for a given credits-pack plan ID. */
function creditsForPlan(plan: PlanId): number | null {
  if (plan === 'credits_50') return 50;
  if (plan === 'credits_200') return 200;
  return null;
}

/** Narrow an unknown string into a PlanId, returning null if not recognised. */
function asPlanId(value: unknown): PlanId | null {
  if (value === 'monthly_pass' || value === 'credits_50' || value === 'credits_200') {
    return value;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Webhook event types
// ---------------------------------------------------------------------------

// Narrow the Razorpay webhook payload shape we actually use.
// We only handle 'payment.captured' — all other events are acknowledged and
// dropped to keep the handler focused and forward-compatible.
interface RazorpayWebhookPayment {
  id: string;
  order_id: string;
  amount: number;
}

interface RazorpayWebhookEvent {
  event: string;
  payload: {
    payment?: {
      entity?: RazorpayWebhookPayment;
    };
  };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const paymentRoutes = fp(async (fastify: FastifyInstance, _opts: unknown) => {
  // ── GET /api/payment/status ───────────────────────────────────────────────

  fastify.get('/api/payment/status', async (request, reply) => {
    const enabled = isPaymentEnabled();
    const testMode = isTestMode();

    // Geolocation is best-effort — any error degrades to unknown, never throws.
    let region: string | null = null;
    let confidence: 'high' | 'low' | 'unknown' = 'unknown';

    try {
      const ip = extractClientIp(request);
      const geo = await getClientCountry(ip);
      // geo.country is string | null — pass through as-is.
      region = geo.country;
      confidence = geo.confidence;
    } catch {
      // Geolocation failure is non-fatal — return unknown rather than 500.
      region = null;
      confidence = 'unknown';
    }

    return reply.send({ enabled, testMode, region, confidence });
  });

  // ── GET /api/payment/plans ────────────────────────────────────────────────

  fastify.get('/api/payment/plans', async (_request, reply) => {
    if (!isPaymentEnabled()) {
      // Return empty plans when payment is disabled so the frontend can
      // gracefully hide the payment UI without needing special-case logic.
      return reply.send({ plans: [] });
    }

    return reply.send({ plans: buildPlans() });
  });

  // ── POST /api/payment/create-order ────────────────────────────────────────
  // TODO: add rate limiting (requires @fastify/rate-limit) — prevents order flooding

  fastify.post('/api/payment/create-order', async (request, reply) => {
    if (!isPaymentEnabled()) {
      return reply.status(503).send({ error: 'payment_disabled' });
    }

    // Narrow the request body — request.body is unknown in strict mode.
    const body = request.body as Record<string, unknown> | null | undefined;
    const planRaw = body != null ? body.plan : undefined;
    const plan = asPlanId(planRaw);

    if (plan === null) {
      return reply.status(400).send({ error: 'invalid_plan' });
    }

    const plans = buildPlans();
    // Safe find — plans is a fixed 3-element array so find will always
    // return the element when the plan ID has already been validated above.
    const planDef = plans.find((p) => p.id === plan);
    if (planDef === undefined) {
      // Defensive guard: plan ID validated but somehow missing from plans list.
      return reply.status(400).send({ error: 'invalid_plan' });
    }

    const receipt = `receipt_${plan}_${Date.now()}`;

    const order = await createOrder({
      amountPaise: planDef.pricePaise,
      currency: 'INR',
      receipt,
    });

    // Return only the public key ID — never the secret.
    // keyId may be undefined if isPaymentEnabled() is true but the env var was
    // removed mid-request (extremely unlikely but we guard for type safety).
    const keyId = process.env.RAZORPAY_KEY_ID ?? '';

    return reply.send({
      orderId: order.orderId,
      amount: order.amount,
      currency: order.currency,
      keyId,
    });
  });

  // ── POST /api/payment/verify ──────────────────────────────────────────────
  // TODO: add rate limiting (requires @fastify/rate-limit) — prevents brute-force on signatures

  fastify.post('/api/payment/verify', async (request, reply) => {
    const body = request.body as Record<string, unknown> | null | undefined;
    if (body == null) {
      return reply.status(400).send({ error: 'invalid_signature' });
    }

    const {
      orderId,
      paymentId,
      signature,
      plan: planRaw,
    } = body as {
      orderId?: unknown;
      paymentId?: unknown;
      signature?: unknown;
      plan?: unknown;
    };

    // Validate all required fields are non-empty strings before passing to
    // verifyPaymentSignature — the function handles malformed input gracefully
    // but we want a consistent 400 for obviously missing fields.
    if (
      typeof orderId !== 'string' ||
      typeof paymentId !== 'string' ||
      typeof signature !== 'string' ||
      orderId.length === 0 ||
      paymentId.length === 0 ||
      signature.length === 0
    ) {
      return reply.status(400).send({ error: 'invalid_signature' });
    }

    const plan = asPlanId(planRaw);
    if (plan === null) {
      return reply.status(400).send({ error: 'invalid_signature' });
    }

    const valid = verifyPaymentSignature(orderId, paymentId, signature);
    if (!valid) {
      return reply.status(400).send({ error: 'invalid_signature' });
    }

    // Determine grant fields based on plan type.
    const isMonthlyPass = plan === 'monthly_pass';

    // expires_at is 30 days from now for monthly_pass, NULL for credits packs.
    const expiresAt = isMonthlyPass ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000) : null;
    const daysGranted = isMonthlyPass ? 30 : null;
    const grantType = isMonthlyPass ? 'monthly_pass' : 'credits_pack';

    // Upsert the access_grant — ON CONFLICT handles idempotent retries gracefully.
    // The 005 migration enforces that monthly_pass rows have days_granted NOT NULL
    // and credits_pack rows have days_granted IS NULL, so we supply accordingly.
    const upsertResult = await fastify.db.query<{
      id: string;
      grant_type: string;
      expires_at: Date | null;
    }>(
      `INSERT INTO access_grants (razorpay_order_id, razorpay_payment_id, grant_type, status, days_granted, expires_at)
       VALUES ($1, $2, $3, 'paid', $4, $5)
       ON CONFLICT (razorpay_order_id) DO UPDATE
         SET status = 'paid', razorpay_payment_id = $2, expires_at = $5
       RETURNING id, grant_type, expires_at`,
      [orderId, paymentId, grantType, daysGranted, expiresAt],
    );

    const grantRow = upsertResult.rows[0];
    if (grantRow === undefined) {
      // Should never happen — INSERT ... RETURNING always returns a row.
      // Surface as a 500 rather than masking the error.
      return reply.status(500).send({ error: 'grant_write_failed' });
    }

    // For credits packs, insert the credit transaction so the balance is credited.
    const creditsAmount = creditsForPlan(plan);
    if (creditsAmount !== null) {
      await fastify.db.query(
        `INSERT INTO credit_transactions (razorpay_order_id, credits_delta, feature)
         VALUES ($1, $2, NULL)`,
        [orderId, creditsAmount],
      );
    }

    return reply.send({
      success: true,
      grantType: grantRow.grant_type,
      expiresAt: grantRow.expires_at,
    });
  });

  // ── POST /api/payment/webhook ─────────────────────────────────────────────
  //
  // CRITICAL: The webhook body MUST be the raw bytes from the HTTP request.
  // Razorpay signs the webhook payload over the exact bytes it sends; if we
  // parse and re-serialise the JSON the HMAC will be computed over different
  // bytes (different key order, whitespace, Unicode escapes) and will fail.
  //
  // We achieve this by registering a scoped sub-plugin (via encapsulation) that
  // overrides the 'application/json' content-type parser to return a Buffer.
  // The override is scoped to this sub-plugin only — it does not affect any
  // other route in the parent plugin or the rest of the server.

  await fastify.register(async (webhookScope) => {
    // Override the JSON content-type parser to deliver raw bytes as a Buffer.
    // `parseAs: 'buffer'` instructs Fastify to hand us the pre-parse bytes.
    // The done callback passes the Buffer through as-is with no transformation.
    webhookScope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_req, body, done) => {
        done(null, body);
      },
    );

    webhookScope.post('/api/payment/webhook', async (request, reply) => {
      // After the content-type override, request.body is a Buffer.
      // We cast via unknown because Fastify types request.body as unknown.
      const rawBody = request.body as unknown;

      if (!(rawBody instanceof Buffer)) {
        // Should never happen if addContentTypeParser is wired correctly.
        // Treat as an invalid request rather than crashing.
        return reply.status(400).send({ error: 'invalid_body' });
      }

      // Extract the webhook signature header — Razorpay always sends this.
      const sigHeader = request.headers['x-razorpay-signature'];
      // sigHeader may be string | string[] — we only accept a single value.
      const signature = typeof sigHeader === 'string' ? sigHeader : null;

      if (signature === null || signature.length === 0) {
        return reply.status(401).send({ error: 'invalid_webhook_signature' });
      }

      // Verify HMAC over the raw bytes — never re-serialised JSON.
      const valid = verifyWebhookSignature(rawBody, signature);
      if (!valid) {
        return reply.status(401).send({ error: 'invalid_webhook_signature' });
      }

      // Parse the event JSON from the verified raw bytes.
      let event: RazorpayWebhookEvent;
      try {
        const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
        // Validate the minimal shape we depend on.
        if (
          parsed === null ||
          typeof parsed !== 'object' ||
          !('event' in parsed) ||
          typeof (parsed as Record<string, unknown>).event !== 'string'
        ) {
          return reply.status(400).send({ error: 'invalid_body' });
        }
        event = parsed as RazorpayWebhookEvent;
      } catch {
        return reply.status(400).send({ error: 'invalid_body' });
      }

      // Extract the Razorpay event ID for idempotency.
      // Razorpay webhook events include an `id` field at the top level.
      // We use the event type + order_id as a fallback if the id field is absent.
      const bodyObj = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
      const eventId =
        typeof bodyObj.id === 'string' && bodyObj.id.length > 0
          ? bodyObj.id
          : `${event.event}:${event.payload.payment?.entity?.order_id ?? 'unknown'}`;

      // Idempotency check — skip already-processed events.
      const existingResult = await fastify.db.query<{ razorpay_event_id: string }>(
        'SELECT razorpay_event_id FROM processed_webhook_events WHERE razorpay_event_id = $1',
        [eventId],
      );

      if (existingResult.rows[0] !== undefined) {
        // Duplicate delivery — acknowledge without reprocessing.
        return reply.send({ received: true });
      }

      // Handle payment.captured — mark the access_grant as 'active'.
      if (event.event === 'payment.captured') {
        const paymentEntity = event.payload.payment?.entity;
        if (paymentEntity !== undefined) {
          const { order_id } = paymentEntity;
          if (typeof order_id === 'string' && order_id.length > 0) {
            await fastify.db.query(
              `UPDATE access_grants SET status = 'active' WHERE razorpay_order_id = $1`,
              [order_id],
            );
          }
        }
      }
      // Other event types are acknowledged but not acted upon — forward-compatible.

      // Record event as processed (idempotency log).
      await fastify.db.query(
        `INSERT INTO processed_webhook_events (razorpay_event_id) VALUES ($1)
         ON CONFLICT (razorpay_event_id) DO NOTHING`,
        [eventId],
      );

      return reply.send({ received: true });
    });
  });

  // ── GET /api/payment/balance ──────────────────────────────────────────────

  fastify.get('/api/payment/balance', async (_request, reply) => {
    if (!isPaymentEnabled()) {
      // Return zero balance when payment is disabled — no credit system active.
      return reply.send({ balance: 0 });
    }

    const balance = await getCreditBalance(fastify.db);
    return reply.send({ balance });
  });
});
