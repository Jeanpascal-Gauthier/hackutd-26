// Verification script: starts the server (mock, no autoplay) and checks the contract.
//   npm run verify -w server
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import type { ServerEvent } from "@firewatch/shared/events";
import type { IncidentState } from "@firewatch/shared/types";

const PORT = 18080;
const base = `http://localhost:${PORT}`;
const server = spawn("npx", ["tsx", "src/index.ts"], {
  env: { ...process.env, PORT: String(PORT), AUTOPLAY: "0", MOCK: "1" },
  stdio: "ignore",
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Connects and records every state received. */
async function client(name: string) {
  const states: IncidentState[] = [];
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  ws.on("message", (d) => states.push((JSON.parse(d.toString()) as ServerEvent).state));
  await new Promise((res, rej) => (ws.once("open", res), ws.once("error", rej)));
  await sleep(100);
  return { name, ws, states, last: () => states[states.length - 1]! };
}

const post = (path: string, body?: unknown) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

async function main() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(base + "/health")).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }

  const a = await client("A");
  const b = await client("B");
  assert.equal(a.states.length, 1, "A gets full state on connect");
  assert.equal(a.last().simMinute, 0);
  console.log("ok  both clients got initial state at minute 0");

  a.ws.send(JSON.stringify({ type: "setSimMinute", minute: 4 }));
  await sleep(150);
  assert.deepEqual(a.last(), b.last(), "both clients see identical state");
  assert.equal(b.last().simMinute, 4);
  assert.ok(b.last().rooms.find((r) => r.roomId === "7-break")!.fire > 0.5);
  assert.ok(b.last().recommendation, "recommendation scripted at minute 3");
  console.log("ok  setSimMinute broadcast identically to both clients (7-break burning)");

  a.ws.send(JSON.stringify({ type: "acceptRecommendation" }));
  await sleep(150);
  assert.equal(b.last().recommendation, undefined);
  console.log("ok  acceptRecommendation consumed and broadcast");

  const bad = await post("/ingest", { text: "", caller: 5 });
  assert.equal(bad.status, 400);
  assert.equal((await post("/ingest", { text: "x", caller: "y" })).status, 200);
  await sleep(100);
  assert.ok(b.last().reports.some((r) => r.text === "x"));
  console.log("ok  /ingest rejects bad input, accepts good input, broadcasts report");

  // Reconnect: B drops, state changes meanwhile, B returns and gets the *current* state.
  b.ws.close();
  await sleep(100);
  a.ws.send(JSON.stringify({ type: "setSimMinute", minute: 7 }));
  await sleep(100);
  const b2 = await client("B-reconnected");
  assert.equal(b2.states.length, 1);
  assert.deepEqual(b2.last(), a.last());
  assert.equal(b2.last().simMinute, 7);
  console.log("ok  reconnecting client immediately receives current state");

  assert.equal((await post("/mock/reset")).status, 200);
  await sleep(100);
  assert.equal(a.last().simMinute, 0);
  assert.deepEqual(a.last(), b2.last());
  assert.equal(a.last().reports.length, 0);
  console.log("ok  /mock/reset returned everyone to minute 0");
  console.log("ALL PASSED");
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => server.kill());
