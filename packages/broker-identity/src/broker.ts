/**
 * Canonical broker identifier, shared by apps/server (market data) and
 * packages/broker-login (AlgoTest OAuth automation).
 *
 * Named `finvasia`, not `shoonya` — Shoonya was Finvasia's old product name
 * and the broker itself, AlgoTest's UI, and packages/contract-notes all say
 * "Finvasia" today. packages/broker-login used to be the one holdout with
 * `shoonya` as its internal key; see that package's totp.ts and config.ts
 * for why the SHOONYA_* environment variable names stay as they are even
 * though the internal identifier changed.
 */
export type BrokerId = 'angelone' | 'finvasia';
