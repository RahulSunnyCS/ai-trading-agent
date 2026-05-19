import type { Config } from 'tailwindcss';

export default {
  // Scan only the frontend source tree — keeps Tailwind's JIT purge fast.
  content: ['./index.html', './src/frontend/**/*.{ts,tsx}'],
  theme: { extend: {} },
  plugins: [],
} satisfies Config;
