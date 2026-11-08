// No network: checks the write_recommendation tool against the 7-break forecast fixture.
//   npm test -w agent
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Building, FloorExit } from "@firewatch/shared/types";
import sharedBuilding from "@firewatch/shared/building.json" with { type: "json" };
import forecastFixture from "../../fixtures/forecast-7-break.json" with { type: "json" };
import type { Forecast, RunState, ToolEnv } from "./types.ts";
import { checkRecommendation, findFloors, findMentions, safeDraft, writeRecommendationTool } from "./writeRecommendation.ts";
import eastFixture from "../../fixtures/forecast-10-east.json" with { type: "json" };

const building = sharedBuilding as Building;
// ServerApi strips `ok` from the POST /forecast response.
const { ok: _ok, ...forecastJson } = forecastFixture;
const forecast = forecastJson as Forecast;
const exits = forecast.exits;

const GOOD = {
  actions: ["Evacuate floors 6-12 by Stairwell A", "Send Engine 3 to floor 7 via Stairwell A"],
  callerReply: "Leave now by Stairwell A. Do not use Stairwell B or the elevator.",
};

const check = (rec: { actions?: unknown; callerReply?: unknown }, ex: FloorExit[] = exits) =>
  checkRecommendation(rec, ex, 7, 12);

function env(run: Partial<RunState> = { forecast, exits, origin: { roomId: "7-break", roomName: "Floor 7 Break Room", confidence: 0.9 } }): ToolEnv {
  return {
    ctx: { building, server: undefined as never },
    heard: "",
    run: { report: { id: "r1", text: "smoke in the break room on 7", caller: "c1", time: 0 }, ...run },
  };
}

const call = (args: Record<string, unknown>, e: ToolEnv) =>
  writeRecommendationTool.run(args, e) as Record<string, unknown>;

test("the schema is named write_recommendation and needs both args", () => {
  assert.equal(writeRecommendationTool.schema.function.name, "write_recommendation");
  assert.deepEqual(writeRecommendationTool.schema.function.parameters?.required, ["actions", "callerReply"]);
});

test("the server's own draft passes the checks", () => {
  assert.deepEqual(check(forecast.recommendation), []);
});

test("a good recommendation is accepted and stored, trimmed", () => {
  const e = env();
  const out = call({ actions: [`  ${GOOD.actions[0]} `, GOOD.actions[1]], callerReply: ` ${GOOD.callerReply} ` }, e);
  assert.deepEqual(out, { accepted: true });
  assert.deepEqual(e.run.recommendation, GOOD);
});

test("telling people to use Stairwell B is rejected; 'do not use Stairwell B' is fine", () => {
  for (const callerReply of [
    "Leave by Stairwell B now. Do not use the elevator.",
    "Take stair-b down. Do not use the elevator.",
    "Don't use Stairwell A, use stairs B. Do not use the elevator.",
    "Leave by the east stairwell. Do not use the elevator.",
  ]) {
    const problems = check({ actions: GOOD.actions, callerReply });
    assert.ok(problems.some((p) => p.includes("use Stairwell B")), `${callerReply} -> ${problems.join(" | ")}`);
  }
  for (const callerReply of [
    "Leave now by Stairwell A; do not use Stairwell B or the elevator.",
    "Use Stairwell A, not Stairwell B. Avoid the elevator.",
    "Take stairwell a. Stairwell B is blocked. Never use the elevator.",
    "Avoid stair-b and the elevators; go down Stairwell A.",
  ]) {
    assert.deepEqual(check({ actions: GOOD.actions, callerReply }), [], callerReply);
  }
  // In an action too, and "Stairwell B fills with smoke" right after it is a warning.
  assert.deepEqual(check({ actions: ["Evacuate floors 6-12 by Stairwell A (Stairwell B fills with smoke)"], callerReply: GOOD.callerReply }), []);
  assert.ok(check({ actions: ["Evacuate floors 6-12 by Stairwell B"], callerReply: GOOD.callerReply }).length > 0);
});

test("a stairwell the building does not have is rejected", () => {
  const problems = check({ actions: GOOD.actions, callerReply: "Leave by Stairwell C. Do not use the elevator." });
  assert.ok(problems.some((p) => p.includes("Stairwell C does not exist")), problems.join(" | "));
});

test("the caller reply must warn against the elevator, and nothing may advise it", () => {
  const missing = check({ actions: GOOD.actions, callerReply: "Leave now by Stairwell A." });
  assert.ok(missing.some((p) => p.includes("not to use the elevator")), missing.join(" | "));
  const take = check({ actions: GOOD.actions, callerReply: "Take the elevator down now." });
  assert.ok(take.some((p) => p.includes("use the elevator")), take.join(" | "));
  const both = check({ actions: GOOD.actions, callerReply: "Leave by Stairwell A or the elevator." });
  assert.ok(both.some((p) => p.includes("reads as telling people to use the elevator")), both.join(" | "));
  const action = check({ actions: ["Evacuate floors 6-12 by the elevator"], callerReply: GOOD.callerReply });
  assert.ok(action.some((p) => p.startsWith("Action 1") && p.includes("elevator")), action.join(" | "));
});

test("floors outside 1-12 are rejected; en-dash ranges parse", () => {
  const problems = check({ actions: ["Evacuate floor 15 by Stairwell A"], callerReply: GOOD.callerReply });
  assert.ok(problems.some((p) => p.includes("floor 15")), problems.join(" | "));
  assert.ok(check({ actions: ["Evacuate floors 8–15 by Stairwell A"], callerReply: GOOD.callerReply }).length > 0);
  assert.deepEqual(check({ actions: ["Evacuate floors 6–12 by Stairwell A"], callerReply: GOOD.callerReply }), []);
  assert.deepEqual(findFloors("floors 8–12 and floor 3, the 5th floor").map((f) => f.floors), [[8, 12], [3], [5]]);
  assert.deepEqual(findFloors("floors 7–9, 11 and 12").map((f) => f.floors), [[7, 9], [11], [12]]);
});

test("more than 3 actions, empty actions, or an overlong reply are rejected", () => {
  const four = check({ actions: [...GOOD.actions, "Send Engine 4 to floor 8", "Send help to floor 10"], callerReply: GOOD.callerReply });
  assert.ok(four.some((p) => p.includes("1-3 actions")), four.join(" | "));
  assert.ok(check({ actions: [], callerReply: GOOD.callerReply }).length > 0);
  assert.ok(check({ actions: "Evacuate", callerReply: GOOD.callerReply }).length > 0);
  assert.ok(check({ actions: [" "], callerReply: GOOD.callerReply }).some((p) => p.includes("empty")));
  assert.ok(check({ actions: ["x".repeat(161)], callerReply: GOOD.callerReply }).some((p) => p.includes("161 characters")));
  const long = check({ actions: GOOD.actions, callerReply: `${GOOD.callerReply} ${"Stay low. ".repeat(25)}` });
  assert.ok(long.some((p) => p.includes("callerReply is") && p.includes("characters")), long.join(" | "));
  assert.ok(check({ actions: GOOD.actions }).some((p) => p.includes("callerReply is empty")));
});

test("a rejection lists the problems and the server draft, and stays small", () => {
  const e = env();
  const out = call({ actions: ["Evacuate floors 6-15 by Stairwell B", "Use the elevator"], callerReply: "Take Stairwell B." }, e);
  assert.equal(out.accepted, false);
  assert.ok(Array.isArray(out.problems) && out.problems.length > 0);
  assert.deepEqual(out.draft, forecast.recommendation);
  assert.equal(e.run.recommendation, undefined);
  assert.ok(JSON.stringify(out).length < 1300, `${JSON.stringify(out).length} bytes`);
});

test("the 3rd rejection in a run falls back to the server draft; a new run counts again", () => {
  const bad = { actions: GOOD.actions, callerReply: "Leave by Stairwell B." };
  const e = env();
  assert.ok(call(bad, e).draft);
  assert.ok(call(bad, e).draft);
  const third = call(bad, e);
  assert.equal(third.usedServerDraft, true);
  assert.ok(Array.isArray(third.problems));
  assert.deepEqual(e.run.recommendation, forecast.recommendation);

  const fresh = env();
  const first = call(bad, fresh);
  assert.equal(first.usedServerDraft, undefined);
  assert.ok(first.draft);
  assert.equal(fresh.run.recommendation, undefined);
});

test("no exit plan yet -> asks for find_clear_exits", () => {
  const out = call(GOOD, env({}));
  assert.deepEqual(out, { accepted: false, error: "no exit plan yet: call find_clear_exits first" });
  // The forecast's exits are enough when find_clear_exits has not stored its own.
  assert.deepEqual(call(GOOD, env({ forecast })), { accepted: true });
});

test("a floor with no clear stairwell must be named in the actions", () => {
  const ex: FloorExit[] = [
    { floor: 7, people: 20, flags: [], stair: "stair-a", blockedAt: { "stair-a": null, "stair-b": 10 }, atRiskAt: 2 },
    { floor: 9, people: 12, flags: ["mobility"], stair: null, blockedAt: { "stair-a": 8, "stair-b": 6 }, atRiskAt: 5 },
    { floor: 3, people: 30, flags: [], stair: "stair-a", blockedAt: { "stair-a": null, "stair-b": null }, atRiskAt: null },
  ];
  const reply = "Leave by Stairwell A; do not use Stairwell B or the elevator.";
  const missing = check({ actions: ["Evacuate floor 7 by Stairwell A"], callerReply: reply }, ex);
  assert.ok(missing.some((p) => p.includes("Floor 9")), missing.join(" | "));
  assert.deepEqual(check({ actions: ["Evacuate floor 7 by Stairwell A", "Send a rescue crew to floor 9"], callerReply: reply }, ex), []);
  // A range that covers it counts.
  assert.deepEqual(check({ actions: ["Rescue crews to floors 7-9"], callerReply: reply }, ex), []);
});

test("mention polarity heuristic", () => {
  const uses = (t: string) => findMentions(t).map((m) => `${m.kind === "stair" ? m.ids.join("+") : "elevator"}:${m.use ? "use" : "avoid"}`);
  assert.deepEqual(uses("Leave now by Stairwell A; do not use Stairwell B or the elevator."), ["stair-a:use", "stair-b:avoid", "elevator:avoid"]);
  assert.deepEqual(uses("Avoid stair B and use stair A or the elevator"), ["stair-b:avoid", "stair-a:use", "elevator:use"]);
  assert.deepEqual(uses("Leave by Stairwell A while Stairwell B fills"), ["stair-a:use", "stair-b:avoid"]);
  assert.deepEqual(uses("Do not use Stairwells A and B"), ["stair-a+stair-b:avoid"]);
  assert.deepEqual(uses("No elevators."), ["elevator:avoid"]);
});

test("safeDraft: the server draft that says 'or the elevator' is replaced before use", () => {
  const { ok: _ok2, ...east } = eastFixture;
  const eastForecast = east as Forecast;
  assert.match(eastForecast.recommendation.callerReply ?? "", /Stairwell B or the elevator/);
  const safe = safeDraft(eastForecast.recommendation, eastForecast.exits, 10, 12)!;
  assert.deepEqual(checkRecommendation(safe, eastForecast.exits, 10, 12), []);
  assert.match(safe.callerReply ?? "", /Leave now by Stairwell B\. Do not use the elevator\./);
  // A draft that already passes is kept unchanged.
  assert.equal(safeDraft(forecast.recommendation, exits, 7, 12), forecast.recommendation);
});

test("every floor at risk must be covered by the actions", () => {
  const rec = {
    actions: ["Evacuate floors 8-12 by Stairwell A", "Send Engine 3 to floor 7 by Stairwell A"],
    callerReply: "Leave by Stairwell A. Do not use Stairwell B or the elevator.",
  };
  const problems = checkRecommendation(rec, exits, 7, 12);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /leave out floor 6/);
  assert.deepEqual(checkRecommendation({ ...rec, actions: ["Evacuate floors 6-12 by Stairwell A"] }, exits, 7, 12), []);
});
