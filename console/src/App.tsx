import { useEffect, useState } from "react";
import type { ServerEvent } from "@firewatch/shared/events";
import type { IncidentState } from "@firewatch/shared/types";

const WS_URL = "ws://localhost:8080";

export function App() {
  const [state, setState] = useState<IncidentState | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (msg) => {
      const event = JSON.parse(msg.data) as ServerEvent;
      if (event.type === "state") setState(event.state);
    };
    return () => ws.close();
  }, []);

  return (
    <main style={{ fontFamily: "monospace", padding: 16 }}>
      <h1>Firewatch Console</h1>
      <p>{connected ? "connected" : "disconnected"} — {WS_URL}</p>
      <pre>{state ? JSON.stringify(state, null, 2) : "waiting for state…"}</pre>
    </main>
  );
}
