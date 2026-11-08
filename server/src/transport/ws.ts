// WebSocket layer: full state on connect, then full state after store changes, coalesced so a
// burst of patches (a crash forecast can carry 500 segments) goes out as one message.
import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { ServerEvent } from "@firewatch/shared/events";
import type { IncidentState } from "@firewatch/shared/types";
import { applyClientEvent, parseClientEvent, type ActionHooks } from "../state/actions.ts";
import type { IncidentStore } from "../state/store.ts";

export const DEFAULT_BROADCAST_MS = 100;

export function attachWebSocket(httpServer: Server, store: IncidentStore, hooks: ActionHooks, options: { broadcastMs?: number } = {}) {
  const broadcastMs = options.broadcastMs ?? DEFAULT_BROADCAST_MS;
  const wss = new WebSocketServer({ server: httpServer });
  // What each client last received. State objects are replaced on every change, so identity is enough.
  const delivered = new WeakMap<WebSocket, IncidentState>();
  const encode = (state: IncidentState) => JSON.stringify({ type: "state", state } satisfies ServerEvent);
  const deliver = (ws: WebSocket, state: IncidentState, text: string) => {
    if (ws.readyState !== ws.OPEN || delivered.get(ws) === state) return;
    ws.send(text);
    delivered.set(ws, state);
  };

  let timer: NodeJS.Timeout | undefined;
  const flush = () => {
    timer = undefined;
    if (!wss.clients.size) return;
    const state = store.get();
    const text = encode(state);
    for (const client of wss.clients) deliver(client, state, text);
  };
  store.subscribe(() => {
    if (broadcastMs <= 0) return flush();
    if (timer) return;
    timer = setTimeout(flush, broadcastMs); // trailing edge: flush reads the latest state
    timer.unref();
  });
  httpServer.on("close", () => clearTimeout(timer));

  wss.on("connection", (ws) => {
    const state = store.get();
    deliver(ws, state, encode(state));
    ws.on("message", (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return console.warn("[ws] ignored non-JSON message");
      }
      const event = parseClientEvent(parsed, hooks.roomIds?.());
      if (typeof event === "string") return console.warn(`[ws] ignored: ${event}`);
      applyClientEvent(event, store, hooks);
    });
  });
  return wss;
}
