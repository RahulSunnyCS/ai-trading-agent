/**
 * The portfolio stop's setting (BL-092), kept in this browser. One value drives every Rotation
 * widget that shows stopped figures; it is a per-viewer convenience, never state anything else
 * reads. A failed read or write (private window, blocked storage) falls back to the default.
 */

import { useCallback, useState } from 'react';

import { DEFAULT_SETTING, type PortfolioStopSetting, parseStored } from '../lib/portfolioStop';

const KEY = 'ata.rotation.portfolioStop.v1';

function read(): PortfolioStopSetting {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw === null ? DEFAULT_SETTING : parseStored(JSON.parse(raw));
  } catch {
    return DEFAULT_SETTING;
  }
}

export function usePortfolioStop(): [PortfolioStopSetting, (next: PortfolioStopSetting) => void] {
  const [setting, setState] = useState<PortfolioStopSetting>(read);
  const set = useCallback((next: PortfolioStopSetting) => {
    setState(next);
    try {
      window.localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // the setting still applies for this visit
    }
  }, []);
  return [setting, set];
}
