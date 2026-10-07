import { useEffect, useState } from 'react';

/**
 * The current time, re-read every `intervalMs`. Null until mounted: the shell is rendered on
 * the server first, and a clock rendered there would not match the browser's.
 *
 * Every component that calls this re-renders on each tick, so keep a fast clock in a small
 * leaf (a badge, an "Updated 4s ago" line) rather than at the top of a view.
 */
export function useNow(intervalMs: number): Date | null {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
