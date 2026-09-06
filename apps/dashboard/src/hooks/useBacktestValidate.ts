/**
 * useBacktestValidate — debounced POST /api/backtest/validate as the user
 * edits the strategy YAML, so a syntax/schema error surfaces before they
 * spend a credit running it.
 *
 * Debounced (500ms) rather than fired on every keystroke — validation is a
 * real request to the Python service (via the Fastify proxy), not a local
 * computation.
 */

import { useEffect, useRef, useState } from 'react';

import { apiPost } from '../lib/api.js';
import type { ValidateResponse } from '../types/backtest.js';

const DEBOUNCE_MS = 500;

export interface BacktestValidateState {
  result: ValidateResponse | null;
  validating: boolean;
  error: string | null;
}

export function useBacktestValidate(yaml: string): BacktestValidateState {
  const [state, setState] = useState<BacktestValidateState>({
    result: null,
    validating: false,
    error: null,
  });

  const controllerRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);

    const trimmed = yaml.trim();
    if (trimmed === '') {
      setState({ result: null, validating: false, error: null });
      return;
    }

    setState((prev) => ({ ...prev, validating: true }));

    timerRef.current = setTimeout(() => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      void (async () => {
        // apiPost has no signal parameter (see lib/api.ts) — abort is only
        // used to ignore a stale response below, not to cancel the fetch
        // itself. A validate call is cheap and short-lived, so an in-flight
        // extra request is an acceptable cost for the simpler hook shape.
        const result = await apiPost<ValidateResponse>('/api/backtest/validate', { yaml: trimmed });
        if (controllerRef.current !== controller) return;
        if (!result.ok) {
          setState({ result: null, validating: false, error: result.error });
          return;
        }
        setState({ result: result.data, validating: false, error: null });
      })();
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [yaml]);

  return state;
}
