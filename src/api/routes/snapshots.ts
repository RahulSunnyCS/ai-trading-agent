import type { FastifyInstance } from 'fastify';
import { query } from '../../db/client';
import type { StraddleSnapshot } from '../../db/schema';

export async function snapshotRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/snapshots/latest', async (_req, reply) => {
    // Most recent snapshot per underlying
    const rows = await query<StraddleSnapshot>(
      `SELECT DISTINCT ON (underlying) *
         FROM straddle_snapshots
        ORDER BY underlying, time DESC`,
      [],
    );
    return reply.send(rows);
  });
}
