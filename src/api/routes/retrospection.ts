/**
 * retrospection.ts — REST API routes for EOD retrospection and evolution.
 *
 * Registers:
 *  GET  /retrospection                        — query retrospection results (filterable)
 *  POST /retrospection/trigger                — enqueue an EOD retrospection job manually
 *  GET  /retrospection/evolution/pending      — query pending (unapplied) parameter adjustments
 *  POST /retrospection/evolution/apply/:personalityId — apply a proposed adjustment (transactional)
 *
 * Security decisions:
 *  - All SQL uses parameterised queries ($1, $2, …). Query param values are
 *    never interpolated into SQL strings.
 *  - UUID inputs are validated with a regex pattern before they reach any query.
 *    Fastify JSON schema validation catches path-param format violations at the
 *    framework layer; manual regex checks guard query-string params.
 *  - The apply route uses a raw pg client (db.connect()) with explicit
 *    BEGIN/ROLLBACK/COMMIT so the SELECT FOR UPDATE lock and the subsequent
 *    writes are in the same connection and the same transaction. Using the pool
 *    helper withTransaction() is intentionally avoided here because this route
 *    needs per-step early rollback with specific error responses at each branch.
 *  - is_frozen is checked inside the transaction after acquiring the FOR UPDATE
 *    lock on personality_configs, preventing a TOCTOU race where another
 *    concurrent request freezes the personality between the lock-check and the
 *    UPDATE.
 *  - proposed_adjustments.min_probability is validated with Number.isFinite()
 *    before being written to personality_configs, preventing NaN / Infinity
 *    from silently corrupting numeric parameters.
 */

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { Pool } from 'pg';
import { Queue } from 'bullmq';

// ---------------------------------------------------------------------------
// Allowed values for the regime query param
// ---------------------------------------------------------------------------
const ALLOWED_REGIMES = new Set([
  'RANGING',
  'TRENDING_STRONG',
  'VOLATILE_REVERTING',
  'EVENT_DAY',
]);

// Regex for UUID format validation (8-4-4-4-12 hex).
// Used for personality_id query params and personalityId path param.
const UUID_PATTERN = /^[0-9a-fA-F-]{36}$/;

// Regex for YYYY-MM-DD date validation.
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// Plugin options
// ---------------------------------------------------------------------------

export interface RetrospectionPluginOptions {
  db: Pool;
  /**
   * Shared BullMQ Queue instance used by the /trigger endpoint to enqueue
   * EOD retrospection jobs. Passed in from the server so the same queue
   * instance (and Redis connection) is reused across requests.
   */
  eodQueue: Queue;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const retrospectionRoutes: FastifyPluginAsync<RetrospectionPluginOptions> = fp(
  async (fastify: FastifyInstance, opts: RetrospectionPluginOptions) => {
    // -------------------------------------------------------------------------
    // GET /retrospection
    // -------------------------------------------------------------------------
    // Optional query params:
    //   personality_id — UUID filter
    //   regime         — market regime enum filter
    //   from           — YYYY-MM-DD start date (trade_date >=)
    //   to             — YYYY-MM-DD end date (trade_date <=)
    //
    // Results are ordered by trade_date DESC and capped at 200 rows to prevent
    // unbounded full-table scans on retrospection_results.
    fastify.get('/retrospection', async (request, reply) => {
      const q = request.query as Record<string, string | undefined>;

      // Validate personality_id format if provided — reject early rather than
      // letting an invalid UUID reach the DB and produce a confusing pg error.
      if (q.personality_id !== undefined && !UUID_PATTERN.test(q.personality_id)) {
        return reply.code(400).send({ error: 'invalid_personality_id' });
      }

      // Validate regime against the known enum values.
      if (q.regime !== undefined && !ALLOWED_REGIMES.has(q.regime)) {
        return reply.code(400).send({ error: 'invalid_regime' });
      }

      // Build parameterised SQL dynamically: start with a sentinel WHERE 1=1
      // so we can append AND clauses unconditionally without tracking whether
      // a preceding condition has been added.
      const params: unknown[] = [];
      const conditions: string[] = [];

      if (q.personality_id !== undefined) {
        params.push(q.personality_id);
        conditions.push(`personality_id = $${params.length}`);
      }

      if (q.regime !== undefined) {
        params.push(q.regime);
        conditions.push(`market_regime = $${params.length}`);
      }

      if (q.from !== undefined) {
        if (!DATE_PATTERN.test(q.from)) {
          return reply.code(400).send({ error: 'invalid_from_date' });
        }
        params.push(q.from);
        conditions.push(`trade_date >= $${params.length}`);
      }

      if (q.to !== undefined) {
        if (!DATE_PATTERN.test(q.to)) {
          return reply.code(400).send({ error: 'invalid_to_date' });
        }
        params.push(q.to);
        conditions.push(`trade_date <= $${params.length}`);
      }

      const whereClause =
        conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const sql = `
        SELECT *
        FROM retrospection_results
        ${whereClause}
        ORDER BY trade_date DESC
        LIMIT 200
      `;

      try {
        const result = await opts.db.query(sql, params);
        return reply.send({ data: result.rows });
      } catch {
        return reply.code(500).send({ error: 'internal_error' });
      }
    });

    // -------------------------------------------------------------------------
    // POST /retrospection/trigger
    // -------------------------------------------------------------------------
    // Body: { trade_date: string (YYYY-MM-DD) }
    //
    // Enqueues an eod-retrospection job for the given date. Uses a deterministic
    // jobId ('manual-<date>') so that double-posting the same date is idempotent
    // at the BullMQ level — BullMQ deduplicates by jobId within a queue.
    fastify.post('/retrospection/trigger', async (request, reply) => {
      const body = request.body as Record<string, unknown> | null | undefined;
      const tradeDate = body?.trade_date;

      if (typeof tradeDate !== 'string' || !DATE_PATTERN.test(tradeDate)) {
        return reply.code(400).send({ error: 'invalid_trade_date' });
      }

      await opts.eodQueue.add(
        'eod-retrospection',
        { trade_date: tradeDate },
        // Deterministic jobId prevents duplicate jobs for the same date when
        // the endpoint is called more than once (e.g. accidental double-click).
        { jobId: `manual-${tradeDate}` },
      );

      return reply.code(202).send({ queued: true, trade_date: tradeDate });
    });

    // -------------------------------------------------------------------------
    // GET /retrospection/evolution/pending
    // -------------------------------------------------------------------------
    // Optional query param: personality_id (UUID)
    //
    // Returns rows from retrospection_results where proposed_adjustments is not
    // null and the adjustment has not yet been applied. This is the "approval
    // inbox" for the evolution engine.
    fastify.get('/retrospection/evolution/pending', async (request, reply) => {
      const q = request.query as Record<string, string | undefined>;

      if (q.personality_id !== undefined && !UUID_PATTERN.test(q.personality_id)) {
        return reply.code(400).send({ error: 'invalid_personality_id' });
      }

      const params: unknown[] = [];
      let personalityClause = '';

      if (q.personality_id !== undefined) {
        params.push(q.personality_id);
        personalityClause = `AND personality_id = $${params.length}`;
      }

      const sql = `
        SELECT *
        FROM retrospection_results
        WHERE proposed_adjustments IS NOT NULL
          AND adjustments_applied = FALSE
          ${personalityClause}
        ORDER BY created_at DESC
      `;

      try {
        const result = await opts.db.query(sql, params);
        return reply.send({ data: result.rows });
      } catch {
        return reply.code(500).send({ error: 'internal_error' });
      }
    });

    // -------------------------------------------------------------------------
    // POST /retrospection/evolution/apply/:personalityId
    // -------------------------------------------------------------------------
    // Path param: personalityId (UUID, validated by Fastify JSON schema below)
    // Body: { trade_date: string (YYYY-MM-DD) }
    //
    // Applies the proposed min_probability adjustment for the given personality
    // and trade_date. All mutations happen inside a single PostgreSQL transaction
    // with FOR UPDATE locks to prevent concurrent apply conflicts.
    fastify.post(
      '/retrospection/evolution/apply/:personalityId',
      {
        schema: {
          params: {
            type: 'object',
            required: ['personalityId'],
            properties: {
              // Fastify's AJV validates the path param pattern before the handler
              // runs — guards against malformed UUIDs without extra handler code.
              personalityId: {
                type: 'string',
                pattern: '^[0-9a-fA-F-]{36}$',
              },
            },
          },
        },
      },
      async (request, reply) => {
        const { personalityId } = request.params as { personalityId: string };

        const body = request.body as Record<string, unknown> | null | undefined;
        const tradeDate = body?.trade_date;

        if (typeof tradeDate !== 'string' || !DATE_PATTERN.test(tradeDate)) {
          return reply.code(400).send({ error: 'invalid_trade_date' });
        }

        // Use a raw pg client (not the pool helper) so that BEGIN/ROLLBACK/COMMIT
        // are on the same physical connection. Pool helpers that wrap withTransaction
        // acquire+release the connection internally; we need to hold it open across
        // the multiple query steps below.
        const client = await opts.db.connect();
        let released = false;

        try {
          await client.query('BEGIN');

          // Step 1: lock the retrospection_results row for this personality + date
          // that still has a pending adjustment. FOR UPDATE prevents concurrent
          // apply requests for the same row from both succeeding.
          const retroResult = await client.query<{
            id: string;
            personality_id: string;
            proposed_adjustments: Record<string, unknown> | null;
            adjustments_applied: boolean;
          }>(
            `SELECT id, personality_id, proposed_adjustments, adjustments_applied
             FROM retrospection_results
             WHERE personality_id = $1
               AND trade_date = $2
               AND adjustments_applied = FALSE
             FOR UPDATE`,
            [personalityId, tradeDate],
          );

          if (retroResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return reply.code(404).send({ error: 'no_pending_adjustment' });
          }

          // Non-null assertion: length === 0 guard above ensures rows[0] exists.
          // noUncheckedIndexedAccess requires the assertion even after the guard.
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          const retroRow = retroResult.rows[0]!;

          // Defensive check: adjustments_applied should be FALSE given the WHERE
          // clause above, but guard explicitly in case the FOR UPDATE races with
          // a concurrent commit that updates the row before we read it.
          if (retroRow.adjustments_applied === true) {
            await client.query('ROLLBACK');
            return reply.code(409).send({ error: 'already_applied' });
          }

          // Step 2: lock the personality_configs row.
          const personalityResult = await client.query<{
            id: string;
            name: string;
            is_frozen: boolean;
            params: Record<string, unknown>;
          }>(
            `SELECT id, name, is_frozen, params
             FROM personality_configs
             WHERE id = $1
             FOR UPDATE`,
            [personalityId],
          );

          if (personalityResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return reply.code(404).send({ error: 'personality_not_found' });
          }

          // Non-null assertion: length === 0 guard above ensures rows[0] exists.
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          const personalityRow = personalityResult.rows[0]!;

          // Frozen personalities must not be modified — this is the
          // FROZEN_VIOLATION guard from the project invariants. We check it
          // INSIDE the transaction after acquiring the FOR UPDATE lock so we
          // cannot race with a concurrent freeze operation.
          if (personalityRow.is_frozen === true) {
            await client.query('ROLLBACK');
            return reply.code(403).send({ error: 'FROZEN_VIOLATION' });
          }

          // Step 3: extract and validate the proposed min_probability value.
          // proposed_adjustments may be any JSON shape — guard defensively.
          const proposedValue =
            retroRow.proposed_adjustments?.min_probability;

          // Number.isFinite() rejects NaN, Infinity, -Infinity, strings, null,
          // and undefined — all of which would silently corrupt the parameter.
          if (!Number.isFinite(proposedValue)) {
            await client.query('ROLLBACK');
            return reply.code(422).send({ error: 'invalid_proposed_value' });
          }

          // TypeScript narrowing: after Number.isFinite we know it's a finite number.
          const minProbability = proposedValue as number;

          // Snapshot old params for the audit log before mutation.
          const oldParams = personalityRow.params;
          const newParams = { ...oldParams, min_probability: minProbability };

          // Step 4: update personality_configs with the new min_probability.
          // We use jsonb_set to update only the min_probability key inside the
          // params JSONB column — this avoids overwriting any keys that might
          // have been added since the adjustment was proposed.
          await client.query(
            `UPDATE personality_configs
             SET params = jsonb_set(params, '{min_probability}', to_json($2::float8)::jsonb),
                 last_evolved_at = NOW()
             WHERE id = $1`,
            [personalityId, minProbability],
          );

          // Step 5: write an audit log entry recording who changed what and why.
          // gen_random_uuid() is used for the audit row id (PostgreSQL built-in,
          // no uuid library import needed). changed_by is 'api-manual-apply' to
          // distinguish API-driven applies from automated evolution engine applies.
          await client.query(
            `INSERT INTO personality_audit_log
               (id, personality_id, changed_at, changed_by, old_params, new_params, reason)
             VALUES
               (gen_random_uuid(), $1, NOW(), 'api-manual-apply', $2::jsonb, $3::jsonb,
                'manual approval via API')`,
            [personalityId, JSON.stringify(oldParams), JSON.stringify(newParams)],
          );

          // Step 6: mark the retrospection_results row as applied so it no longer
          // appears in the /pending endpoint.
          await client.query(
            `UPDATE retrospection_results
             SET adjustments_applied = TRUE
             WHERE id = $1`,
            [retroRow.id],
          );

          await client.query('COMMIT');

          // Return the updated personality row to the caller.
          const updatedResult = await client.query(
            `SELECT id, name, display_name, group_type, entry_type,
                    management_style, is_frozen, is_active, phase, params,
                    last_evolved_at, created_at, updated_at
             FROM personality_configs
             WHERE id = $1`,
            [personalityId],
          );

          return reply.send(updatedResult.rows[0]);
        } catch (err) {
          // Roll back any partial transaction state before releasing the client.
          // We rethrow so Fastify's error handler returns a 500.
          await client.query('ROLLBACK');
          released = true;
          client.release();
          throw err;
        } finally {
          // Release the client back to the pool on the happy path. The catch
          // block handles release on the error path (before rethrowing), so we
          // guard with the `released` flag to avoid a double-release.
          if (!released) {
            client.release();
          }
        }
      },
    );
  },
);
