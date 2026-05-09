import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocketPlugin from '@fastify/websocket';

import { healthRoutes }        from './routes/health';
import { tradeRoutes }         from './routes/trades';
import { personalityRoutes }   from './routes/personalities';
import { signalRoutes }        from './routes/signals';
import { retrospectionRoutes } from './routes/retrospection';
import { statsRoutes }         from './routes/stats';
import { snapshotRoutes }      from './routes/snapshots';
import { registerLiveFeed }    from './ws/live-feed';

let server: FastifyInstance | null = null;

export async function buildApp(): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false });

  await fastify.register(cors, { origin: '*' });
  await fastify.register(websocketPlugin);

  await fastify.register(healthRoutes);
  await fastify.register(tradeRoutes);
  await fastify.register(personalityRoutes);
  await fastify.register(signalRoutes);
  await fastify.register(retrospectionRoutes);
  await fastify.register(statsRoutes);
  await fastify.register(snapshotRoutes);

  registerLiveFeed(fastify);

  return fastify;
}

export async function startApiServer(port = 3001): Promise<FastifyInstance> {
  server = await buildApp();
  await server.listen({ port, host: '0.0.0.0' });
  console.log(`[api] Server listening on :${port}`);
  return server;
}

export async function stopApiServer(): Promise<void> {
  if (server) {
    await server.close();
    server = null;
  }
}
