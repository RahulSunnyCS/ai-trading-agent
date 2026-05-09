import type { FastifyInstance } from 'fastify';
import { query } from '../../db/client';
import type { PersonalityConfig } from '../../db/schema';
import { FreezeBodySchema, ActivateBodySchema } from '../validators';

interface PersonalityWithStats extends PersonalityConfig {
  today_trades: number;
  today_pnl:    number;
}

export async function personalityRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/personalities', async (_req, reply) => {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await query<PersonalityWithStats>(
      `SELECT p.*,
              COALESCE(s.today_trades, 0) AS today_trades,
              COALESCE(s.today_pnl,    0) AS today_pnl
         FROM personality_configs p
         LEFT JOIN (
               SELECT personality_id,
                      COUNT(*)       AS today_trades,
                      SUM(net_pnl)   AS today_pnl
                 FROM paper_trades
                WHERE entry_time::date = $1
                  AND status = 'closed'
                GROUP BY personality_id
         ) s ON s.personality_id = p.id
        ORDER BY p.name`,
      [today],
    );
    return reply.send(rows);
  });

  fastify.get<{ Params: { id: string } }>('/api/personalities/:id', async (req, reply) => {
    const today = new Date().toISOString().slice(0, 10);
    const [row] = await query<PersonalityWithStats>(
      `SELECT p.*,
              COALESCE(s.today_trades, 0) AS today_trades,
              COALESCE(s.today_pnl,    0) AS today_pnl
         FROM personality_configs p
         LEFT JOIN (
               SELECT personality_id,
                      COUNT(*)       AS today_trades,
                      SUM(net_pnl)   AS today_pnl
                 FROM paper_trades
                WHERE entry_time::date = $1
                  AND status = 'closed'
                GROUP BY personality_id
         ) s ON s.personality_id = p.id
        WHERE p.id = $2`,
      [today, req.params.id],
    );
    if (!row) return reply.status(404).send({ error: 'Personality not found' });
    return reply.send(row);
  });

  fastify.post<{ Params: { id: string }; Body: { frozen: boolean } }>(
    '/api/personalities/:id/freeze',
    async (req, reply) => {
      const parsed = FreezeBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }

      const [existing] = await query<PersonalityConfig>(
        `SELECT id, name, is_frozen FROM personality_configs WHERE id = $1`,
        [req.params.id],
      );
      if (!existing) return reply.status(404).send({ error: 'Personality not found' });

      // Clockwork (always frozen) cannot be unfrozen
      if (existing.is_frozen && !parsed.data.frozen) {
        return reply.status(400).send({
          error: `Personality '${existing.name}' is permanently frozen and cannot be unfrozen`,
        });
      }

      const [updated] = await query<PersonalityConfig>(
        `UPDATE personality_configs SET is_frozen = $1 WHERE id = $2 RETURNING *`,
        [parsed.data.frozen, req.params.id],
      );
      return reply.send(updated);
    },
  );

  fastify.post<{ Params: { id: string }; Body: { active: boolean } }>(
    '/api/personalities/:id/activate',
    async (req, reply) => {
      const parsed = ActivateBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }

      const [updated] = await query<PersonalityConfig>(
        `UPDATE personality_configs SET is_active = $1 WHERE id = $2 RETURNING *`,
        [parsed.data.active, req.params.id],
      );
      if (!updated) return reply.status(404).send({ error: 'Personality not found' });
      return reply.send(updated);
    },
  );
}
