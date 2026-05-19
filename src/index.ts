import 'dotenv/config';

// Entry point — branches on SIMULATE env var
// Full implementation in Milestone 1 (T-12 / T-21)
const simulate = process.env.SIMULATE === 'true';
console.log(`AI Trading Agent starting — mode: ${simulate ? 'simulation' : 'live'}`);
