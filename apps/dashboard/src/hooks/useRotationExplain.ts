/**
 * Data hooks for the rotation "Why this pick?" and "Does rank predict results?" widgets. Both are
 * read-only endpoints behind the Fastify proxy (`/api/backtest/legwise/rotation/*`); results are
 * written nightly, so neither polls.
 */

import type { RotationExplain, RotationIc, RotationListKey } from '../types/rotationExplain';
import { usePolledResource } from './usePolledResource';

const BASE = '/api/backtest/legwise/rotation';

function query(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const text = q.toString();
  return text ? `?${text}` : '';
}

/**
 * The breakdown of one list's picks on one day. `day` undefined asks for the server's default:
 * the latest recorded day, else the latest day that can be reconstructed.
 */
export function useRotationExplain(day: string | undefined, list: RotationListKey, top = 10) {
  return usePolledResource<RotationExplain>(
    `${BASE}/explain${query({ day, list, top: String(top) })}`,
  );
}

/** The daily rank correlation of the morning ranking with the day's results. */
export function useRotationIc(
  list: RotationListKey,
  mode: 'forward' | 'research',
  range: { from?: string | undefined; to?: string | undefined } = {},
) {
  return usePolledResource<RotationIc>(`${BASE}/ic${query({ list, mode, ...range })}`);
}
