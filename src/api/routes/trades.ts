import type { FastifyInstance } from 'fastify';
import { query } from '../../db/client';
import type { PaperTrade } from '../../db/schema';
import { TradeQuerySchema } from '../validators';

export async function tradeRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/trades', async (req, reply) => {
    const parsed = TradeQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const { status, underlying, personality_id, date } = parsed.data;

    const conditions: string[] = [];
    const params: unknown[]    = [];
    let idx = 1;

    if (status)         { conditions.push(`status = $${idx++}`);         params.push(status); }
    if (underlying)     { conditions.push(`underlying = $${idx++}`);     params.push(underlying); }
    if (personality_id) { conditions.push(`personality_id = $${idx++}`); params.push(personality_id); }
    if (date)           { conditions.push(`entry_time::date = $${idx++}`); params.push(date); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows  = await query<PaperTrade>(
      `SELECT * FROM paper_trades ${where} ORDER BY entry_time DESC LIMIT 200`,
      params,
    );
    return reply.send(rows);
  });

  fastify.get<{ Params: { id: string } }>('/api/trades/:id', async (req, reply) => {
    const [trade] = await query<PaperTrade>(
      `SELECT * FROM paper_trades WHERE id = $1`,
      [req.params.id],
    );
    if (!trade) return reply.status(404).send({ error: 'Trade not found' });
    return reply.send(trade);
  });

  fastify.post<{ Params: { id: string } }>('/api/trades/:id/close', async (req, reply) => {
    const [existing] = await query<PaperTrade>(
      `SELECT id, status FROM paper_trades WHERE id = $1`,
      [req.params.id],
    );
    if (!existing) return reply.status(404).send({ error: 'Trade not found' });
    if (existing.status !== 'open') {
      return reply.status(409).send({ error: `Trade is already ${existing.status}` });
    }

    const [updated] = await query<PaperTrade>(
      `UPDATE paper_trades
          SET status = 'closed', exit_reason = 'MANUAL', exit_time = NOW()
        WHERE id = $1
        RETURNING *`,
      [req.params.id],
    );
    return reply.send(updated);
  });
}
