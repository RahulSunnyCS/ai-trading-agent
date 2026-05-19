declare module 'fyers-api-v3' {
  export class fyersDataSocket {
    constructor(config: { access_token: string; client_id: string });
    on(event: string, callback: (data: unknown) => void): void;
    subscribe(symbols: string[]): void;
    unsubscribe(symbols: string[]): void;
    connect(): void;
    close(): void;
  }
}
