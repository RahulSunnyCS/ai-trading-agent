import { create } from "zustand";

export interface StraddleTick {
  time: number;
  value: number;
  roc: number | null;
}

export interface TradeRow {
  id: string;
  entry_time: string;
  atm_strike: number;
  straddle_at_entry: string;
  gross_pnl: string | null;
  net_pnl: string | null;
  status: string;
  exit_reason: string | null;
}

interface TradingState {
  straddleHistory: StraddleTick[];
  openTrades: TradeRow[];
  todayPnl: string;
  wsStatus: "connecting" | "connected" | "disconnected";
  addStraddleTick: (tick: StraddleTick) => void;
  setTrades: (trades: TradeRow[]) => void;
  updatePnl: (pnl: string) => void;
  setWsStatus: (status: TradingState["wsStatus"]) => void;
}

export const useTradingStore = create<TradingState>((set) => ({
  straddleHistory: [],
  openTrades: [],
  todayPnl: "0",
  wsStatus: "disconnected",

  addStraddleTick: (tick) =>
    set((state) => ({
      // Keep only the last 100 ticks to bound memory usage on a long-running dashboard
      straddleHistory: [...state.straddleHistory, tick].slice(-100),
    })),

  setTrades: (trades) => set({ openTrades: trades }),

  updatePnl: (pnl) => set({ todayPnl: pnl }),

  setWsStatus: (status) => set({ wsStatus: status }),
}));
