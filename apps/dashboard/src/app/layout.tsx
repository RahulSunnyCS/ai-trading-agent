import type { Metadata } from 'next';

import '../index.css';

export const metadata: Metadata = {
  title: 'AI Trading Agent',
  description: 'Trading research and backtesting dashboard',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
