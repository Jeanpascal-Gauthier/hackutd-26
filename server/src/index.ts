import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientEvent, ServerEvent } from "@firewatch/shared/events";
import { mockState } from "./mockIncident.ts";

const PORT = 8080;
const TICK_MS = 2000;

let simMinute = 0;

// --- HTTP: POST /ingest {text, caller} -----------------------------------
const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/ingest") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { text, caller } = JSON.parse(body) as { text: string; caller: string };
        console.log(`[ingest] caller=${caller} text=${JSON.stringify(text)}`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "invalid JSON" }));
      }
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

// --- WebSocket ------------------------------------------------------------
const wss = new WebSocketServer({ server });

function send(ws: WebSocket, event: ServerEvent) {
  ws.send(JSON.stringify(event));
}

function broadcast() {
  const event: ServerEvent = { type: "state", state: mockState(simMinute) };
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) send(client, event);
  }
}

wss.on("connection", (ws) => {
  console.log("[ws] client connected");
  send(ws, { type: "state", state: mockState(simMinute) });

  ws.on("message", (raw) => {
    let event: ClientEvent;
    try {
      event = JSON.parse(raw.toString()) as ClientEvent;
    } catch {
      return;
    }
    console.log("[ws] received", event);
    if (event.type === "setSimMinute") {
      simMinute = event.minute;
      broadcast();
    }
    // TODO: acceptRecommendation, dispatch
  });
});

setInterval(() => {
  simMinute += 1;
  broadcast();
}, TICK_MS);

server.listen(PORT, () => {
  console.log(`[server] ws://localhost:${PORT}  POST http://localhost:${PORT}/ingest`);
});
