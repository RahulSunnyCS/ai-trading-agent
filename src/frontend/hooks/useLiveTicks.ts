/**
 * useLiveTicks — WebSocket hook for /ws/ticks
 *
 * Manages a single WebSocket connection to the live tick feed, tracks
 * connection status, maintains a bounded ring buffer of recent ticks,
 * and handles reconnection with exponential backoff + jitter.
 *
 * Designed to be React 18 StrictMode-safe: the cleanup path nullifies
 * the socket reference and detaches `onclose` BEFORE calling close(),
 * so teardown never arms a new reconnect cycle.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TickMessage, WsStraddleMessage } from '../types/trading.js';

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

/** A single point in the tick ring buffer. */
export interface TickPoint {
  /** Epoch milliseconds — convert to seconds when feeding lightweight-charts. */
  time: number;
  ltp: number;
}

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

/**
 * Snapshot of the latest straddle values received over the WebSocket.
 * Mirrors the fields of WsStraddleMessage but lives in the hook return
 * so consumers don't need to import the WS type directly.
 */
export interface StraddleSnapshot {
  straddleValue: number;
  atmStrike: number;
  cePrice: number;
  pePrice: number;
  timestamp: number; // epoch ms
  roc?: number;
  acceleration?: number;
}

export interface UseLiveTicksResult {
  /** Reflects the current WebSocket readyState in plain terms. */
  status: ConnectionStatus;
  /** The most-recently received ltp value, or null before the first tick. */
  latestLtp: number | null;
  /** Epoch ms timestamp of the latest tick, or null before the first tick. */
  latestTimestamp: number | null;
  /** Bounded ring buffer of recent ticks (oldest first). Max BUFFER_CAP entries. */
  ticks: readonly TickPoint[];
  /**
   * Latest straddle snapshot received via /ws/ticks, or null before the first
   * 'straddle' message arrives. Updates whenever the server pushes a new
   * straddle.values entry (approximately every 15 s).
   */
  latestStraddle: StraddleSnapshot | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of tick points retained in memory. */
const BUFFER_CAP = 300;

/**
 * Backoff base delay in milliseconds.
 * First retry = ~3 s (BASE_DELAY_MS * 2^0 + jitter), capped at MAX_DELAY_MS.
 */
const BASE_DELAY_MS = 3_000;
const MAX_DELAY_MS = 30_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the next reconnect delay using exponential backoff with jitter.
 *
 * Formula: min(BASE * 2^attempt, MAX) + random jitter up to 20% of the cap.
 * Jitter prevents reconnect storms when many clients reconnect simultaneously
 * after a server restart.
 *
 * @param attempt  0-based attempt index (0 = first retry after disconnect).
 */
function backoffMs(attempt: number): number {
  const exponential = BASE_DELAY_MS * 2 ** attempt;
  const capped = Math.min(exponential, MAX_DELAY_MS);
  // Add up to ±20% random jitter of the capped value.
  const jitter = capped * 0.2 * Math.random();
  return Math.round(capped + jitter);
}

/**
 * Build the WebSocket URL at runtime from window.location.
 *
 * We derive the scheme (ws/wss) from window.location.protocol rather than
 * hardcoding it so the hook works in both http (dev) and https (prod) contexts.
 * The Vite dev server proxies /ws to localhost:3000 with `ws: true`.
 */
function buildWsUrl(): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${window.location.host}/ws/ticks`;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useLiveTicks(): UseLiveTicksResult {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [latestLtp, setLatestLtp] = useState<number | null>(null);
  const [latestTimestamp, setLatestTimestamp] = useState<number | null>(null);
  const [ticks, setTicks] = useState<TickPoint[]>([]);
  const [latestStraddle, setLatestStraddle] = useState<StraddleSnapshot | null>(null);

  // `attemptRef` tracks the current reconnect attempt count so the backoff
  // callback always reads the latest value without needing it in the
  // dependency array of useCallback/useEffect.
  const attemptRef = useRef(0);

  // `timeoutRef` holds the pending reconnect timer so it can be cleared on
  // unmount — prevents a dangling timer firing after the component is gone.
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // `mountedRef` is set to false on unmount. The `connect` function checks
  // this before scheduling a reconnect so we never set state on an unmounted
  // component.
  const mountedRef = useRef(true);

  // `socketRef` holds a reference to the current WebSocket so it can be closed
  // on cleanup. We intentionally do NOT put the WebSocket in React state —
  // putting mutable browser objects in state causes unnecessary re-renders.
  const socketRef = useRef<WebSocket | null>(null);

  const connect = useCallback(() => {
    // Never open a socket if the component has been unmounted.
    if (!mountedRef.current) return;

    // Pause while the document is hidden (browser tab backgrounded).
    // We resume on the visibilitychange listener below — this prevents a
    // reconnect storm against a dead server when the user is not looking.
    if (document.hidden) return;

    setStatus('connecting');
    const url = buildWsUrl();
    const ws = new WebSocket(url);
    socketRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) {
        ws.close();
        return;
      }
      setStatus('connected');
      // Reset attempt counter on successful connection.
      attemptRef.current = 0;
    };

    ws.onmessage = (event: MessageEvent) => {
      if (!mountedRef.current) return;

      let msg: unknown;
      try {
        msg = JSON.parse(event.data as string) as unknown;
      } catch {
        // Ignore malformed frames — keep the connection alive.
        return;
      }

      // Narrow via the discriminated union; dispatch on `type`.
      // 'connected' messages are acknowledged by the server and intentionally
      // ignored here (status is already set in onopen).
      // Unknown types are silently dropped — this keeps the hook
      // backward-compatible if the server ever adds new message types.
      const typed = msg as TickMessage;

      if (typed.type === 'tick') {
        const { ltp, timestamp } = typed;

        setLatestLtp(ltp);
        setLatestTimestamp(timestamp);

        // Append to the ring buffer, dropping the oldest point when full.
        // We use a functional setState so the closure always sees the latest
        // array — avoids stale capture if the hook re-runs.
        setTicks((prev) => {
          const next: TickPoint[] =
            prev.length >= BUFFER_CAP
              ? // Slice from index 1 drops the oldest entry.
                [...prev.slice(1), { time: timestamp, ltp }]
              : [...prev, { time: timestamp, ltp }];
          return next;
        });
        return;
      }

      if (typed.type === 'straddle') {
        // Cast to the concrete straddle type — the discriminated union already
        // narrowed `type` to 'straddle', so this is safe and avoids importing
        // WsStraddleMessage into the component layer.
        const s = typed as import('../types/trading.js').WsStraddleMessage;
        setLatestStraddle({
          straddleValue: s.straddleValue,
          atmStrike: s.atmStrike,
          cePrice: s.cePrice,
          pePrice: s.pePrice,
          timestamp: s.timestamp,
          // Spread optional fields only when present to keep the snapshot lean.
          ...(s.roc !== undefined ? { roc: s.roc } : {}),
          ...(s.acceleration !== undefined ? { acceleration: s.acceleration } : {}),
        });
        return;
      }

      // All other types ('connected' and any future unknown types) are
      // intentionally ignored — backward compatibility is preserved.
    };

    ws.onerror = () => {
      // onerror always precedes onclose; no extra state needed here.
      // The reconnect logic lives entirely in onclose.
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setStatus('disconnected');
      scheduleReconnect();
    };
  }, []);
  // `connect` has no external deps; it reads refs for all mutable state.
  // Listing refs in deps is intentionally omitted — refs are stable objects.

  const scheduleReconnect = useCallback(() => {
    if (!mountedRef.current) return;

    const delay = backoffMs(attemptRef.current);
    attemptRef.current += 1;

    timeoutRef.current = setTimeout(() => {
      // Recheck both mounted and visibility after the delay expires.
      if (!mountedRef.current) return;
      connect();
    }, delay);
  }, [connect]);

  // Resume connecting when the tab becomes visible again.
  // If we are currently 'disconnected' (backoff paused because tab was hidden),
  // immediately try to reconnect so the user sees fresh data on tab focus.
  useEffect(() => {
    const handleVisibility = () => {
      if (!document.hidden && mountedRef.current && status === 'disconnected') {
        // Cancel any pending backoff timer and attempt immediately.
        if (timeoutRef.current !== null) {
          clearTimeout(timeoutRef.current);
          timeoutRef.current = null;
        }
        // Reset backoff so the user gets a prompt reconnect on tab focus.
        attemptRef.current = 0;
        connect();
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [connect, status]);

  // Primary effect: open the connection on mount, clean up on unmount.
  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      // Mark as unmounted BEFORE closing so onclose does not fire scheduleReconnect.
      mountedRef.current = false;

      // Cancel any pending reconnect timer.
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }

      // Detach onclose BEFORE calling close() — this is the StrictMode safety
      // guard. In React 18 StrictMode, effects are mounted → unmounted → remounted
      // in dev. Without detaching onclose first, the close() call triggered by
      // the first unmount would fire onclose, which calls scheduleReconnect, which
      // would then arm a timer that fires during the remount cycle and opens a
      // duplicate socket. Nullifying onclose prevents that.
      const ws = socketRef.current;
      if (ws !== null) {
        ws.onclose = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.close();
        socketRef.current = null;
      }
    };
  }, [connect]);

  return { status, latestLtp, latestTimestamp, ticks, latestStraddle };
}
