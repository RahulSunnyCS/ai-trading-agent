// NSE market hours: 09:15 – 15:30 IST (UTC+5:30)
// Extracted from index.ts so it can be unit-tested independently.

export function isMarketHours(now: Date = new Date()): boolean {
  const istOffset  = 5.5 * 60;
  const istMinutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + istOffset) % (24 * 60);
  return istMinutes >= 9 * 60 + 15 && istMinutes <= 15 * 60 + 30;
}
