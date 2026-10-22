/**
 * The portfolio stop's setting (BL-095), one per card: Adaptive Classic (Core, `CORE_STOP_KEYS`,
 * which every other Rotation widget that shows stopped figures follows) and Adaptive Tuned (T1,
 * `T1_STOP_KEYS`). The committed setting lives in the URL query (`pfstop` / `pftrail`, or
 * `pfstop_t1` / `pftrail_t1`) so a copied link or a refresh shows the same figures; this browser's
 * last choice (localStorage, one key per card) is the fallback when the URL carries none. Storage
 * is read after mount, never in the initial render, so the server HTML and the first client
 * render are both the default. A failed read or write (private window, blocked storage) falls
 * back to the default.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  CORE_STOP_KEYS,
  type PortfolioStopKeys,
  type PortfolioStopSetting,
  fromQuery,
  parseStored,
  toQuery,
} from '../lib/portfolioStop';
import { useQueryState } from './useQueryState';

function read(keys: PortfolioStopKeys): PortfolioStopSetting | null {
  try {
    const raw = window.localStorage.getItem(keys.storageKey);
    return raw === null ? null : parseStored(JSON.parse(raw), keys.defaults);
  } catch {
    return null;
  }
}

export function usePortfolioStop(
  keys: PortfolioStopKeys = CORE_STOP_KEYS,
): [PortfolioStopSetting, (next: PortfolioStopSetting) => void] {
  const [urlStop, setUrlStop] = useQueryState(keys.stopParam);
  const [urlTrail, setUrlTrail] = useQueryState(keys.trailParam);
  const [stored, setStored] = useState<PortfolioStopSetting | null>(null);

  useEffect(() => {
    setStored(read(keys));
  }, [keys]);

  const set = useCallback(
    (next: PortfolioStopSetting) => {
      setStored(next);
      try {
        window.localStorage.setItem(keys.storageKey, JSON.stringify(next));
      } catch {
        // the setting still applies for this visit
      }
      const q = toQuery(next, keys.defaults);
      setUrlStop(q.pfstop);
      setUrlTrail(q.pftrail);
    },
    [keys, setUrlStop, setUrlTrail],
  );

  const setting = useMemo(
    () => fromQuery(urlStop, urlTrail, keys.defaults) ?? stored ?? keys.defaults,
    [urlStop, urlTrail, stored, keys],
  );
  return [setting, set];
}
