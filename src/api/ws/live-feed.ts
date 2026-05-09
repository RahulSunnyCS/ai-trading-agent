import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { query } from '../../db/client';
import type { PaperTrade, StraddleSnapshot } from '../../db/schema';

interface WsMessage {
  type: string;
  data: unknown;
  ts:   number;
}

function send(ws: WebSocket, type: string, data: unknown): void {
  if (ws.readyState !== ws.OPEN) return;
  const msg: WsMessage = { type, data, ts: Date.now() };
  ws.send(JSON.stringify(msg));
}

async function fetchOpenTrades(): Promise<PaperTrade[]> {
  return query<PaperTrade>(`SELECT * FROM paper_trades WHERE status = 'open' ORDER BY entry_time DESC`, []);
}

async function fetchLatestSnapshots(): Promise<StraddleSnapshot[]> {
  return query<StraddleSnapshot>(
    `SELECT DISTINCT ON (underlying) * FROM straddle_snapshots ORDER BY underlying, time DESC`,
    [],
  );
}

async function fetchPersonalityStats(): Promise<{ id: string; name: string; today_pnl: number; today_trades: number }[]> {
  const today = new Date().toISOString().slice(0, 10);
  return query(
    `SELECT pc.id, pc.name,
            COALESCE(s.today_trades, 0) AS today_trades,
            COALESCE(s.today_pnl,    0) AS today_pnl
       FROM personality_configs pc
       LEFT JOIN (
             SELECT personality_id,
                    COUNT(*)     AS today_trades,
                    SUM(net_pnl) AS today_pnl
               FROM paper_trades
              WHERE entry_time::date = $1 AND status = 'closed'
              GROUP BY personality_id
       ) s ON s.personality_id = pc.id`,
    [today],
  );
}

export function registerLiveFeed(fastify: FastifyInstance): void {
  fastify.get('/ws', { websocket: true }, (socket) => {
    // Send initial state immediately on connect
    void (async () => {
      const [trades, snapshots, stats] = await Promise.all([
        fetchOpenTrades(),
        fetchLatestSnapshots(),
        fetchPersonalityStats(),
      ]);
      send(socket, 'open_trades',       trades);
      send(socket, 'straddle_snapshot', snapshots);
      send(socket, 'personality_stats', stats);
    })();

    // Push open trades every 5s
    const tradeTimer = setInterval(() => {
      void fetchOpenTrades().then((trades) => send(socket, 'open_trades', trades));
    }, 5_000);

    // Push latest snapshots every 15s
    const snapshotTimer = setInterval(() => {
      void fetchLatestSnapshots().then((snaps) => send(socket, 'straddle_snapshot', snaps));
    }, 15_000);

    // Push personality stats every 30s
    const statsTimer = setInterval(() => {
      void fetchPersonalityStats().then((stats) => send(socket, 'personality_stats', stats));
    }, 30_000);

    socket.on('close', () => {
      clearInterval(tradeTimer);
      clearInterval(snapshotTimer);
      clearInterval(statsTimer);
    });
  });
}
