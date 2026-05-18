import { type IChartApi, type ISeriesApi, type LineData, createChart } from "lightweight-charts";
import { useEffect, useRef } from "react";
import { useTradingStore } from "../store/trading";

export default function StraddleChart(): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  // Refs hold chart/series instances so effect cleanup and update callbacks
  // can access them without triggering re-renders
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);

  const straddleHistory = useTradingStore((s) => s.straddleHistory);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      width: 800,
      height: 300,
      layout: {
        background: { color: "#0f172a" },
        textColor: "#e2e8f0",
      },
    });

    const lineSeries = chart.addLineSeries();
    chartRef.current = chart;
    seriesRef.current = lineSeries;

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!seriesRef.current) return;

    // Lightweight Charts requires time values in ascending order and as UTC seconds
    const data: LineData[] = straddleHistory.map((t) => ({
      time: (t.time / 1000) as LineData["time"],
      value: t.value,
    }));

    seriesRef.current.setData(data);
  }, [straddleHistory]);

  return <div ref={containerRef} className="rounded-lg overflow-hidden" />;
}
