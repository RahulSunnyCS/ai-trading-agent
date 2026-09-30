declare module 'plotly.js-basic-dist-min' {
  export interface PlotlyBasic {
    react(
      element: HTMLElement,
      data: Array<Record<string, unknown>>,
      layout: Record<string, unknown>,
      config?: Record<string, unknown>,
    ): Promise<unknown>;
    purge(element: HTMLElement): void;
    Plots: { resize(element: HTMLElement): void };
  }

  const Plotly: PlotlyBasic;
  export default Plotly;
}
