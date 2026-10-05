/**
 * useLiveTicks — WebSocket hook for /ws/ticks
 *
 * Manages a single WebSocket connection to the live tick feed, tracks
 * connection status, keeps bounded histories of recent index ticks and
 * straddle snapshots, and handles reconnection with exponential backoff + jitter.
 *
 * The histories live at module level, not in the component: they survive the
 * Live tab unmounting, so switching away and back shows the recent history
 * instead of an empty chart (the socket itself is still closed on unmount).
 * They last for the page session; a reload starts empty. The append rule is
 * `appendPoint` in lib/live.ts (unit-tested there).
 *
 * Only index ticks feed `latestLtp` / `ticks`: the socket also forwards India
 * VIX and the ATM option-leg ticks from the same Redis stream (`isIndexTick`).
 *
 * Designed to be React 18 StrictMode-safe: the cleanup path nullifies
 * the socket reference and detaches `onclose` BEFORE calling close(),
 * so teardown never arms a new reconnect cycle.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { TICK_BUFFER_CAP, appendPoint, isIndexTick } from '../lib/live';
import type { TickMessage, WsStraddleMessage } from '../types/trading';

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
  /** Percent change in straddle value since the previous snapshot. */
  roc?: number;
  /** This snapshot's ROC minus the previous one's, in percentage points. */
  acceleration?: number;
}

/** One straddle value in the history (for the sparkline). */
export interface StraddlePoint {
  /** Epoch milliseconds. */
  time: number;
  value: number;
}

export interface UseLiveTicksResult {
  /** Reflects the current WebSocket readyState in plain terms. */
  status: ConnectionStatus;
  /** The most-recently received index ltp, or null before the first index tick. */
  latestLtp: number | null;
  /** Epoch ms timestamp of the latest index tick, or null before the first one. */
  latestTimestamp: number | null;
  /** Bounded history of recent index ticks (oldest first). Max TICK_BUFFER_CAP entries. */
  ticks: readonly TickPoint[];
  /**
   * Latest straddle snapshot received via /ws/ticks, or null before the first
   * 'straddle' message arrives. Updates whenever the server pushes a new
   * straddle.values entry (approximately every 15 s).
   */
  latestStraddle: StraddleSnapshot | null;
  /** Bounded history of straddle values received this page session (oldest first). */
  straddles: readonly StraddlePoint[];
}

// ---------------------------------------------------------------------------
// Session history (module level: survives the component unmounting)
// ---------------------------------------------------------------------------

interface LiveHistory {
  ticks: readonly TickPoint[];
  straddles: readonly StraddlePoint[];
  latestStraddle: StraddleSnapshot | null;
}

const EMPTY_HISTORY: LiveHistory = { ticks: [], straddles: [], latestStraddle: null };

let history: LiveHistory = EMPTY_HISTORY;

/** Test seam: forget the session history. */
export function resetLiveHistory(): void {
  history = EMPTY_HISTORY;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Fold one parsed /ws/ticks frame into a history. Returns the same object when the frame
 * changes nothing (unknown type, a non-index tick, malformed numbers, an out-of-order point).
 * Exported for tests.
 */
export function applyFrame(prev: LiveHistory, msg: TickMessage): LiveHistory {
  if (msg.type === 'tick') {
    const ltp = asNumber(msg.ltp);
    const time = asNumber(msg.timestamp);
    if (ltp === null || time === null || !isIndexTick(msg.symbol)) return prev;
    const ticks = appendPoint(prev.ticks, { time, ltp }, TICK_BUFFER_CAP);
    return ticks === prev.ticks ? prev : { ...prev, ticks };
  }
  if (msg.type === 'straddle') {
    const s = msg as WsStraddleMessage;
    const value = asNumber(s.straddleValue);
    const time = asNumber(s.timestamp);
    if (value === null || time === null) return prev;
    const straddles = appendPoint(prev.straddles, { time, value }, TICK_BUFFER_CAP);
    if (straddles === prev.straddles) return prev;
    const roc = asNumber(s.roc);
    const acceleration = asNumber(s.acceleration);
    return {
      ...prev,
      straddles,
      latestStraddle: {
        straddleValue: value,
        atmStrike: s.atmStrike,
        cePrice: s.cePrice,
        pePrice: s.pePrice,
        timestamp: time,
        // Spread optional fields only when present to keep the snapshot lean.
        ...(roc !== null ? { roc } : {}),
        ...(acceleration !== null ? { acceleration } : {}),
      },
    };
  }
  // 'connected' and any future unknown types are ignored (backward compatible).
  return prev;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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
 * In development, NEXT_PUBLIC_WS_URL can point directly to Fastify because
 * Next's rewrite layer does not proxy WebSocket upgrades. Production can keep
 * the same-origin default when its reverse proxy forwards `/ws` to Fastify.
 */
function buildWsUrl(): string {
  const configured = process.env.NEXT_PUBLIC_WS_URL;
  if (configured) return configured;
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${window.location.host}/ws/ticks`;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useLiveTicks(): UseLiveTicksResult {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  // Starts from the session history, so a remount shows what arrived before it.
  const [live, setLive] = useState<LiveHistory>(() => history);

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

      // Fold the frame into the module-level history (it outlives this component), then
      // mirror it into state. Unknown types and non-index ticks leave it unchanged.
      if (typeof msg !== 'object' || msg === null) return;
      const next = applyFrame(history, msg as TickMessage);
      if (next === history) return;
      history = next;
      setLive(next);
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

  const lastTick = live.ticks[live.ticks.length - 1];
  return {
    status,
    latestLtp: lastTick?.ltp ?? null,
    latestTimestamp: lastTick?.time ?? null,
    ticks: live.ticks,
    latestStraddle: live.latestStraddle,
    straddles: live.straddles,
  };
}
