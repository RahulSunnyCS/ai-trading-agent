/**
 * useLegwiseValidate — debounced POST /api/backtest/legwise/validate as the builder's form
 * changes, so a schema problem shows beside its field before a credit is spent running it.
 * Mirrors useBacktestValidate (the YAML tab): 500ms debounce, and a response that arrives
 * after a newer edit is ignored.
 *
 * The endpoint is read-only and free: it only runs the Python schema over the JSON.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { apiPost } from '../lib/api';
import type { LegwiseStrategy } from '../types/legwise';
import { LEGWISE_API } from './useLegwise';

export const LEGWISE_VALIDATE_DEBOUNCE_MS = 500;

export interface LegwiseValidateState {
  /** `unknown` = the validator could not be reached; nothing is known about the strategy. */
  status: 'checking' | 'valid' | 'invalid' | 'unknown';
  /** The validator's lines, each "path: message" (e.g. "legs.1.stop_loss.percent: …"). */
  errors: string[];
  /** Why validation itself failed (network, proxy), or null. */
  error: string | null;
}

interface ValidateResponse {
  valid: boolean;
  errors: string[];
}

const CHECKING: LegwiseValidateState = { status: 'checking', errors: [], error: null };

export function useLegwiseValidate(strategy: LegwiseStrategy): LegwiseValidateState {
  // Keyed on the JSON, so a re-render with an equal strategy does not re-validate.
  const body = useMemo(() => JSON.stringify({ strategy }), [strategy]);
  const [state, setState] = useState<LegwiseValidateState>(CHECKING);
  const latest = useRef(0);

  useEffect(() => {
    const ticket = ++latest.current;
    // Keep the previous errors on screen while re-checking, so fields do not flicker.
    setState((prev) => ({ ...prev, status: 'checking' }));

    const timer = setTimeout(() => {
      void (async () => {
        // apiPost takes no AbortSignal; a stale response is dropped by the ticket check.
        const result = await apiPost<ValidateResponse>(
          `${LEGWISE_API}/validate`,
          JSON.parse(body) as unknown,
        );
        if (latest.current !== ticket) return;
        if (!result.ok) {
          setState({ status: 'unknown', errors: [], error: result.error });
          return;
        }
        const errors = Array.isArray(result.data.errors) ? result.data.errors : [];
        setState({
          status: result.data.valid ? 'valid' : 'invalid',
          errors: result.data.valid ? [] : errors,
          error: null,
        });
      })();
    }, LEGWISE_VALIDATE_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      // Invalidate an in-flight request when the strategy changes or the form unmounts.
      latest.current++;
    };
  }, [body]);

  return state;
}
