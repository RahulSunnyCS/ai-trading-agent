/** Fyers resets every access token at 06:00 IST, whatever `expires_in` says. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const RESET_HOUR_IST = 6;
const DAY_MS = 86_400_000;

/**
 * When a Fyers token minted at `issuedAt` really stops working: the next 06:00 IST reset,
 * or earlier if Fyers states a shorter `expiresInSec`. A 3 pm login is good for about 15
 * hours, not 24. The Python mirror is `fyers.token_expiry` in packages/momentum-backtesting.
 */
export function fyersTokenExpiry(issuedAt: Date, expiresInSec?: number | null): Date {
  const istMs = issuedAt.getTime() + IST_OFFSET_MS;
  let resetIst = Math.floor(istMs / DAY_MS) * DAY_MS + RESET_HOUR_IST * 3_600_000;
  if (resetIst <= istMs) resetIst += DAY_MS;
  let expiryMs = resetIst - IST_OFFSET_MS;
  if (expiresInSec && expiresInSec > 0) {
    expiryMs = Math.min(expiryMs, issuedAt.getTime() + expiresInSec * 1000);
  }
  return new Date(expiryMs);
}
