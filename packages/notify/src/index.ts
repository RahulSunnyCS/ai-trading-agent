/**
 * Outbound notifications, shared across every Node/Bun workspace.
 *
 * Owns the never-emit secret registry as well as the transport, because the
 * failure this package exists to prevent is "a credential left the process".
 * Log masking (registerSecret) and message redaction (redact) are the same
 * registry seen from two sides, so they live together.
 *
 * Python callers do not import this — they mirror the Notification shape.
 * See docs/architecture.md for why the boundary is the contract, not a service.
 */
export { send, sendText, istTimestamp } from './telegram.js';
export { registerSecret, redact } from './secrets.js';
export type { Action, Notification, Severity, TelegramConfig } from './types.js';
