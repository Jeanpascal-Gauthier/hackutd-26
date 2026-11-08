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
 * Talks to the FireSight server. Two ways to reach it, matching
 * server/API.md's "Remote access" guidance (never hard-code
 * ws://localhost:8080):
 *
 * - Default: Vite's own dev proxy (see vite.config.ts /fs-api and /fs-ws),
 *   so the headset, loaded over https, never has to reach the server's
 *   plain http/ws directly (the browser blocks that as mixed content).
 *   Only works when the server runs on the same machine as this dev server.
 * - `?server=https://<name>.trycloudflare.com` query param: talks to that
 *   origin directly instead, for the documented cloudflared-tunnel setup
 *   (server on a different machine, or the proxy isn't available).
 */

function serverOverride(): string | null {
  const value = new URLSearchParams(window.location.search).get('server')?.trim();
  return value ? value.replace(/\/+$/u, '') : null;
}

export async function fetchBuilding(): Promise<BuildingInfo> {
  const override = serverOverride();
  const url = override != null ? `${override}/building` : '/fs-api/building';
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status}`);
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
    const override = serverOverride();
    const socketUrl =
      override != null
        ? override.replace(/^http/u, 'ws')
        : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/fs-ws`;
    const socket = new WebSocket(socketUrl);
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
