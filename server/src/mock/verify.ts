// Mock-mode end-to-end check: scripted calls replay through the real pipeline.
//   npm run verify -w server   (or from the repo root: npx tsx server/src/mock/verify.ts)
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import type { ServerEvent } from "@firewatch/shared/events";
import type { IncidentState } from "@firewatch/shared/types";
import { startServer, verifyPort } from "../testing/startServer.ts";

const PORT = verifyPort(18080);
const base = `http://localhost:${PORT}`;
const server = await startServer(PORT, { AUTOPLAY: "0", MOCK: "1", TICK_MS: "60" });

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

async function waitFor(what: string, pred: () => boolean, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) if (pred()) return;
  throw new Error(`timed out waiting for: ${what}`);
}

const post = (path: string, body?: unknown) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const room = (s: IncidentState, id: string) => s.rooms.find((r) => r.roomId === id)!;

async function main() {
  const a = await client("A");
  const b = await client("B");
  assert.equal(a.states.length, 1, "A gets full state on connect");
  assert.equal(a.last().simMinute, 0);
  assert.equal(a.last().rooms.length, 108);
  assert.equal(a.last().origin, undefined, "no fire before replay");
  console.log("ok  both clients got initial state: minute 0, 108 rooms, no fire");

  assert.equal((await post("/mock/replay")).status, 200);
  // The origin and the demo trail arrive in two consecutive broadcasts: wait for both.
  await waitFor("first scripted call", () => a.last().origin?.roomId === "7-break" && (a.last().trail?.length ?? 0) >= 5);
  assert.ok(room(a.last(), "7-break").fire > 0);
  assert.ok(a.last().recommendation?.actions.length, "real recommendation");
  assert.deepEqual(a.last().trail?.map((t) => t.tool), ["locate_room", "merge_reports", "run_spread", "find_clear_exits", "write_recommendation"]);
  console.log("ok  replay: scripted call -> origin 7-break, recommendation, 5-step trail");

  await waitFor("all scripted calls delivered", () => a.last().simMinute >= 13);
  assert.equal(a.last().reports.length, 4);
  assert.equal(a.last().reports.filter((r) => !r.roomId).length, 1, "the vague call stays unlocated");
  assert.equal(a.last().origin?.roomId, "7-break", "later smoke reports above support the origin");
  assert.ok(a.last().origin!.confidence > 0.8);
  console.log(`ok  4 scripted calls; origin 7-break @ ${a.last().origin!.confidence}; trail ${a.last().trail!.length} steps`);

  await waitFor("replay reaches minute 30", () => a.last().simMinute === 30);
  await sleep(200);
  assert.equal(a.last().simMinute, 30, "replay stops at 30");
  assert.ok(room(a.last(), "12-stair-b").smoke >= 0.3 && room(a.last(), "12-stair-a").smoke < 0.3);
  await waitFor("both clients in sync", () => JSON.stringify(a.last()) === JSON.stringify(b.last()), 1000);
  assert.deepEqual(a.last(), b.last(), "both clients see identical state");
  console.log("ok  replay stopped at minute 30; stair B smoky, stair A clear; clients identical");

  a.ws.send(JSON.stringify({ type: "setSimMinute", minute: 4 }));
  await sleep(150);
  assert.equal(b.last().simMinute, 4);
  assert.ok(room(b.last(), "7-break").fire > 0.5);
  console.log("ok  setSimMinute scrubs the forecast for everyone");

  a.ws.send(JSON.stringify({ type: "acceptRecommendation" }));
  await sleep(150);
  assert.equal(b.last().recommendation, undefined);
  console.log("ok  acceptRecommendation consumed and broadcast");

  assert.equal((await post("/ingest", { text: "", caller: 5 })).status, 400);
  const good = await post("/ingest", { text: "smoke on floor 5 in the conference room", caller: "y" });
  assert.equal(good.status, 200);
  await sleep(100);
  assert.ok(b.last().reports.some((r) => r.roomId === "5-conf"));
  console.log("ok  /ingest rejects bad input, accepts good input, broadcasts report");

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
  await waitFor("reset reaches both clients", () => a.last().simMinute === 0 && b2.last().simMinute === 0);
  assert.equal(a.last().reports.length, 0);
  assert.equal(a.last().trail?.length, 0);
  assert.equal(a.last().origin, undefined);
  assert.deepEqual(a.last(), b2.last());
  console.log("ok  /mock/reset returned everyone to minute 0, no fire");
  console.log("ALL PASSED");
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => server.kill());
