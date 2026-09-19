/**
 * The never-emit registry now lives in @trading/notify, so that the same
 * registry masking GitHub Actions logs also redacts anything sent outbound.
 * Re-exported here so local imports read naturally — `registerSecret` is a
 * secrets concern at the call site, not a notification one.
 */
export { registerSecret, redact } from '@trading/notify';
