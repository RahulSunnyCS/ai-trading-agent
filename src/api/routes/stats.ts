import type { FastifyInstance } from 'fastify';
import { query } from '../../db/client';
import type { MarketRegime } from '../../db/schema';

interface DayStats {
  date:             string;
  open_trades:      number;
  total_pnl_today:  number;
  best_personality: string | null;
  signals_today:    number;
  market_regime:    MarketRegime | null;
}

export async function statsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/stats', async (_req, reply) => {
    const today = new Date().toISOString().slice(0, 10);

    const [openResult, pnlResult, bestResult, signalsResult, regimeResult] = await Promise.all([
      query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM paper_trades WHERE status = 'open'`,
        [],
      ),
      query<{ total: string | null }>(
        `SELECT SUM(net_pnl) AS total FROM paper_trades WHERE entry_time::date = $1 AND status = 'closed'`,
        [today],
      ),
      query<{ name: string; pnl: string }>(
        `SELECT pc.name, SUM(pt.net_pnl) AS pnl
           FROM paper_trades pt
           JOIN personality_configs pc ON pc.id = pt.personality_id
          WHERE pt.entry_time::date = $1 AND pt.status = 'closed'
          GROUP BY pc.name
          ORDER BY pnl DESC
          LIMIT 1`,
        [today],
      ),
      query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM straddle_signals WHERE signal_time::date = $1`,
        [today],
      ),
      query<{ market_regime: MarketRegime }>(
        `SELECT market_regime FROM retrospection_results WHERE analysis_date = $1 LIMIT 1`,
        [today],
      ),
    ]);

    const stats: DayStats = {
      date:             today,
      open_trades:      parseInt(openResult[0]?.count ?? '0', 10),
      total_pnl_today:  parseFloat(pnlResult[0]?.total ?? '0'),
      best_personality: bestResult[0]?.name ?? null,
      signals_today:    parseInt(signalsResult[0]?.count ?? '0', 10),
      market_regime:    regimeResult[0]?.market_regime ?? null,
    };
    return reply.send(stats);
  });
}
