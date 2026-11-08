import type { BuildingInfo, ClientEvent, IncidentState } from './incident-types.js';

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

/** Same-origin Vite proxy by default; HTTPS/WSS overrides support remote servers. */
export function incidentEndpoints() {
  const value = new URLSearchParams(window.location.search).get('server')?.trim();
  if (!value) {
    const origin = window.location.origin;
    return { building: `${origin}/fs-api/building`, socket: `${origin.replace(/^http/u, 'ws')}/fs-ws` };
  }
  const url = new URL(value);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
    throw new Error('Server URL must use HTTP, HTTPS, WS or WSS');
  }
  // HTTP and WebSocket share the same server origin (server/API.md).
  url.protocol = url.protocol === 'ws:' ? 'http:' : url.protocol === 'wss:' ? 'https:' : url.protocol;
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/u, '');
  const base = url.toString().replace(/\/+$/u, '');
  return { building: `${base}/building`, socket: base.replace(/^http/u, 'ws') };
}

export async function fetchBuilding(signal?: AbortSignal): Promise<BuildingInfo> {
  const url = incidentEndpoints().building;
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status}`);
  const info = await response.json() as BuildingInfo;
  if (!Array.isArray(info.building?.rooms) || info.building.rooms.length === 0) {
    throw new Error('Server returned no building rooms');
  }
  return info;
}

export class IncidentSocket {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByCaller = true;

  constructor(
    private readonly onState: (state: IncidentState) => void,
    private readonly onStatus: (status: ConnectionStatus) => void = () => {},
  ) {}

  connect(): void {
    if (this.socket || this.reconnectTimer != null) return;
    this.closedByCaller = false;
    this.open();
  }

  private open(): void {
    if (this.closedByCaller) return;
    this.onStatus('connecting');
    let socket: WebSocket;
    try {
      socket = new WebSocket(incidentEndpoints().socket);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (this.socket === socket) this.onStatus('connected');
    });
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket || this.closedByCaller) return;
      try {
        const parsed = JSON.parse(event.data as string);
        const state = parsed?.state;
        if (parsed?.type === 'state' && state && Array.isArray(state.rooms)
          && Array.isArray(state.reports) && Array.isArray(state.occupants)
          && typeof state.simMinute === 'number') this.onState(state as IncidentState);
      } catch { /* Ignore malformed messages without breaking the connection. */ }
    });
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.scheduleReconnect();
    });
    socket.addEventListener('error', () => socket.close());
  }

  private scheduleReconnect(): void {
    if (this.closedByCaller || this.reconnectTimer != null) return;
    this.onStatus('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, 2000);
  }

  /** Commands are never queued/replayed: a stale dispatch must not fire on reconnect. */
  send(event: ClientEvent): boolean {
    if (this.closedByCaller || this.socket?.readyState !== WebSocket.OPEN) return false;
    try {
      this.socket.send(JSON.stringify(event));
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.closedByCaller = true;
    if (this.reconnectTimer != null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.onStatus('disconnected');
  }
}
