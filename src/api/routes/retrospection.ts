import type { FastifyInstance } from 'fastify';
import { query } from '../../db/client';
import type { RetrospectionResult } from '../../db/schema';
import { applyEvolutionRules } from '../../trading/evolution-rules';
import { RetrospectionQuerySchema } from '../validators';

export async function retrospectionRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/retrospection', async (req, reply) => {
    const parsed = RetrospectionQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const { personality_id, date } = parsed.data;

    const conditions: string[] = [];
    const params: unknown[]    = [];
    let idx = 1;

    if (personality_id) { conditions.push(`personality_id = $${idx++}`); params.push(personality_id); }
    if (date)           { conditions.push(`analysis_date = $${idx++}`);  params.push(date); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows  = await query<RetrospectionResult>(
      `SELECT * FROM retrospection_results ${where} ORDER BY run_at DESC LIMIT 200`,
      params,
    );
    return reply.send(rows);
  });

  fastify.post<{ Params: { id: string } }>('/api/retrospection/:id/approve', async (req, reply) => {
    const [result] = await query<RetrospectionResult>(
      `SELECT * FROM retrospection_results WHERE id = $1`,
      [req.params.id],
    );
    if (!result) return reply.status(404).send({ error: 'Retrospection result not found' });
    if (result.applied) {
      return reply.status(409).send({ error: 'Evolution already applied for this result' });
    }

    try {
      await applyEvolutionRules(result.personality_id, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: msg });
    }

    const [updated] = await query<RetrospectionResult>(
      `UPDATE retrospection_results SET applied = TRUE, applied_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id],
    );
    return reply.send(updated);
  });
}
