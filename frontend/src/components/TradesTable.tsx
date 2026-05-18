import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { type TradeRow, useTradingStore } from "../store/trading";

async function fetchSummary(): Promise<TradeRow[]> {
  const res = await fetch("/api/dashboard/summary");
  if (!res.ok) throw new Error(`Unexpected status ${res.status}`);
  return res.json() as Promise<TradeRow[]>;
}

export default function TradesTable(): JSX.Element {
  const setTrades = useTradingStore((s) => s.setTrades);

  const { data } = useQuery({
    queryKey: ["dashboard-summary"],
    queryFn: fetchSummary,
    refetchInterval: 10_000,
  });

  // Sync React Query result into the Zustand store so PnlDisplay and
  // other consumers can derive state from a single source of truth
  useEffect(() => {
    if (data !== undefined) setTrades(data);
  }, [data, setTrades]);

  const trades = useTradingStore((s) => s.openTrades);

  if (trades.length === 0) {
    return (
      <div className="bg-slate-800 text-slate-100 rounded-lg p-6 text-center text-slate-400">
        No trades today
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg">
      <table className="w-full bg-slate-800 text-slate-100 text-sm">
        <thead>
          <tr className="text-slate-400 border-b border-slate-700">
            <th className="text-left px-4 py-3">Entry Time</th>
            <th className="text-right px-4 py-3">Strike</th>
            <th className="text-right px-4 py-3">Entry Value</th>
            <th className="text-right px-4 py-3">Gross P&amp;L</th>
            <th className="text-right px-4 py-3">Net P&amp;L</th>
            <th className="text-center px-4 py-3">Status</th>
            <th className="text-left px-4 py-3">Exit Reason</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((trade) => (
            <tr
              key={trade.id}
              className="border-b border-slate-700 hover:bg-slate-700 transition-colors"
            >
              <td className="px-4 py-3 text-slate-300">{trade.entry_time}</td>
              <td className="px-4 py-3 text-right">{trade.atm_strike}</td>
              <td className="px-4 py-3 text-right">{trade.straddle_at_entry}</td>
              <td
                className={`px-4 py-3 text-right ${trade.gross_pnl != null && Number.parseFloat(trade.gross_pnl) >= 0 ? "text-green-400" : "text-red-400"}`}
              >
                {trade.gross_pnl ?? "—"}
              </td>
              <td
                className={`px-4 py-3 text-right ${trade.net_pnl != null && Number.parseFloat(trade.net_pnl) >= 0 ? "text-green-400" : "text-red-400"}`}
              >
                {trade.net_pnl ?? "—"}
              </td>
              <td className="px-4 py-3 text-center">
                <span
                  className={`px-2 py-1 rounded text-xs font-medium ${trade.status === "open" ? "bg-blue-900 text-blue-300" : "bg-slate-700 text-slate-400"}`}
                >
                  {trade.status}
                </span>
              </td>
              <td className="px-4 py-3 text-slate-400">{trade.exit_reason ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
