import FyersLogin from "./components/FyersLogin";
import PnlDisplay from "./components/PnlDisplay";
import StraddleChart from "./components/StraddleChart";
import TradesTable from "./components/TradesTable";
import { useWebSocket } from "./hooks/useWebSocket";

export function App(): JSX.Element {
  useWebSocket();

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-slate-100">
          AI Trading Agent — Paper Trading Dashboard
        </h1>
      </header>
      <div className="mb-6">
        <FyersLogin />
      </div>
      <div className="mb-6">
        <PnlDisplay />
      </div>
      <div className="mb-6">
        <StraddleChart />
      </div>
      <div>
        <TradesTable />
      </div>
    </div>
  );
}
