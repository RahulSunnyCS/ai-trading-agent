// Minimal type declarations for fyers-api-v3 (no official @types package).
// Covers only the fyersDataSocket API used by this project.

declare module 'fyers-api-v3' {
  interface DataSocketInstance {
    FullMode: unknown;
    LiteMode:  unknown;
    connect():           void;
    close():             void;
    subscribe(symbols: string[], depth?: boolean, channel?: number): void;
    unsubscribe(symbols: string[], depth?: boolean, channel?: number): void;
    mode(modeFlag: unknown, channel?: number): void;
    autoreconnect(maxRetries?: number, delaySeconds?: number): void;
    isConnected(): boolean;
    on(event: string, handler: (...args: unknown[]) => void): void;
  }

  export const fyersDataSocket: {
    getInstance(
      accessToken: string,
      logPath?:    string,
      enableLogs?: boolean
    ): DataSocketInstance;
  };
}
