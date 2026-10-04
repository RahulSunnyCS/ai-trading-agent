'use client';

import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { create } from 'zustand';

import { cn } from '../../lib/cn';

type ToastTone = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ToastState {
  toasts: ToastItem[];
  push: (toast: Omit<ToastItem, 'id'>) => number;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (toast) => {
    const id = nextId++;
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }));
    return id;
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
}));

/**
 * Show a short confirmation or failure from anywhere (no hook needed). It dismisses itself;
 * errors stay longer. Use it for the outcome of an action, not for page-level state.
 */
export function toast(message: string, tone: ToastTone = 'success'): void {
  const id = useToastStore.getState().push({ message, tone });
  if (typeof window !== 'undefined') {
    window.setTimeout(() => useToastStore.getState().dismiss(id), tone === 'error' ? 8000 : 4000);
  }
}

const ICONS = { success: CheckCircle2, error: AlertTriangle, info: Info } as const;
const TONES: Record<ToastTone, string> = {
  success: 'text-positive',
  error: 'text-negative',
  info: 'text-info',
};

/** Mounted once in the app shell. */
export function Toaster() {
  const toasts = useToastStore((state) => state.toasts);
  const dismiss = useToastStore((state) => state.dismiss);
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4 sm:inset-x-auto sm:right-4 sm:items-end"
    >
      {toasts.map((item) => {
        const Icon = ICONS[item.tone];
        return (
          <div
            key={item.id}
            role={item.tone === 'error' ? 'alert' : 'status'}
            className="pointer-events-auto flex w-full max-w-sm animate-fade-in items-start gap-2.5 rounded-lg border border-border bg-surface px-3.5 py-3 text-sm text-foreground shadow-elevated"
          >
            <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', TONES[item.tone])} />
            <span className="min-w-0 flex-1 break-words">{item.message}</span>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => dismiss(item.id)}
              className="rounded text-faint hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
