import type { Page } from 'playwright';
import type { Config } from '../config.js';

export type FailureKind =
  /** Stale or wrong TOTP. Safe to retry once with a fresh code. */
  | 'TOTP_REJECTED'
  /** Wrong password/PIN. Never retry - brokers lock the account. */
  | 'CREDENTIALS_REJECTED'
  /** Outside AlgoTest's 08:15-15:40 IST broker login window. Retry is pointless. */
  | 'LOGIN_WINDOW_CLOSED'
  /** Anything else, usually a selector that stopped matching. Retry once. */
  | 'UNKNOWN';

export class BrokerLoginError extends Error {
  constructor(
    message: string,
    readonly kind: FailureKind,
  ) {
    super(message);
    this.name = 'BrokerLoginError';
  }
}

export function isRetryable(kind: FailureKind): boolean {
  return kind === 'TOTP_REJECTED' || kind === 'UNKNOWN';
}

export interface Broker {
  /** Value accepted by the ONLY env var. */
  key: string;
  /** Display name used in the Telegram report. */
  name: string;
  /** Matches the broker's row on the My Brokers tab. */
  match: RegExp;
  /** The `Broker.<Name>` fragment inside this broker's data-broker attribute. */
  dataBrokerKey: string;
  /**
   * Performs the login. Called with the My Brokers tab open and the broker's row
   * confirmed present and logged out. Must throw BrokerLoginError on failure.
   */
  login(page: Page, config: Config): Promise<void>;
}

export type ResultStatus = 'OK' | 'SKIPPED' | 'FAIL';

export interface BrokerResult {
  name: string;
  status: ResultStatus;
  detail: string;
}
