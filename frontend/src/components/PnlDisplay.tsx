import { useTradingStore } from "../store/trading";

const WS_STATUS_DOT: Record<"connecting" | "connected" | "disconnected", string> = {
  connected: "bg-green-400",
  connecting: "bg-yellow-400",
  disconnected: "bg-red-400",
};

export default function PnlDisplay(): JSX.Element {
  const todayPnl = useTradingStore((s) => s.todayPnl);
  const wsStatus = useTradingStore((s) => s.wsStatus);

  const pnl = Number.parseFloat(todayPnl);
  const pnlIsPositive = pnl >= 0;

  return (
    <div className="flex items-center gap-6">
      <span className={`text-3xl font-bold ${pnlIsPositive ? "text-green-400" : "text-red-400"}`}>
        ₹{pnl.toFixed(2)}
      </span>
      <div className="flex items-center gap-2 text-sm text-slate-400">
        <span className={`inline-block w-2.5 h-2.5 rounded-full ${WS_STATUS_DOT[wsStatus]}`} />
        <span>{wsStatus}</span>
      </div>
    </div>
  );
}
