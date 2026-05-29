import type { Theme } from '../store/theme';

/**
 * Resolves Lightweight Charts colors from the live CSS design tokens, so charts
 * match whichever theme is active. Pass the current `theme` as a recompute key
 * (read it in a useEffect dep) — the values themselves are read from the
 * already-applied `.dark` class via getComputedStyle.
 */
function cssHsl(name: string, alpha?: number): string {
  if (typeof document === 'undefined') return '#888';
  const channels = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!channels) return '#888';
  return alpha === undefined ? `hsl(${channels})` : `hsl(${channels} / ${alpha})`;
}

export interface ChartTheme {
  background: string;
  text: string;
  grid: string;
  border: string;
  primary: string;
  positive: string;
  negative: string;
}

// The `theme` argument is intentionally unused at runtime — it exists so callers
// recompute (and re-read the CSS vars) whenever the active theme changes.
export function getChartTheme(theme: Theme): ChartTheme {
  void theme;
  return {
    background: 'transparent',
    text: cssHsl('--muted'),
    grid: cssHsl('--border', 0.5),
    border: cssHsl('--border'),
    primary: cssHsl('--primary'),
    positive: cssHsl('--positive'),
    negative: cssHsl('--negative'),
  };
}
