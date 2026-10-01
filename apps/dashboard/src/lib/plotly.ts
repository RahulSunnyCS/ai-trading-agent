/**
 * One lazy loader for Plotly's basic bundle (~1 MB), shared by every chart that needs it.
 * The dynamic import keeps it out of the main bundle; the module cache makes later calls free.
 *
 * (components/momentum/*Chart.tsx still import it inline — they predate this and were left
 * alone to keep that change out of the Options Lab work; point them here when next touched.)
 */

export type PlotlyBasic = typeof import('plotly.js-basic-dist-min').default;

export async function loadPlotly(): Promise<PlotlyBasic> {
  const loaded = await import('plotly.js-basic-dist-min');
  return loaded.default;
}
