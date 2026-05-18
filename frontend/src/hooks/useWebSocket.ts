import { useEffect, useRef } from "react";
import { useTradingStore } from "../store/trading";

// The path /ws/ticks is proxied by Vite to ws://localhost:3000/ws/ticks in dev
const WS_URL = "/ws/ticks";
const RECONNECT_DELAY_MS = 3000;

export function useWebSocket(): void {
  const addStraddleTick = useTradingStore((s) => s.addStraddleTick);
  const setWsStatus = useTradingStore((s) => s.setWsStatus);

  // Refs let the reconnect closure always see the latest callbacks without
  // triggering a re-render cycle or re-effect on every store update
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const unmountedRef = useRef(false);

  useEffect(() => {
    unmountedRef.current = false;

    function connect(): void {
      if (unmountedRef.current) return;

      setWsStatus("connecting");

      // Use window.location to build an absolute ws:// URL at runtime so
      // this works whether the page is served from localhost or a deployed host
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${protocol}//${window.location.host}${WS_URL}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!unmountedRef.current) setWsStatus("connected");
      };

      ws.onmessage = (event: MessageEvent<string>) => {
        if (unmountedRef.current) return;
        try {
          const msg = JSON.parse(event.data) as { id: string; fields: Record<string, string> };
          const fields = msg.fields;
          if (fields?.straddleValue !== undefined) {
            addStraddleTick({
              time: Date.now(),
              value: Number.parseFloat(fields.straddleValue),
              roc: fields.roc != null ? Number.parseFloat(fields.roc) : null,
            });
          }
        } catch (err) {
          console.error("[useWebSocket] Failed to parse message", err);
        }
      };

      ws.onclose = () => {
        if (unmountedRef.current) return;
        setWsStatus("disconnected");
        // Schedule reconnect only if we haven't already unmounted
        reconnectTimerRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
      };

      ws.onerror = (err) => {
        // Log the error but do not crash — onclose fires next and triggers reconnect
        console.error("[useWebSocket] WebSocket error", err);
      };
    }

    connect();

    return () => {
      unmountedRef.current = true;
      if (reconnectTimerRef.current != null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current != null) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [addStraddleTick, setWsStatus]);
}
