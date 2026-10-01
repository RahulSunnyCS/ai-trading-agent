import type { Theme } from '../store/theme';

/**
 * Resolves Lightweight Charts colors from the live CSS design tokens, so charts
 * match whichever theme is active. Pass the current `theme` as a recompute key
 * (read it in a useEffect dep) — the values themselves are read from the
 * already-applied `.dark` class via getComputedStyle.
 *
 * Returned as `rgb()`/`rgba()`, never `hsl()`: Lightweight Charts 4.x's color
 * parser only understands rgb/rgba/hex/named colors, and throws "Cannot parse
 * color: hsl(...)" — which blanked every chart that used this theme.
 */
function hslChannelsToRgb(channels: string): [number, number, number] | null {
  const m = /^(-?[\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%$/.exec(channels);
  if (!m) return null;
  const h = (((Number(m[1]) % 360) + 360) % 360) / 360;
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number): number => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (u < 1 / 6) return p + (q - p) * 6 * u;
    if (u < 1 / 2) return q;
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
    return p;
  };
  const rgb = s === 0 ? [l, l, l] : [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)];
  return rgb.map((v) => Math.round(v * 255)) as [number, number, number];
}

function cssHsl(name: string, alpha?: number): string {
  if (typeof document === 'undefined') return '#888';
  const channels = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const rgb = channels ? hslChannelsToRgb(channels) : null;
  if (!rgb) return '#888';
  return alpha === undefined ? `rgb(${rgb.join(', ')})` : `rgba(${rgb.join(', ')}, ${alpha})`;
}

export interface ChartTheme {
  background: string;
  text: string;
  grid: string;
  border: string;
  primary: string;
  positive: string;
  negative: string;
  info: string;
  warning: string;
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
    info: cssHsl('--info'),
    warning: cssHsl('--warning'),
  };
}
