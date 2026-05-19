import 'dotenv/config';
import { createBrokerFeed } from './ingestion/brokers/index';

const simulate = process.env.SIMULATE === 'true';
console.log(`AI Trading Agent starting — mode: ${simulate ? 'simulation' : 'live'}`);

const feed = createBrokerFeed();

feed.onTick((tick) => {
  console.log(`[tick] ${tick.symbol} @ ${tick.ltp} (${new Date(tick.timestamp).toISOString()})`);
});

await feed.connect();
console.log('[feed] connected — receiving ticks');
