import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type LiveBroker,
  type LivePlatform,
  captureCovers,
  parseLiveFile,
} from './live-capture-plan.js';

/**
 * BL-141 Phase 2: the evening uploaders delete a platform's finished strategies, and the
 * platform's per-strategy results with them, only once today's live capture
 * (`rotation/live/<day>.jsonl`, the 15:40 `live-capture` job) has read that platform.
 *
 * Until the capture has run once (no `rotation/live/` folder) nothing is held, so installing this
 * changes nothing before the job exists. After that a missing or failed capture holds every
 * delete of the evening and says why; the next evening deletes them once a capture covers it.
 */
export function captureGate(
  dataRoot: string,
  day: string,
  platform: LivePlatform,
  broker?: LiveBroker,
): { hold: boolean; why: string } {
  const dir = join(dataRoot, 'rotation', 'live');
  if (!existsSync(dir)) return { hold: false, why: 'the live capture has never run' };
  const path = join(dir, `${day}.jsonl`);
  const where = platform === 'algotest' ? 'AlgoTest' : `Quantiply · ${broker ?? '?'}`;
  if (!existsSync(path)) return { hold: true, why: `no live capture for ${day} yet` };
  let covered = false;
  try {
    covered = captureCovers(parseLiveFile(readFileSync(path, 'utf8')), platform, broker);
  } catch {
    covered = false;
  }
  return covered
    ? { hold: false, why: `${where} captured for ${day}` }
    : { hold: true, why: `the ${day} live capture has not read ${where}` };
}

/**
 * Hold the deletes, and the uploads that replace one of them under the same name (they would
 * clash with the strategy that stays). Returns what is held, by name.
 */
export function holdDeletes<D, U>(
  deletes: D[],
  uploads: U[],
  deleteName: (d: D) => string,
  uploadName: (u: U) => string,
): { deletes: D[]; uploads: U[]; held: string[]; heldUploads: string[] } {
  if (!deletes.length) return { deletes, uploads, held: [], heldUploads: [] };
  const names = new Set(deletes.map(deleteName));
  return {
    deletes: [],
    uploads: uploads.filter((u) => !names.has(uploadName(u))),
    held: [...names],
    heldUploads: uploads.filter((u) => names.has(uploadName(u))).map(uploadName),
  };
}

/** The message line for held deletes. */
export function heldLine(why: string, held: string[], heldUploads: string[]): string {
  const replace = heldUploads.length ? `; replacing ${heldUploads.join(', ')} waits too` : '';
  return `⏸ deletes held (${why}; BL-141 live capture): ${held.join(', ')}${replace}. They go on a later evening once the capture has read this platform`;
}
