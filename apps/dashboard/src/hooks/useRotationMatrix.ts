/**
 * Data hooks for Options Lab › Matrix: the Strategy Matrix over the rotation variants' stored
 * results and the journal's recorded picks. Read-only, behind the Fastify proxy
 * (/api/backtest/legwise/rotation/matrix*). Results are written nightly, so there is no poll.
 */

import { toQuery } from '../lib/rotationMatrixView';
import { useSlippageUrl } from '../store/rotationSlippage';
import type { MatrixCellDetail, MatrixResult } from '../types/rotationMatrix';
import { usePolledResource } from './usePolledResource';

const BASE = '/api/backtest/legwise/rotation/matrix';

/** One view of the matrix for the given request parameters (`matrixParams`). */
export function useRotationMatrix(
  params: Record<string, string>,
  options: { enabled?: boolean } = {},
) {
  return usePolledResource<MatrixResult>(useSlippageUrl(`${BASE}${toQuery(params)}`), {
    cache: true,
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
  });
}

/**
 * The daily values behind one cell (`cellParams`). It always fetches: mount the component that
 * calls it only while the drawer is open.
 */
export function useRotationMatrixCell(params: Record<string, string>) {
  return usePolledResource<MatrixCellDetail>(useSlippageUrl(`${BASE}/cell${toQuery(params)}`));
}
