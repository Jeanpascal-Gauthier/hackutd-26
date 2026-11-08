import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientEvent, ServerEvent } from "@firewatch/shared/events";
import type { IncidentState } from "@firewatch/shared/types";

const endpoint = new URL(import.meta.env.VITE_SERVER_URL ?? `${location.protocol}//${location.hostname}:8080`);
const HTTP_URL = endpoint.origin;
endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
const WS_URL = endpoint.origin;

interface LogEntry { id: number; time: number; message: string; kind: "info" | "report" | "action" }

export function useIncident() {
  const [state, setState] = useState<IncidentState | null>(null);
  const [connected, setConnected] = useState(false);
  const [mode, setMode] = useState<"mock" | "live" | "unknown">("unknown");
  const [log, setLog] = useState<LogEntry[]>([]);
  const socket = useRef<WebSocket | null>(null);
  const sequence = useRef(0);
  const addLog = useCallback((message: string, kind: LogEntry["kind"] = "info") => {
    const entry = { id: ++sequence.current, time: Date.now(), message, kind };
    setLog((entries) => [entry, ...entries].slice(0, 80));
  }, []);

  useEffect(() => {
    let disposed = false;
    let retry: ReturnType<typeof setTimeout>;
    let previous: IncidentState | null = null;
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
        addLog("Connected to incident server.");
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
          const next = event.state;
          if (previous) {
            const known = new Set(previous.reports.map((report) => report.id));
            for (const report of next.reports) if (!known.has(report.id)) addLog(`Report received from ${report.caller}${report.roomId ? ` · ${report.roomId}` : ""}.`, "report");
            if (next.simMinute < previous.simMinute) addLog(`Timeline moved back to minute ${next.simMinute}.`);
            if (previous.reports.length && next.reports.length === 0) addLog("Server report list cleared.");
            if (next.recommendation && JSON.stringify(next.recommendation) !== JSON.stringify(previous.recommendation)) addLog("New recommendation available for operator review.", "action");
            if (previous.recommendation && !next.recommendation) addLog("Pending recommendation cleared by server.", "action");
          } else addLog(`Incident state received · minute ${next.simMinute} · ${next.reports.length} reports.`);
          previous = next;
          setState(next);
        } catch { addLog("Ignored an unreadable server message."); }
      };
      ws.onerror = () => ws.close();
      ws.onclose = () => {
        if (disposed) return;
        setConnected(false);
        setMode("unknown");
        health?.abort();
        addLog("Connection lost. Reconnecting…");
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
  }, [addLog]);

  const send = useCallback((event: ClientEvent): boolean => {
    if (socket.current?.readyState !== WebSocket.OPEN) return false;
    try {
      socket.current.send(JSON.stringify(event));
      if (event.type === "acceptRecommendation") addLog("Operator requested recommendation acceptance.", "action");
      return true;
    } catch { return false; }
  }, [addLog]);

  const request = useCallback(async (path: string, body?: unknown) => {
    const response = await fetch(`${HTTP_URL}${path}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok || result.ok !== true) throw new Error(result.errors?.join("; ") ?? result.error ?? "Server could not complete the request.");
    return result;
  }, []);
  return { state, connected, mode, log, send, request };
}
