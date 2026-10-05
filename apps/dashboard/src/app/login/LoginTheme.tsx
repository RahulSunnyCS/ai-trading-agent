'use client';

import { type ReactNode, useEffect } from 'react';

import { hydrateThemeFromStorage, useThemeStore } from '../../store/theme';

/**
 * Applies the visitor's stored theme to the login page, which renders outside the app shell
 * that normally does it. The wrapper carries `.dark` itself so the page is dark before (and
 * without) JavaScript, matching the dashboard's default.
 */
export function LoginTheme({ children }: { children: ReactNode }) {
  const theme = useThemeStore((state) => state.theme);
  useEffect(() => {
    hydrateThemeFromStorage();
  }, []);
  return (
    <div className={theme === 'dark' ? 'dark' : undefined}>
      <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10 text-foreground">
        {children}
      </div>
    </div>
  );
}
