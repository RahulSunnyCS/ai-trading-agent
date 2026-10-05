import type { Metadata } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google';

import '../index.css';

// Self-hosted at build time by next/font (no request to Google from the browser, no layout
// shift). Exposed as CSS variables that tailwind.config.ts's `sans` / `mono` families read.
const plexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
  display: 'swap',
});
const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'AI Trading Agent',
  description: 'Trading research and backtesting dashboard',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${plexSans.variable} ${plexMono.variable} font-sans`}
      suppressHydrationWarning
    >
      <body>{children}</body>
    </html>
  );
}
