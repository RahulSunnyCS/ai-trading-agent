import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { Pool } from 'pg';
import type { PersonalityConfigM2 as PersonalityConfig } from '../../db/schema.js';

/**
 * Options injected when this plugin is registered.
 * db is the pg Pool — injected rather than imported from the singleton so the
 * plugin remains independently testable without a real database.
 */
export interface PersonalitiesRoutesOptions {
  db: Pool;
}

// ---------------------------------------------------------------------------
// DB row shape (snake_case as returned by pg)
// ---------------------------------------------------------------------------

interface PersonalityRow {
  id: string;
  name: string;
  display_name: string;
  group_type: 'reference' | 'learning';
  entry_type: 'fixed_time' | 'momentum_exhaustion' | 'any_signal' | 'sr_anchored';
  management_style: 'hold' | 'roll' | 'cut_reenter';
  is_frozen: boolean;
  is_active: boolean;
  phase: number;
  params: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

// ---------------------------------------------------------------------------
// Mapping helper
// ---------------------------------------------------------------------------

/**
 * Maps a snake_case DB row to the camelCase PersonalityConfig TypeScript shape.
 *
 * pg returns JSONB columns as already-parsed JavaScript objects, so params
 * does not need JSON.parse(). Boolean columns (is_frozen, is_active) come back
 * as native JS booleans from pg.
 */
function mapPersonality(row: PersonalityRow): PersonalityConfig {
  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    groupType: row.group_type,
    entryType: row.entry_type,
    managementStyle: row.management_style,
    isFrozen: row.is_frozen,
    isActive: row.is_active,
    phase: row.phase,
    params: row.params,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Comparison integrity check
// ---------------------------------------------------------------------------

/**
 * Checks whether a proposed param update would cause min_probability values
 * across active momentum_exhaustion personalities (Precision, Adjuster,
 * Reducer) to diverge by more than 8 percentage points.
 *
 * This check is defined inline here because the T-26 evolution engine module
 * does not yet exist. Once T-26 ships its checkComparisonIntegrity export,
 * this inline version should be removed and replaced with the import.
 *
 * Why 8pp and not a tighter bound?
 * The project spec defines 8pp as the maximum acceptable divergence for the
 * management comparison to remain valid. Going tighter would reject legitimate
 * incremental tuning; going looser would invalidate the comparison.
 *
 * @param db - pg pool used to query the current state of other personalities
 * @param updatedPersonalityId - UUID of the personality being updated
 * @param proposedParams - merged params that would be saved if the check passes
 * @returns null if integrity holds, or an object describing the violation
 */
async function checkComparisonIntegrity(
  db: Pool,
  updatedPersonalityId: string,
  proposedParams: Record<string, unknown>,
): Promise<{ offender: string; message: string } | null> {
  // Only personalities with momentum_exhaustion entry_type and min_probability
  // params participate in this comparison. Fetch all active ones.
  const result = await db.query<{
    id: string;
    name: string;
    params: Record<string, unknown>;
  }>(
    `SELECT id, name, params
     FROM personality_configs
     WHERE entry_type = 'momentum_exhaustion'
       AND is_active = TRUE`,
  );

  if (result.rows.length === 0) {
    return null;
  }

  // Build a map of name → effective min_probability, using the proposed value
  // for the personality being updated and the stored value for all others.
  const probabilities: { name: string; prob: number }[] = [];

  for (const row of result.rows) {
    const effectiveParams = row.id === updatedPersonalityId ? proposedParams : row.params;

    const minProb = effectiveParams.min_probability;
    // Skip personalities that do not define min_probability — they are not
    // part of the comparison (e.g. a new personality with different param schema).
    if (typeof minProb !== 'number') {
      continue;
    }
    probabilities.push({ name: row.name, prob: minProb });
  }

  if (probabilities.length < 2) {
    // With fewer than 2 participants, there is nothing to diverge from.
    return null;
  }

  const probs = probabilities.map((p) => p.prob);
  const maxProb = Math.max(...probs);
  const minProb = Math.min(...probs);
  const divergencePp = (maxProb - minProb) * 100;

  if (divergencePp > 8) {
    // Find the name of the outlier (the personality furthest from the median).
    const medianProb = (maxProb + minProb) / 2;
    const outlier = probabilities.reduce((worst, current) =>
      Math.abs(current.prob - medianProb) > Math.abs(worst.prob - medianProb) ? current : worst,
    );

    return {
      offender: outlier.name,
      message: `Updating min_probability would cause ${divergencePp.toFixed(1)}pp divergence across momentum_exhaustion personalities (max allowed: 8pp). Outlier: ${outlier.name}`,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Fastify plugin
// ---------------------------------------------------------------------------

/**
 * Fastify plugin for personality CRUD and performance read endpoints.
 *
 * Routes:
 *   GET  /api/personalities                — list all personalities (active only by default)
 *   GET  /api/personalities/:id            — fetch one personality
 *   PUT  /api/personalities/:id            — update params / active state
 *   GET  /api/personalities/:id/performance — aggregated trade stats for one personality
 *
 * This plugin expects to be registered with a prefix of '/api' in server.ts so
 * that the final mounted paths are /api/personalities/*.
 *
 * Security defaults:
 * - All DB queries use parameterised placeholders ($1, $2…) — never interpolate user input.
 * - UUIDs from URL params are passed as-is to parameterised queries; PostgreSQL will
 *   reject invalid UUIDs with a type error, which Fastify surfaces as a 500. Since
 *   this is a single-operator internal tool with no public auth, that is acceptable.
 *   A future hardening step could add a UUID-format regex to the route schema.
 * - The audit log is append-only INSERT — never UPDATE or DELETE.
 */
export const personalitiesRoutes: FastifyPluginAsync<PersonalitiesRoutesOptions> = async (
  fastify: FastifyInstance,
  opts: PersonalitiesRoutesOptions,
): Promise<void> => {
  // -------------------------------------------------------------------------
  // GET /personalities
  // -------------------------------------------------------------------------
  // By default returns only is_active = TRUE rows. With ?include_inactive=true
  // returns all 10 personalities regardless of active state.
  //
  // Why ORDER BY created_at?
  // Personalities were seeded in a fixed order (clockwork first, learners last).
  // Returning them in insertion order gives a stable, deterministic list on every
  // call — important for dashboard table rendering and test assertions.
  fastify.get(
    '/personalities',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            include_inactive: { type: 'string', enum: ['true', 'false'] },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, _reply) => {
      const query = request.query as { include_inactive?: string };
      // Only activate the "all rows" path when the caller explicitly sets the
      // flag to the string "true". Any other value (absent, "false") returns
      // active-only. Using a string enum (not boolean) in the schema because
      // HTTP query strings are always strings — AJV would reject a bare `true`.
      const includeInactive = query.include_inactive === 'true';

      let sql: string;
      const params: string[] = [];

      if (includeInactive) {
        sql = `
          SELECT id, name, display_name, group_type, entry_type,
                 management_style, is_frozen, is_active, phase, params,
                 created_at, updated_at
          FROM personality_configs
          ORDER BY created_at ASC
        `;
      } else {
        sql = `
          SELECT id, name, display_name, group_type, entry_type,
                 management_style, is_frozen, is_active, phase, params,
                 created_at, updated_at
          FROM personality_configs
          WHERE is_active = TRUE
          ORDER BY created_at ASC
        `;
      }

      const result = await opts.db.query<PersonalityRow>(
        sql,
        params.length > 0 ? params : undefined,
      );
      return result.rows.map(mapPersonality);
    },
  );

  // -------------------------------------------------------------------------
  // GET /personalities/:id
  // -------------------------------------------------------------------------
  fastify.get('/personalities/:id', {}, async (request, reply) => {
    const { id } = request.params as { id: string };

    const result = await opts.db.query<PersonalityRow>(
      `SELECT id, name, display_name, group_type, entry_type,
                management_style, is_frozen, is_active, phase, params,
                created_at, updated_at
         FROM personality_configs
         WHERE id = $1`,
      [id],
    );

    if (result.rows.length === 0) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: 'Personality not found' });
    }

    return mapPersonality(result.rows[0] as PersonalityRow);
  });

  // -------------------------------------------------------------------------
  // PUT /personalities/:id
  // -------------------------------------------------------------------------
  // Supports partial updates: caller may send any subset of { is_active, params, reason }.
  // Validation order (mirrors the project spec priority):
  //   1. Empty body → 400
  //   2. is_frozen check → 403 FROZEN_VIOLATION
  //   3. Comparison integrity check (only when params.min_probability is being changed) → 409
  //   4. Apply update + write audit log
  fastify.put(
    '/personalities/:id',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            is_active: { type: 'boolean' },
            params: { type: 'object' },
            reason: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        is_active?: boolean;
        params?: Record<string, unknown>;
        reason?: string;
      };

      // --- Validate: something must be present in the body ---
      // Reject an empty-object body (nothing to update) rather than executing
      // a no-op UPDATE that would write an audit log row with old_params === new_params.
      const hasIsActive = body.is_active !== undefined;
      const hasParams = body.params !== undefined;
      if (!hasIsActive && !hasParams) {
        return reply.code(400).send({
          error: 'EMPTY_UPDATE',
          message: 'Request body must include is_active or params',
        });
      }

      // --- Fetch current personality state ---
      // We need the current state before any write to:
      //   (a) check is_frozen
      //   (b) merge existing params with the incoming patch
      //   (c) write old_params to the audit log
      const current = await opts.db.query<PersonalityRow>(
        `SELECT id, name, display_name, group_type, entry_type,
                management_style, is_frozen, is_active, phase, params,
                created_at, updated_at
         FROM personality_configs
         WHERE id = $1`,
        [id],
      );

      if (current.rows.length === 0) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: 'Personality not found' });
      }

      const existing = current.rows[0] as PersonalityRow;

      // --- FROZEN_VIOLATION guard ---
      // Clockwork's is_frozen = TRUE is an immutable benchmark invariant.
      // The evolution engine throws FROZEN_VIOLATION on any attempted change;
      // the API must enforce the same contract so no code path can silently
      // bypass it. We check this before any write.
      if (existing.is_frozen) {
        return reply.code(403).send({
          error: 'FROZEN_VIOLATION',
          message: 'Clockwork parameters are immutable',
        });
      }

      // --- Compute merged params ---
      // Merge strategy: shallow Object.assign so the caller can update a single
      // key without having to resend the entire params object.
      // The caller sending { params: { min_probability: 0.72 } } will update
      // only min_probability; all other existing keys are preserved.
      const mergedParams: Record<string, unknown> = hasParams
        ? { ...existing.params, ...body.params }
        : existing.params;

      // --- Comparison integrity check ---
      // Only runs when params (specifically min_probability) is being changed,
      // because the check only applies to min_probability divergence.
      // Running it on every PUT (even is_active-only changes) would be wasted
      // DB work; we still run it when params is provided even if min_probability
      // is not in the payload, because a shallow merge might leave min_probability
      // at the existing value — the check will confirm that and pass quickly.
      if (hasParams) {
        const violation = await checkComparisonIntegrity(opts.db, id, mergedParams);
        if (violation !== null) {
          return reply.code(409).send({
            error: 'COMPARISON_INTEGRITY_VIOLATION',
            offender: violation.offender,
            message: violation.message,
          });
        }
      }

      // --- Apply update ---
      // COALESCE logic: if the caller did not include a field, keep the existing value.
      // We use a two-step approach: always set updated_at, conditionally update
      // params and is_active only when they are present in the request body.
      // This avoids accidentally overwriting params with the original value (which
      // would still write an audit log row with identical old/new params).
      const updateResult = await opts.db.query<PersonalityRow>(
        `UPDATE personality_configs
         SET
           params     = CASE WHEN $2 THEN $3::jsonb ELSE params END,
           is_active  = CASE WHEN $4 THEN $5 ELSE is_active END,
           updated_at = NOW()
         WHERE id = $1
         RETURNING id, name, display_name, group_type, entry_type,
                   management_style, is_frozen, is_active, phase, params,
                   created_at, updated_at`,
        [
          id,
          hasParams, // $2: whether to update params
          JSON.stringify(mergedParams), // $3: merged params JSON
          hasIsActive, // $4: whether to update is_active
          body.is_active ?? existing.is_active, // $5: new is_active value
        ],
      );

      const updated = updateResult.rows[0] as PersonalityRow;

      // --- Audit log ---
      // Append an immutable audit record AFTER the update so that old_params
      // reflects the true state before this change. The reason field captures
      // why the change was made (free-form string from the caller, or a default).
      await opts.db.query(
        `INSERT INTO personality_audit_log
           (personality_id, changed_by, old_params, new_params, reason)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)`,
        [
          id,
          'api',
          JSON.stringify(existing.params), // old_params: pre-update state
          JSON.stringify(mergedParams), // new_params: post-update state
          body.reason ?? 'api_update',
        ],
      );

      return mapPersonality(updated);
    },
  );

  // -------------------------------------------------------------------------
  // GET /personalities/:id/performance
  // -------------------------------------------------------------------------
  // Returns aggregated closed-trade stats for one personality from all time
  // (not date-filtered) plus a count of currently open positions.
  //
  // The SQL uses COUNT(*) FILTER (WHERE ...) to compute multiple aggregates in
  // a single pass, which is more efficient than multiple subqueries.
  //
  // COALESCE(..., 0) ensures SUM and AVG return 0 (not NULL) when the
  // personality has no closed trades — the API always returns a numeric value,
  // never null, for these stats.
  //
  // win_rate is computed in application code rather than SQL to avoid NUMERIC /
  // float precision issues in the division, and because the pg driver would
  // return a NUMERIC as a string requiring a parse step anyway.
  fastify.get('/personalities/:id/performance', {}, async (request, reply) => {
    const { id } = request.params as { id: string };

    // First verify the personality exists. A 404 on a missing personality is
    // more informative than a zero-stats response which could be mistaken for
    // "this personality has no trades yet".
    const existsResult = await opts.db.query<{ id: string }>(
      'SELECT id FROM personality_configs WHERE id = $1',
      [id],
    );

    if (existsResult.rows.length === 0) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: 'Personality not found' });
    }

    const statsResult = await opts.db.query<{
      total_trades: string; // COUNT returns bigint → string via pg
      total_net_pnl: string; // NUMERIC → string via pg type parser
      avg_net_pnl: string; // NUMERIC → string
      winning_trades: string; // COUNT → bigint → string
      open_trades: string; // COUNT → bigint → string
    }>(
      `SELECT
           COUNT(*) FILTER (WHERE status = 'closed')               AS total_trades,
           COALESCE(SUM(net_pnl) FILTER (WHERE status = 'closed'), 0) AS total_net_pnl,
           COALESCE(AVG(net_pnl) FILTER (WHERE status = 'closed'), 0) AS avg_net_pnl,
           COUNT(*) FILTER (WHERE status = 'closed' AND net_pnl > 0) AS winning_trades,
           COUNT(*) FILTER (WHERE status = 'open')                 AS open_trades
         FROM paper_trades
         WHERE personality_id = $1`,
      [id],
    );

    const stats = statsResult.rows[0] as {
      total_trades: string;
      total_net_pnl: string;
      avg_net_pnl: string;
      winning_trades: string;
      open_trades: string;
    };

    const totalTrades = Number(stats.total_trades);
    const winningTrades = Number(stats.winning_trades);

    // win_rate = winning / total; 0 when no closed trades exist to avoid
    // division by zero. Returns a fraction (e.g. 0.6 = 60%) — callers
    // multiply by 100 for display purposes.
    const winRate = totalTrades > 0 ? winningTrades / totalTrades : 0;

    return {
      personalityId: id,
      totalTrades,
      totalNetPnl: stats.total_net_pnl,
      avgNetPnl: stats.avg_net_pnl,
      winRate,
      openTrades: Number(stats.open_trades),
    };
  });
};
