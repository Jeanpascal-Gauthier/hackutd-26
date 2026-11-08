// WebSocket layer: full state on connect, full state after every store change.
import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { ServerEvent } from "@firewatch/shared/events";
import { applyClientEvent, parseClientEvent, type ActionHooks } from "../state/actions.ts";
import type { IncidentStore } from "../state/store.ts";

export function attachWebSocket(httpServer: Server, store: IncidentStore, hooks: ActionHooks) {
  const wss = new WebSocketServer({ server: httpServer });
  const send = (ws: WebSocket, event: ServerEvent) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
  };

  store.subscribe((state) => {
    for (const client of wss.clients) send(client, { type: "state", state });
  });

  wss.on("connection", (ws) => {
    send(ws, { type: "state", state: store.get() });
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
