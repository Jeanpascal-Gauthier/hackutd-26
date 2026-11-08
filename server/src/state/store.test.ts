import { test } from "node:test";
import assert from "node:assert/strict";
import { IncidentStore, MAX_LOG } from "./store.ts";
import { applyClientEvent, parseClientEvent, type ActionHooks } from "./actions.ts";
import type { MapIncident, Recommendation } from "@firewatch/shared/types";

const rec = { actions: ["Evacuate floors 7–12 by Stairwell A"], callerReply: "Leave now" };
const hooks = { setSimMinute: () => {} };

test("accepting keeps the recommendation in `accepted` and logs it", () => {
  const s = new IncidentStore();
  assert.equal(s.acceptRecommendation(), undefined, "nothing pending");
  s.setRecommendation(rec);
  assert.deepEqual(s.acceptRecommendation(), rec);
  assert.equal(s.get().recommendation, undefined);
  assert.deepEqual(s.get().accepted?.recommendation, rec);
  assert.ok(s.get().accepted!.time > 0);
  assert.equal(s.get().log?.at(-1)?.kind, "accepted");
});

test("dispatch event is recorded and logged", () => {
  const s = new IncidentStore();
  applyClientEvent({ type: "dispatch", roomId: "7-break" }, s, hooks);
  assert.equal(s.get().dispatches?.[0].roomId, "7-break");
  assert.match(s.get().log!.at(-1)!.text, /7-break/);
});

test("log keeps only the last MAX_LOG entries", () => {
  const s = new IncidentStore();
  for (let i = 0; i < MAX_LOG + 25; i++) s.log("report", `r${i}`);
  assert.equal(s.get().log!.length, MAX_LOG);
  assert.equal(s.get().log!.at(-1)!.text, `r${MAX_LOG + 24}`);
});

const pin = (id: string, recommendation?: Recommendation): MapIncident => ({
  id, kind: "other", label: "Gas leak", severity: "unknown", status: "located", reports: [], time: 1, updated: 1, phase: "open", forecastStatus: "none",
  ...(recommendation && { recommendation }),
});

test("accepting by incident id moves that incident's recommendation and clears the global slot if it is the same object", () => {
  const s = new IncidentStore();
  const mine = { actions: ["Send responders to A."] };
  const other = { actions: ["Send responders to B."] };
  s.patch({ mapIncidents: [pin("a", mine), pin("b", other)], recommendation: mine });
  applyClientEvent({ type: "acceptRecommendation", incidentId: "a" }, s, hooks);
  const [a, b] = s.get().mapIncidents!;
  assert.equal(a!.recommendation, undefined);
  assert.equal(a!.accepted?.recommendation, mine);
  assert.equal(b!.recommendation, other, "the other incident is untouched");
  assert.equal(s.get().recommendation, undefined);
  assert.equal(s.get().accepted?.recommendation, mine);
  assert.equal(s.get().log!.at(-1)!.incidentId, "a");

  s.setRecommendation(rec);
  applyClientEvent({ type: "acceptRecommendation", incidentId: "b" }, s, hooks);
  assert.equal(s.get().mapIncidents![1]!.accepted?.recommendation, other);
  assert.equal(s.get().recommendation, rec, "a different global recommendation stays");
  assert.equal(s.acceptIncidentRecommendation("nope"), undefined, "unknown id ignored");
  assert.equal(s.acceptIncidentRecommendation("a"), undefined, "nothing pending");
});

test("a plain accept marks the owning map incident accepted, and leaves others alone", () => {
  const s = new IncidentStore();
  const mine = { actions: ["Send responders to A."] };
  s.patch({ mapIncidents: [pin("a", mine), pin("b")], recommendation: mine });
  applyClientEvent({ type: "acceptRecommendation" }, s, hooks);
  assert.equal(s.get().recommendation, undefined);
  assert.equal(s.get().accepted?.recommendation, mine);
  assert.equal(s.get().mapIncidents![0]!.recommendation, undefined);
  assert.equal(s.get().mapIncidents![0]!.accepted?.recommendation, mine);
  assert.equal(s.get().mapIncidents![1]!.accepted, undefined);
  assert.equal(s.get().log!.at(-1)!.incidentId, "a");

  const building = new IncidentStore();
  building.patch({ mapIncidents: [pin("a", mine)], recommendation: rec });
  building.acceptRecommendation();
  assert.equal(building.get().mapIncidents![0]!.recommendation, mine, "a building plan's accept does not touch the map");
});

test("parseClientEvent validates the map incident events", () => {
  assert.deepEqual(parseClientEvent({ type: "acceptRecommendation" }), { type: "acceptRecommendation" });
  assert.deepEqual(parseClientEvent({ type: "acceptRecommendation", incidentId: "inc-1" }), { type: "acceptRecommendation", incidentId: "inc-1" });
  assert.equal(typeof parseClientEvent({ type: "acceptRecommendation", incidentId: 7 }), "string", "a bad id must not fall through to a plain accept");
  assert.equal(typeof parseClientEvent({ type: "acceptRecommendation", incidentId: "" }), "string");

  assert.deepEqual(parseClientEvent({ type: "dispatchIncident", incidentId: "inc-1" }), { type: "dispatchIncident", incidentId: "inc-1" });
  assert.deepEqual(parseClientEvent({ type: "dispatchIncident", incidentId: "inc-1", unit: "  Engine 3 " }), { type: "dispatchIncident", incidentId: "inc-1", unit: "Engine 3" });
  assert.deepEqual(parseClientEvent({ type: "dispatchIncident", incidentId: "inc-1", unit: "  " }), { type: "dispatchIncident", incidentId: "inc-1" }, "a blank unit field means no unit");
  assert.equal(typeof parseClientEvent({ type: "dispatchIncident" }), "string");
  assert.equal(typeof parseClientEvent({ type: "dispatchIncident", incidentId: "inc-1", unit: 3 }), "string");
  assert.equal(typeof parseClientEvent({ type: "dispatchIncident", incidentId: "inc-1", unit: "x".repeat(101) }), "string");

  assert.deepEqual(parseClientEvent({ type: "setIncidentPhase", incidentId: "inc-1", phase: "on_scene" }), { type: "setIncidentPhase", incidentId: "inc-1", phase: "on_scene" });
  assert.equal(typeof parseClientEvent({ type: "setIncidentPhase", incidentId: "inc-1", phase: "closed" }), "string");
  assert.equal(typeof parseClientEvent({ type: "setIncidentPhase", phase: "open" }), "string");

  assert.deepEqual(parseClientEvent({ type: "addIncidentNote", incidentId: "inc-1", text: "  gate code 4412 " }), { type: "addIncidentNote", incidentId: "inc-1", text: "gate code 4412" });
  assert.equal(typeof parseClientEvent({ type: "addIncidentNote", incidentId: "inc-1", text: "   " }), "string");
  assert.equal(typeof parseClientEvent({ type: "addIncidentNote", incidentId: "inc-1", text: "x".repeat(501) }), "string");
});

test("map incident events go to the hooks; without them they are ignored", () => {
  const calls: unknown[][] = [];
  const mapIncidents: NonNullable<ActionHooks["mapIncidents"]> = {
    dispatch: (...a) => (calls.push(["dispatch", ...a]), { ok: true }),
    setPhase: (...a) => (calls.push(["setPhase", ...a]), { ok: true }),
    addNote: (...a) => (calls.push(["addNote", ...a]), { ok: false, error: "unknown incident" }),
  };
  const { log } = console;
  const lines: string[] = [];
  console.log = (line: string) => void lines.push(line);
  try {
    const s = new IncidentStore();
    applyClientEvent({ type: "dispatchIncident", incidentId: "a", unit: "Engine 3" }, s, { ...hooks, mapIncidents });
    applyClientEvent({ type: "setIncidentPhase", incidentId: "a", phase: "resolved" }, s, { ...hooks, mapIncidents });
    applyClientEvent({ type: "addIncidentNote", incidentId: "a", text: "hi" }, s, { ...hooks, mapIncidents });
    applyClientEvent({ type: "dispatchIncident", incidentId: "a" }, s, hooks);
  } finally {
    console.log = log;
  }
  assert.deepEqual(calls, [["dispatch", "a", "Engine 3"], ["setPhase", "a", "resolved"], ["addNote", "a", "hi"]]);
  assert.match(lines[2]!, /ignored: unknown incident/);
  assert.match(lines[3]!, /ignored: map incidents unavailable/);
});
