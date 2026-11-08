import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientEvent, ServerEvent } from "@firewatch/shared/events";
import type { IncidentState } from "@firewatch/shared/types";

const endpoint = new URL(import.meta.env.VITE_SERVER_URL ?? `${location.protocol}//${location.hostname}:8080`);
const HTTP_URL = endpoint.origin;
endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
const WS_URL = endpoint.origin;

export function useIncident() {
  const [state, setState] = useState<IncidentState | null>(null);
  const [connected, setConnected] = useState(false);
  const [mode, setMode] = useState<"mock" | "live" | "unknown">("unknown");
  const socket = useRef<WebSocket | null>(null);

  useEffect(() => {
    let disposed = false;
    let retry: ReturnType<typeof setTimeout>;
    let attempts = 0;
    let health: AbortController | null = null;
    function connect() {
      if (disposed) return;
      const ws = new WebSocket(WS_URL);
      socket.current = ws;
      ws.onopen = () => {
        if (disposed) return;
        attempts = 0;
        setConnected(true);
        setMode("unknown");
        health?.abort();
        health = new AbortController();
        void fetch(`${HTTP_URL}/health`, { signal: AbortSignal.any([health.signal, AbortSignal.timeout(8000)]) })
          .then(async (response) => {
            if (!response.ok) throw new Error("Health check failed");
            const value = await response.json();
            if (!disposed && socket.current === ws && ws.readyState === WebSocket.OPEN) setMode(value.mock === true ? "mock" : "live");
          }).catch(() => { /* Socket state remains usable if the optional health check fails. */ });
      };
      ws.onmessage = (message) => {
        if (disposed) return;
        try {
          const event = JSON.parse(String(message.data)) as ServerEvent;
          if (event.type !== "state" || !event.state || !Array.isArray(event.state.rooms) || !Array.isArray(event.state.reports) || !Array.isArray(event.state.occupants) || !Number.isFinite(event.state.simMinute)) return;
          // Preserve the authoritative history and analysis supplied by all clients.
          setState(event.state);
        } catch { /* Ignore malformed messages and keep the last valid incident state. */ }
      };
      ws.onerror = () => ws.close();
      ws.onclose = () => {
        if (disposed) return;
        setConnected(false);
        setMode("unknown");
        health?.abort();
        retry = setTimeout(connect, Math.min(1000 * 2 ** attempts++, 10000));
      };
    }
    connect();
    return () => {
      disposed = true;
      clearTimeout(retry);
      health?.abort();
      const ws = socket.current;
      if (ws) {
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
        ws.close();
      }
      socket.current = null;
    };
  }, []);

  const send = useCallback((event: ClientEvent): boolean => {
    if (socket.current?.readyState !== WebSocket.OPEN) return false;
    try {
      socket.current.send(JSON.stringify(event));
      return true;
    } catch { return false; }
  }, []);

  const request = useCallback(async (path: string, body?: unknown) => {
    const response = await fetch(`${HTTP_URL}${path}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok || result.ok !== true) throw new Error(result.errors?.join("; ") ?? result.error ?? "Server could not complete the request.");
    return result;
  }, []);
  return { state, connected, mode, send, request };
}
