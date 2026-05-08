import type { Underlying, OptionType } from '../../db/schema';

// ── Normalized tick coming out of any broker adapter ──────────────────────────
export interface BrokerTick {
  symbol:      string;        // broker-native symbol string
  underlying:  Underlying;
  expiry?:     Date;
  strike?:     number;
  optionType?: OptionType;
  ltp:         number;        // last traded price (INR)
  bid?:        number;
  ask?:        number;
  volume?:     number;
  oi?:         number;
  timestamp:   Date;
}

// ── Instrument descriptor — what we want to subscribe to ──────────────────────
export interface Instrument {
  underlying:  Underlying;
  expiry:      Date;
  strike:      number;
  optionType:  OptionType;
}

// ── Common interface every broker adapter must satisfy ────────────────────────
export interface BrokerFeed {
  connect(): Promise<void>;
  disconnect(): void;
  subscribe(instruments: Instrument[]): void;
  unsubscribe(instruments: Instrument[]): void;
  onTick(handler: (tick: BrokerTick) => void): void;
  onConnect(handler: () => void): void;
  onDisconnect(handler: (reason: string) => void): void;
  onError(handler: (err: Error) => void): void;
}
