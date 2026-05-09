import type { FastifyInstance } from 'fastify';
import { query } from '../../db/client';
import type { StraddleSignal } from '../../db/schema';
import { SignalQuerySchema } from '../validators';

export async function signalRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/signals', async (req, reply) => {
    const parsed = SignalQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const { underlying, date } = parsed.data;

    const conditions: string[] = [];
    const params: unknown[]    = [];
    let idx = 1;

    if (underlying) { conditions.push(`underlying = $${idx++}`); params.push(underlying); }
    if (date)       { conditions.push(`signal_time::date = $${idx++}`); params.push(date); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows  = await query<StraddleSignal>(
      `SELECT * FROM straddle_signals ${where} ORDER BY signal_time DESC LIMIT 200`,
      params,
    );
    return reply.send(rows);
  });
}
