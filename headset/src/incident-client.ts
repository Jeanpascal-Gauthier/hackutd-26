/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {
  BuildingInfo,
  ClientEvent,
  IncidentState,
  ServerEvent,
} from './incident-types.js';

/**
 * Talks to the FireSight server through Vite's dev proxy (see vite.config.ts
 * /fs-api and /fs-ws) so the headset, loaded over https, never has to reach
 * the server's plain http/ws directly (mixed content is blocked by the
 * browser). In production this would need a real https/wss endpoint instead.
 */

export async function fetchBuilding(): Promise<BuildingInfo> {
  const response = await fetch('/fs-api/building');
  if (!response.ok) {
    throw new Error(`GET /fs-api/building failed: ${response.status}`);
  }
  return (await response.json()) as BuildingInfo;
}

export class IncidentSocket {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByCaller = false;

  constructor(private readonly onState: (state: IncidentState) => void) {}

  connect(): void {
    this.closedByCaller = false;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${window.location.host}/fs-ws`);
    this.socket = socket;

    socket.addEventListener('message', (event) => {
      let parsed: ServerEvent;
      try {
        parsed = JSON.parse(event.data as string) as ServerEvent;
      } catch {
        return;
      }
      if (parsed.type === 'state') {
        this.onState(parsed.state);
      }
    });

    socket.addEventListener('close', () => {
      if (this.closedByCaller) {
        return;
      }
      this.reconnectTimer = setTimeout(() => this.connect(), 2000);
    });

    socket.addEventListener('error', () => socket.close());
  }

  send(event: ClientEvent): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(event));
    }
  }

  close(): void {
    this.closedByCaller = true;
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer);
    }
    this.socket?.close();
  }
}
