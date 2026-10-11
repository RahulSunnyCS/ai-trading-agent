/**
 * The portfolio stop's setting (BL-095). One value drives every Rotation widget that shows
 * stopped figures. The committed setting lives in the URL query (`pfstop`, `pftrail`) so a copied
 * link or a refresh shows the same figures; this browser's last choice (localStorage) is the
 * fallback when the URL carries none. Storage is read after mount, never in the initial render,
 * so the server HTML and the first client render are both the default. A failed read or write
 * (private window, blocked storage) falls back to the default.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  DEFAULT_SETTING,
  type PortfolioStopSetting,
  fromQuery,
  parseStored,
  toQuery,
} from '../lib/portfolioStop';
import { useQueryState } from './useQueryState';

const KEY = 'ata.rotation.portfolioStop.v1';

function read(): PortfolioStopSetting | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw === null ? null : parseStored(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function usePortfolioStop(): [PortfolioStopSetting, (next: PortfolioStopSetting) => void] {
  const [urlStop, setUrlStop] = useQueryState('pfstop');
  const [urlTrail, setUrlTrail] = useQueryState('pftrail');
  const [stored, setStored] = useState<PortfolioStopSetting | null>(null);

  useEffect(() => {
    setStored(read());
  }, []);

  const set = useCallback(
    (next: PortfolioStopSetting) => {
      setStored(next);
      try {
        window.localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // the setting still applies for this visit
      }
      const q = toQuery(next);
      setUrlStop(q.pfstop);
      setUrlTrail(q.pftrail);
    },
    [setUrlStop, setUrlTrail],
  );

  const setting = useMemo(
    () => fromQuery(urlStop, urlTrail) ?? stored ?? DEFAULT_SETTING,
    [urlStop, urlTrail, stored],
  );
  return [setting, set];
}
