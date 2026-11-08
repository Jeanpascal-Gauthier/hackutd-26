// No network: checks merge_reports against the server's merge rules, with a fake ServerApi.
//   npm test -w agent
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Building, IncidentState, Report } from "@firewatch/shared/types";
import sharedBuilding from "@firewatch/shared/building.json" with { type: "json" };
import state3 from "../../fixtures/state-3-reports.json" with { type: "json" };
import { excerpt, mergeReports, mergeReportsTool, withCurrent } from "./mergeReports.ts";
import type { RunState, ServerApi, ToolEnv } from "./types.ts";

const building = sharedBuilding as Building;
const fixture = state3 as unknown as IncidentState;

const fakeServer = (state: IncidentState | (() => never)): ServerApi => ({
  getState: async () => (typeof state === "function" ? state() : structuredClone(state)),
  getBuilding: async () => {
    throw new Error("not used");
  },
  forecast: async () => {
    throw new Error("not used");
  },
});

const stateWith = (reports: Report[]): IncidentState => ({ ...fixture, reports });

let n = 0;
const report = (text: string, roomId?: string, confidence = 0.8): Report => ({
  id: `r${++n}`,
  caller: "+1999",
  text,
  roomId,
  confidence,
  time: n,
});

function env(server: ServerApi, current: RunState["report"]): ToolEnv {
  return { ctx: { building, server }, heard: current.text, run: { report: current } };
}

test("the 3 fixture reports give the server's origin: 10-conf at 0.4", () => {
  const r = mergeReports(fixture.reports, building)!;
  assert.deepEqual(fixture.origin, { roomId: "10-conf", confidence: 0.4 });
  assert.equal(r.origin.roomId, fixture.origin!.roomId);
  assert.equal(r.origin.confidence, fixture.origin!.confidence);
  assert.equal(r.origin.roomName, "Floor 10 Conference");
  assert.equal(r.reportsUsed, 3);
  assert.equal(r.score, 1.6);
  assert.deepEqual(
    r.support.map((e) => [e.roomId, e.kind, e.weight]),
    [["10-conf", "fire", 1.6]],
  );
  assert.deepEqual(r.against.map((e) => e.roomId).sort(), ["7-break", "9-stair-b"]);
  // 7-break: its own 0.8 + 9-stair-b smoke from above at half weight.
  assert.deepEqual(r.runnerUp, { roomId: "7-break", score: 1.2 });
});

test("tool: the current report is included and written to run.origin", async () => {
  // Without the flames report in state, the current one supplies it.
  const [a, b, c] = fixture.reports as [Report, Report, Report];
  const e = env(fakeServer(stateWith([a, b])), { ...c });
  const out = (await mergeReportsTool.run({}, e)) as ReturnType<typeof mergeReports> & object;
  assert.equal(out.origin.roomId, "10-conf");
  assert.equal(out.origin.confidence, 0.4);
  assert.equal(out.reportsUsed, 3);
  assert.equal(out.support[0]!.current, true);
  assert.deepEqual(e.run.origin, { roomId: "10-conf", roomName: "Floor 10 Conference", confidence: 0.4 });
});

test("tool: a report already in the state is not counted twice", async () => {
  const [, , c] = fixture.reports as [Report, Report, Report];
  const e = env(fakeServer(fixture), { ...c });
  const out = (await mergeReportsTool.run({}, e)) as NonNullable<ReturnType<typeof mergeReports>>;
  assert.equal(out.reportsUsed, 3);
  assert.equal(out.origin.confidence, 0.4);
  assert.equal(withCurrent(fixture.reports, c).length, 3);
});

test("smoke from floors above supports a lower origin", () => {
  const r = mergeReports(
    [report("smoke in the break room", "7-break"), report("smoke in the hallway", "9-hall"), report("smoky stairs", "10-stair-b")],
    building,
  )!;
  assert.equal(r.origin.roomId, "7-break");
  assert.equal(r.score, 1.6); // 0.8 + 0.4 + 0.4
  assert.equal(r.against.length, 0);
  assert.deepEqual(
    r.support.map((e) => e.weight),
    [0.8, 0.4, 0.4],
  );
});

test("fire words count double, and fire above does not support a lower room", () => {
  const r = mergeReports([report("smoke in the hall", "3-hall"), report("flames in the conference room", "5-conf")], building)!;
  assert.equal(r.origin.roomId, "5-conf");
  assert.equal(r.support[0]!.kind, "fire");
  assert.equal(r.support[0]!.weight, 1.6);
  assert.deepEqual(r.against.map((e) => [e.roomId, e.kind, e.weight]), [["3-hall", "smoke", 0.8]]);
});

test("ties go to the lower floor", () => {
  const r = mergeReports([report("fire in the break room", "8-break"), report("fire in the office", "4-office")], building)!;
  assert.equal(r.origin.roomId, "4-office");
  assert.deepEqual(r.runnerUp, { roomId: "8-break", score: 1.6 });
});

test("unknown rooms and zero confidence are ignored", () => {
  assert.equal(mergeReports([report("smoke", "99-nowhere"), report("smoke", "7-break", 0), report("smoke")], building), undefined);
});

test("tool: no located reports -> error, run.origin stays unset", async () => {
  const e = env(fakeServer(stateWith([report("help", undefined, 0)])), { id: "x", text: "help", caller: "+1", time: 0 });
  const out = (await mergeReportsTool.run({}, e)) as { error?: string };
  assert.match(out.error ?? "", /no located reports yet/);
  assert.equal(e.run.origin, undefined);
});

test("tool: getState throwing -> merges the current report alone, with a note", async () => {
  const down = fakeServer(() => {
    throw new Error("fetch failed");
  });
  const e = env(down, { id: "y", text: "smoke in the break room on 7", caller: "+1", time: 0, roomId: "7-break", confidence: 0.85 });
  const out = (await mergeReportsTool.run({ junk: 1 }, e)) as NonNullable<ReturnType<typeof mergeReports>>;
  assert.equal(out.origin.roomId, "7-break");
  assert.equal(out.origin.confidence, 0.85);
  assert.equal(out.reportsUsed, 1);
  assert.match(out.note ?? "", /server unreachable/);
  assert.equal(e.run.origin?.roomId, "7-break");
});

test("tool output stays under ~1 KB of JSON, even with many long reports", async () => {
  const long = "there is a lot of thick black smoke pouring out from under the door and it smells like burning plastic";
  const many = Array.from({ length: 30 }, (_, i) =>
    report(i % 2 ? `fire ${long}` : long, `${(i % 12) + 1}-stair-b`, 0.5 + (i % 5) / 10),
  );
  const current = { ...report(`${long} ${long}`, "10-stair-b", 0.85) };
  const out = await mergeReportsTool.run({}, env(fakeServer(stateWith(many)), current));
  const bytes = Buffer.byteLength(JSON.stringify(out));
  assert.ok(bytes < 1024, `output is ${bytes} bytes`);
  const r = out as NonNullable<ReturnType<typeof mergeReports>>;
  assert.equal(r.reportsUsed, 31);
  assert.ok(r.notListed! > 0);
  assert.ok([...r.support, ...r.against].some((e) => e.current), "the current report is always listed");
  // The fixture output too.
  assert.ok(Buffer.byteLength(JSON.stringify(mergeReports(fixture.reports, building))) < 1024);
});

test("excerpt keeps at most 60 chars on one line", () => {
  assert.equal(excerpt("a\n  b"), "a b");
  assert.equal(excerpt("x".repeat(100)).length, 60);
});
