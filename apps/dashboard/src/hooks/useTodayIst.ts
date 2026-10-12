'use client';

import { useEffect, useState } from 'react';

import { todayIst } from '../lib/rotationMatrixDefault';

/** Today on the exchange's calendar, re-read every few minutes so a tab left open overnight moves on. */
export function useTodayIst(): string {
  const [today, setToday] = useState(() => todayIst());
  useEffect(() => {
    const id = setInterval(() => setToday(todayIst()), 5 * 60 * 1000);
    return () => clearInterval(id);
  }, []);
  return today;
}
