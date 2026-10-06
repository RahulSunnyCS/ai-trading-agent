import type { Metadata } from 'next';
import localFont from 'next/font/local';

import '../index.css';

// Self-hosted woff2 files committed under ./fonts (see its README), so the build never fetches
// from fonts.googleapis.com. Exposed as CSS variables that tailwind.config.ts's `sans` / `mono`
// families read.
const plexSans = localFont({
  src: [
    { path: './fonts/ibm-plex-sans-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: './fonts/ibm-plex-sans-latin-500-normal.woff2', weight: '500', style: 'normal' },
    { path: './fonts/ibm-plex-sans-latin-600-normal.woff2', weight: '600', style: 'normal' },
    { path: './fonts/ibm-plex-sans-latin-700-normal.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-sans',
  display: 'swap',
});
const plexMono = localFont({
  src: [
    { path: './fonts/ibm-plex-mono-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: './fonts/ibm-plex-mono-latin-500-normal.woff2', weight: '500', style: 'normal' },
    { path: './fonts/ibm-plex-mono-latin-600-normal.woff2', weight: '600', style: 'normal' },
  ],
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
