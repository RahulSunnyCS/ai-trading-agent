/**
 * Fyers Symbol Master — authoritative current-contract resolver.
 *
 * Why this exists:
 *   The instrument-registry encodes options deterministically from a weekday
 *   rule (NIFTY Tuesday, Sensex Thursday — see WEEKLY_EXPIRY_DOW). NSE/BSE
 *   have changed expiry weekdays before and will again, and individual
 *   weeks shift when the expiry day falls on a trading holiday. To catch
 *   such drift the moment it happens, this module loads the official Fyers
 *   symbol master and lets callers validate "is the symbol I just built a
 *   real listed contract?" — without taking the registry off the deterministic
 *   path that historical backfill depends on.
 *
 * Scope:
 *   - LIVE only. The master only contains CURRENT/FUTURE contracts;
 *     expired weeklies are purged. Historical backfill therefore relies on
 *     the registry's deterministic encoding, not this module.
 *
 * Implementation:
 *   - Downloads NSE_FO.csv and BSE_FO.csv from public.fyers.in.
 *   - On-disk cache (default data/sym_master/) with a 24h freshness check —
 *     the masters are large (~15 MB NSE + ~1 MB BSE) so we don't redownload
 *     on every process start.
 *   - In-memory: a Set<string> of listed option symbols for O(1) validation,
 *     plus a sorted per-underlying expiry list for resolveCurrentExpiry().
 *   - Fully testable via fetchFn / cacheDir / now injection — no real network
 *     or filesystem dependency from tests.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { Underlying } from './types';

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/**
 * Public Fyers symbol-master CSVs, one per exchange. These URLs are stable
 * and publicly hosted; they refresh nightly with the exchange's listed
 * derivative contracts (futures + options).
 */
export const DEFAULT_MASTER_SOURCES: Readonly<Record<'NSE' | 'BSE', string>> = {
  NSE: 'https://public.fyers.in/sym_details/NSE_FO.csv',
  BSE: 'https://public.fyers.in/sym_details/BSE_FO.csv',
};

/** 24-hour cache freshness — re-download once a day at most. */
export const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Default on-disk cache root (relative to process cwd). Gitignored. */
export const DEFAULT_CACHE_DIR = path.join('data', 'sym_master');

/**
 * Underlyings we care about. The master also lists FINNIFTY, MIDCPNIFTY, etc.
 * Order matters: longest prefix first so "BANKNIFTY" parses before "NIFTY".
 */
const RECOGNISED_UNDERLYINGS: readonly Underlying[] = ['BANKNIFTY', 'NIFTY', 'SENSEX'];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MasterOptionRow {
  /** Exact Fyers symbol, e.g. 'NSE:NIFTY2660223550CE'. */
  symbol: string;
  underlying: Underlying;
  /** Expiry calendar date at UTC midnight. */
  expiry: Date;
  strike: number;
  type: 'CE' | 'PE';
}

export interface SymbolMasterOptions {
  /** Override on-disk cache directory (default: data/sym_master/). */
  cacheDir?: string;
  /** Max age of a cached CSV before re-download (default: 24h). */
  maxAgeMs?: number;
  /**
   * Inject fetch for tests. Defaults to global fetch. Narrower than
   * `typeof fetch` on purpose — Node's runtime fetch type carries extras
   * like preconnect() that test mocks shouldn't have to satisfy.
   */
  fetchFn?: (url: string) => Promise<Response>;
  /** Inject clock (epoch ms) for tests. Defaults to Date.now. */
  now?: () => number;
  /** Override source URLs (test fixtures may use file:// or http://localhost). */
  sources?: Readonly<Record<'NSE' | 'BSE', string>>;
}

// ---------------------------------------------------------------------------
// CSV parser
// ---------------------------------------------------------------------------

/**
 * Split a single Fyers CSV row. The Fyers masters are simple comma-separated
 * values with no quoted fields in the columns we use (we only read positional
 * indices 1, 8, 9). A naive split is correct here and avoids a CSV dependency.
 */
function splitRow(row: string): string[] {
  return row.split(',');
}

/**
 * Parse one master CSV row into a MasterOptionRow, or null if the row is not
 * an option for one of the recognised underlyings (futures, indices, etc.
 * are skipped).
 *
 * Columns used:
 *   8 — expiry epoch (seconds since 1970)
 *   9 — Fyers symbol (e.g. 'NSE:NIFTY2660223550CE')
 */
function parseOptionRow(row: string): MasterOptionRow | null {
  const cols = splitRow(row);
  if (cols.length < 10) return null;

  const symbol = cols[9]?.trim();
  if (!symbol) return null;
  if (!(symbol.endsWith('CE') || symbol.endsWith('PE'))) return null;

  // Strip exchange prefix: "NSE:..." or "BSE:..."
  const colonIdx = symbol.indexOf(':');
  if (colonIdx < 0) return null;
  const tail = symbol.slice(colonIdx + 1);

  // Match the longest recognised underlying prefix.
  const underlying = RECOGNISED_UNDERLYINGS.find((u) => tail.startsWith(u));
  if (!underlying) return null;

  const type: 'CE' | 'PE' = symbol.endsWith('CE') ? 'CE' : 'PE';

  // Strike sits between the 5-char expiry encoding and the trailing 2-char type.
  // Fyers weekly/monthly expiry codes are always 5 chars (YY + month + DD).
  const afterUnderlying = tail.slice(underlying.length);
  const strikePart = afterUnderlying.slice(5, -2);
  const strike = Number.parseInt(strikePart, 10);
  if (!Number.isFinite(strike) || strike <= 0) return null;

  const expirySec = Number.parseInt(cols[8] ?? '', 10);
  if (!Number.isFinite(expirySec) || expirySec <= 0) return null;
  // Round the expiry to UTC midnight so equality comparisons against
  // calendar-date Dates from the registry work cleanly.
  const expiryDate = new Date(expirySec * 1000);
  const expiry = new Date(
    Date.UTC(expiryDate.getUTCFullYear(), expiryDate.getUTCMonth(), expiryDate.getUTCDate()),
  );

  return { symbol, underlying, expiry, strike, type };
}

// ---------------------------------------------------------------------------
// SymbolMaster class
// ---------------------------------------------------------------------------

export class SymbolMaster {
  private readonly cacheDir: string;
  private readonly maxAgeMs: number;
  private readonly fetchFn: (url: string) => Promise<Response>;
  private readonly now: () => number;
  private readonly sources: Readonly<Record<'NSE' | 'BSE', string>>;

  /** O(1) lookup: does Fyers currently list this exact symbol? */
  private listed: Set<string> = new Set();
  /** Per-underlying sorted unique expiry timestamps (ms) — for resolveCurrentExpiry. */
  private expiriesByUnderlying: Map<Underlying, number[]> = new Map();
  /** Dedupes concurrent load() calls so we never download twice in parallel. */
  private loadPromise: Promise<void> | null = null;

  constructor(opts: SymbolMasterOptions = {}) {
    this.cacheDir = opts.cacheDir ?? DEFAULT_CACHE_DIR;
    this.maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? Date.now;
    this.sources = opts.sources ?? DEFAULT_MASTER_SOURCES;
  }

  /**
   * Download (if stale) and parse both NSE and BSE masters. Safe to call
   * concurrently — subsequent callers reuse the in-flight load promise.
   */
  load(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.doLoad().catch((err) => {
      // Reset on failure so the next call retries instead of caching the error.
      this.loadPromise = null;
      throw err;
    });
    return this.loadPromise;
  }

  /** True iff `symbol` appears in the loaded master. Returns false until load() completes. */
  isSymbolListed(symbol: string): boolean {
    return this.listed.has(symbol);
  }

  /**
   * Smallest listed expiry date for `underlying` that is on or after `refDate`,
   * or null if none. Returned Date is UTC midnight (same convention as
   * instrument-registry.getCurrentExpiry).
   */
  resolveCurrentExpiry(underlying: Underlying, refDate: Date): Date | null {
    const list = this.expiriesByUnderlying.get(underlying);
    if (!list || list.length === 0) return null;
    const refMs = Date.UTC(refDate.getUTCFullYear(), refDate.getUTCMonth(), refDate.getUTCDate());
    // Sorted ascending — find the first >= refMs (linear is fine; tens of entries).
    for (const ms of list) {
      if (ms >= refMs) return new Date(ms);
    }
    return null;
  }

  /** Sorted ascending list of all listed expiry dates for the underlying. */
  getListedExpiries(underlying: Underlying): Date[] {
    const list = this.expiriesByUnderlying.get(underlying) ?? [];
    return list.map((ms) => new Date(ms));
  }

  // -------------------------------------------------------------------------

  private async doLoad(): Promise<void> {
    const csvByExchange = await this.loadCsvs();

    const listed = new Set<string>();
    const expirySets: Map<Underlying, Set<number>> = new Map();

    for (const csv of Object.values(csvByExchange)) {
      // The Fyers masters do not have a header row; every line is a contract.
      for (const line of csv.split(/\r?\n/)) {
        if (!line) continue;
        const row = parseOptionRow(line);
        if (!row) continue;
        listed.add(row.symbol);
        let set = expirySets.get(row.underlying);
        if (!set) {
          set = new Set();
          expirySets.set(row.underlying, set);
        }
        set.add(row.expiry.getTime());
      }
    }

    this.listed = listed;
    this.expiriesByUnderlying = new Map(
      [...expirySets.entries()].map(([u, s]) => [u, [...s].sort((a, b) => a - b)]),
    );
  }

  private async loadCsvs(): Promise<Record<'NSE' | 'BSE', string>> {
    await fs.mkdir(this.cacheDir, { recursive: true });
    const out: Partial<Record<'NSE' | 'BSE', string>> = {};
    for (const exchange of ['NSE', 'BSE'] as const) {
      out[exchange] = await this.loadOneCsv(exchange);
    }
    return out as Record<'NSE' | 'BSE', string>;
  }

  /**
   * Read a cached CSV from disk if fresh, otherwise download and rewrite.
   * Writes to a tmp file and renames atomically so a crash mid-download
   * never leaves a corrupt cache file.
   */
  private async loadOneCsv(exchange: 'NSE' | 'BSE'): Promise<string> {
    const cachePath = path.join(this.cacheDir, `${exchange}_FO.csv`);
    if (await this.isFresh(cachePath)) {
      return await fs.readFile(cachePath, 'utf8');
    }

    const url = this.sources[exchange];
    const res = await this.fetchFn(url);
    if (!res.ok) {
      throw new Error(
        `[SymbolMaster] failed to fetch ${exchange} master from ${url}: HTTP ${res.status}`,
      );
    }
    const text = await res.text();

    const tmpPath = `${cachePath}.tmp`;
    await fs.writeFile(tmpPath, text, 'utf8');
    await fs.rename(tmpPath, cachePath);
    return text;
  }

  private async isFresh(filePath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(filePath);
      return this.now() - stat.mtimeMs < this.maxAgeMs;
    } catch {
      // Missing / unreadable — treat as stale; loadOneCsv will download.
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Module singleton (production wiring uses this)
// ---------------------------------------------------------------------------

let _shared: SymbolMaster | null = null;

/**
 * Process-wide SymbolMaster. The first call creates it; subsequent calls
 * return the same instance so the parsed master is held in memory once.
 * Tests should construct SymbolMaster directly with their own injections
 * instead of using this singleton.
 */
export function getSymbolMaster(): SymbolMaster {
  if (!_shared) _shared = new SymbolMaster();
  return _shared;
}

/** For tests / lifecycle resets. */
export function resetSymbolMasterForTests(): void {
  _shared = null;
}
