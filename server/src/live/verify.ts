// Live-mode end-to-end check: starts the server with MOCK=0, sends demo reports, checks st().
//   npm run verify:live -w server
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import type { ServerEvent } from "@firewatch/shared/events";
import type { IncidentState } from "@firewatch/shared/types";

const PORT = 18081;
const base = `http://localhost:${PORT}`;
const server = spawn("npx", ["tsx", "src/index.ts"], {
  env: { ...process.env, PORT: String(PORT), MOCK: "0" },
  stdio: "ignore",
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = async (path: string, body?: unknown) =>
  (await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })).json() as Promise<Record<string, any>>;
const room = (s: IncidentState, id: string) => s.rooms.find((r) => r.roomId === id)!;

async function main() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(base + "/health")).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }
  let latest!: IncidentState;
  const st = () => latest; // a function, so TypeScript doesn't keep earlier narrowing
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  ws.on("message", (d) => (latest = (JSON.parse(d.toString()) as ServerEvent).state));
  await new Promise((res, rej) => (ws.once("open", res), ws.once("error", rej)));
  await sleep(100);

  assert.equal(st().rooms.length, 108, "full building, all rooms clear");
  assert.ok(st().rooms.every((r) => r.fire === 0 && r.smoke === 0));
  assert.equal(st().origin, undefined);
  console.log("ok  starts clear: 108 rooms, no origin");

  const vague = await post("/ingest", { caller: "caller-0", text: "fire alarm going off, I can't tell where" });
  assert.equal(vague.report.roomId, undefined);
  assert.match(vague.reply, /Which floor/);
  console.log(`ok  vague report -> follow-up: "${vague.reply}"`);

  const first = await post("/ingest", { caller: "judge-1", text: "There's smoke coming from the break room on the 7th floor" });
  await sleep(100);
  assert.equal(first.report.roomId, "7-break");
  assert.equal(st().origin?.roomId, "7-break");
  assert.ok(room(st(), "7-break").fire > 0, "origin is burning at minute 0");
  for (let f = 8; f <= 12; f++) assert.equal(st().exits?.find((e) => e.floor === f)?.stair, "stair-a", `floor ${f} exit`);
  assert.ok(st().recommendation?.actions.length);
  assert.match(first.reply, /Stairwell A/);
  console.log(`ok  7-break located; origin ${st().origin!.roomId} @ ${st().origin!.confidence}`);
  console.log(`    actions: ${st().recommendation!.actions.join(" | ")}`);

  ws.send(JSON.stringify({ type: "setSimMinute", minute: 20 }));
  await sleep(100);
  assert.equal(st().simMinute, 20);
  assert.ok(room(st(), "10-stair-b").smoke >= 0.3, "stair B smoky on 10 at minute 20");
  assert.ok(room(st(), "10-stair-a").smoke < 0.3, "stair A clear on 10 at minute 20");
  console.log(`ok  minute 20: 10-stair-b smoke ${room(st(), "10-stair-b").smoke.toFixed(2)}, 10-stair-a ${room(st(), "10-stair-a").smoke.toFixed(2)}`);

  const before = st().origin!.confidence;
  await post("/ingest", { caller: "judge-2", text: "smoke in the hallway on floor 10" });
  await sleep(100);
  assert.equal(st().origin?.roomId, "7-break", "smoke above supports the 7th-floor origin");
  assert.ok(st().origin!.confidence >= before);
  assert.equal(st().simMinute, 20, "a new report keeps the scrub position");
  console.log(`ok  floor-10 report: origin stays 7-break, confidence ${before} -> ${st().origin!.confidence}`);

  ws.send(JSON.stringify({ type: "acceptRecommendation" }));
  await sleep(100);
  assert.equal(st().recommendation, undefined);
  console.log("ok  acceptRecommendation consumes it");

  await post("/live/reset");
  await sleep(100);
  assert.equal(st().reports.length, 0);
  assert.equal(st().origin, undefined);
  console.log("ok  /live/reset clears the incident");
  console.log("ALL PASSED");
}

main()
  .catch((e) => { console.error("FAILED:", e.message); process.exitCode = 1; })
  .finally(() => server.kill());
