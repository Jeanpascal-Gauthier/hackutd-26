import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import type { ServerEvent } from "@firewatch/shared/events";
import type { IncidentState } from "@firewatch/shared/types";
import { IncidentStore } from "../state/store.ts";
import { attachWebSocket } from "./ws.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup(broadcastMs: number) {
  const store = new IncidentStore();
  const httpServer = createServer();
  const wss = attachWebSocket(httpServer, store, { setSimMinute: () => {} }, { broadcastMs });
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const url = `ws://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  const connect = async () => {
    const states: IncidentState[] = [];
    const ws = new WebSocket(url);
    ws.on("message", (d) => states.push((JSON.parse(d.toString()) as ServerEvent).state));
    await once(ws, "open");
    await sleep(5);
    return { ws, states };
  };
  const close = async () => {
    for (const client of wss.clients) client.terminate();
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };
  return { store, connect, close };
}

test("a burst of patches goes out as one trailing broadcast with the final state", async () => {
  const s = await setup(30);
  try {
    const a = await s.connect();
    assert.equal(a.states.length, 1, "full state at once on connect");
    for (let minute = 1; minute <= 20; minute++) s.store.patch({ simMinute: minute });
    assert.equal(a.states.length, 1, "nothing before the window ends");
    await sleep(60);
    assert.equal(a.states.length, 2);
    assert.equal(a.states[1]!.simMinute, 20);

    s.store.patch({ simMinute: 21 });
    await sleep(60);
    assert.equal(a.states.length, 3, "a later change gets its own broadcast");
    assert.equal(a.states[2]!.simMinute, 21);
  } finally { await s.close(); }
});

test("a client that connects mid-window is not sent the same state twice", async () => {
  const s = await setup(40);
  try {
    const a = await s.connect();
    s.store.patch({ simMinute: 7 });
    const b = await s.connect();
    assert.equal(b.states[0]!.simMinute, 7, "its snapshot is current");
    await sleep(70);
    assert.equal(b.states.length, 1);
    assert.equal(a.states.at(-1)!.simMinute, 7);
  } finally { await s.close(); }
});

test("a window of 0 sends every change", async () => {
  const s = await setup(0);
  try {
    const a = await s.connect();
    for (let minute = 1; minute <= 3; minute++) s.store.patch({ simMinute: minute });
    await sleep(20);
    assert.deepEqual(a.states.map((x) => x.simMinute), [0, 1, 2, 3]);
  } finally { await s.close(); }
});
