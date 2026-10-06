# Dashboard design tokens

The dashboard's look is Direction B "Quant Studio" from `docs/dashboard-ui-review.md` §3.2
(chosen 2026-10-05, BL-013). This note says what each token is for, so a new component picks a
role instead of a colour. Values live in `apps/dashboard/src/index.css`; Tailwind names are
mapped in `apps/dashboard/tailwind.config.ts`.

## Rules

- Never write a hex or `rgb()` colour in a component. Use a token class (`bg-surface`,
  `text-muted`) or, for a chart library that needs a string, `lib/chartTheme.ts`.
- Colour carries meaning. Green and red mean profit and loss (or success and failure) and
  nothing else. The indigo accent is for the primary action and focus only.
- Opacity modifiers must be on Tailwind's scale (`/5`, `/10`, `/15`, `/20`, `/25`, `/30` …).
  `/8`, `/12`, `/14` compile to nothing; `lib/__tests__/tailwindClasses.test.ts` fails on them.
- Figures (money, percentages, counts in a table) are set in the mono face: use the `.metric`
  class or `<Td numeric>`.

## Tokens

| Token (Tailwind name) | Role |
|---|---|
| `background` | The page ground behind cards |
| `surface` | Cards, dialogs, inputs |
| `surface-2` | Inset areas: table headers, hover fills, code blocks, selected rows |
| `border` / `border-strong` | Default hairlines / emphasised or hovered edges |
| `foreground` | Primary text and values |
| `muted` | Secondary text: descriptions, units |
| `faint` | Labels, table headers, timestamps. Passes AA (4.5:1) on `background` and `surface` |
| `primary` / `primary-foreground` | Primary button, active navigation, focus ring (`ring`) |
| `positive` / `negative` | Profit / loss, success / failure |
| `warning` | Needs attention, stale, degraded |
| `info` | Neutral information, simulation mode |
| `accent` | A sixth badge tone when the five above are taken; use rarely |
| `series-1` … `series-4` | Chart series identity. Never profit/loss |

`--radius` is 8 px (`rounded-lg`); `rounded-xl` and `rounded-2xl` are 12 px and 16 px.
`shadow-card` is the resting card shadow, `shadow-elevated` is for dialogs and popovers.

## Type

IBM Plex Sans (body) and IBM Plex Mono (figures) are loaded by `next/font/local` in
`src/app/layout.tsx` from woff2 files committed under `src/app/fonts/` (latin subset; Sans
400/500/600/700, Mono 400/500/600; SIL OFL licences alongside). The build makes no network
request for fonts. They are exposed as `--font-sans` / `--font-mono` and read by Tailwind's
`font-sans` / `font-mono`. There is no serif face. `next/font/google` is not used: it fetched
CSS from fonts.googleapis.com at build time and failed intermittently in CI.

## Themes

`store/theme.ts` keeps a preference (`light`, `dark` or `system`) and the resolved theme. A
first-time visitor gets dark. Settings › Appearance sets the preference; the top-bar button
switches between light and dark.

## Charts

`lib/chartTheme.ts` reads the live tokens and returns `rgb()` strings (Lightweight Charts
cannot parse `hsl()`):

- `getChartTheme(theme)`: text, grid, border, surface, semantic colours and the body font.
- `getSeriesPalette(theme)` + `pickSeries(palette, i)`: series colours; a fifth series reuses
  the first colour.
- `seriesCssColor(i)`: the same colours as a CSS value for DOM swatches.
- `plotlyChrome(chartTheme)`: `font` and `hoverlabel` to spread into a Plotly layout.

`lib/__tests__/tokens.test.ts` checks the text tokens' contrast in both themes.
