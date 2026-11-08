// No network: checks the exit plan behind the find_clear_exits tool, on real forecast fixtures.
//   npm test -w agent
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Building, FloorExit } from "@firewatch/shared/types";
import sharedBuilding from "@firewatch/shared/building.json" with { type: "json" };
import forecast7Break from "../../fixtures/forecast-7-break.json" with { type: "json" };
import forecast10East from "../../fixtures/forecast-10-east.json" with { type: "json" };
import { findClearExitsTool, floorRange, planExits, type ExitPlan } from "./findClearExits.ts";
import type { Forecast, ServerApi, ToolEnv } from "./types.ts";

const building = sharedBuilding as Building;

/** A fixture as ServerApi returns it (without `ok`). */
function asForecast(fixture: unknown): Forecast {
  const { ok: _ok, ...rest } = fixture as Forecast & { ok: boolean };
  return structuredClone(rest);
}

/** A fake server that only answers forecast(), and counts the calls. */
function fakeServer(forecast: Forecast) {
  const calls: string[] = [];
  const server: ServerApi = {
    getState: () => Promise.reject(new Error("not used")),
    getBuilding: () => Promise.reject(new Error("not used")),
    forecast: async (origin) => {
      calls.push(origin);
      return forecast;
    },
  };
  return { server, calls };
}

function envWith(server: ServerApi, run: Partial<ToolEnv["run"]> = {}): ToolEnv {
  return {
    ctx: { building, server },
    heard: "",
    run: { report: { id: "r1", text: "fire", caller: "c1", time: 0 }, ...run },
  };
}

test("7-break: floors 6-12 at risk, all by Stairwell A", () => {
  const f = asForecast(forecast7Break);
  const plan = planExits(f.exits, 7);
  assert.equal(plan.originFloor, 7);
  assert.deepEqual(
    plan.floors.map((p) => p.floor),
    [6, 7, 8, 9, 10, 11, 12],
  );
  assert.ok(plan.floors.every((p) => p.stair === "Stairwell A"));
  assert.deepEqual(plan.byStair, [{ stair: "Stairwell A", floors: "6-12", people: 54 }]);
  assert.deepEqual(plan.noClearStair, []);

  const floor7 = plan.floors.find((p) => p.floor === 7)!;
  assert.deepEqual(floor7.othersFill, { "Stairwell B": 11 });
  assert.equal(floor7.smokeAt, 2);
  assert.equal(floor7.stairFillsAt, undefined);
  assert.deepEqual(plan.floors.find((p) => p.floor === 8)!.help, ["mobility"]);
  assert.equal(plan.floors.find((p) => p.floor === 6)!.help, undefined);
});

test("7-break: people totals match the fixture", () => {
  const f = asForecast(forecast7Break);
  const plan = planExits(f.exits, 7);
  const total = f.exits.reduce((n, e) => n + e.people, 0);
  assert.equal(plan.peopleAtRisk, 54);
  assert.equal(plan.peopleAtRisk, f.summary.peopleAtRisk);
  assert.equal(plan.floorsAtRisk, f.summary.floorsAtRisk.length);
  assert.deepEqual(plan.notAtRisk, { floors: 5, people: total - 54 });
});

test("10-east: only the fire floor is at risk", () => {
  const f = asForecast(forecast10East);
  const plan = planExits(f.exits, 10);
  assert.deepEqual(
    plan.floors.map((p) => p.floor),
    f.summary.floorsAtRisk,
  );
  assert.equal(plan.peopleAtRisk, f.summary.peopleAtRisk);
  assert.deepEqual(plan.byStair, [{ stair: "Stairwell B", floors: "10", people: 11 }]);
});

test("noClearStair: no stairwell, or the best one fills too", () => {
  const exits: FloorExit[] = [
    { floor: 3, people: 10, flags: [], stair: "stair-a", blockedAt: { "stair-a": null, "stair-b": 9 }, atRiskAt: null },
    { floor: 4, people: 12, flags: ["mobility"], stair: null, blockedAt: {}, atRiskAt: 3 },
    { floor: 5, people: 8, flags: [], stair: "stair-b", blockedAt: { "stair-a": 6, "stair-b": 20 }, atRiskAt: 5 },
    { floor: 6, people: 7, flags: [], stair: "stair-a", blockedAt: { "stair-a": null, "stair-b": null }, atRiskAt: null },
  ];
  const plan = planExits(exits, 4);
  assert.deepEqual(plan.noClearStair, [
    { floor: 4, people: 12, stair: "none", fillsAt: null, help: ["mobility"] },
    { floor: 5, people: 8, stair: "Stairwell B", fillsAt: 20 },
  ]);
  assert.equal(Object.keys(plan)[0], "noClearStair");
  assert.equal(plan.floors.find((p) => p.floor === 5)!.stairFillsAt, 20);
  assert.deepEqual(plan.floors.find((p) => p.floor === 4)!.othersFill, {});
  assert.deepEqual(plan.byStair, [
    { stair: "Stairwell A", floors: "3", people: 10 },
    { stair: "none", floors: "4", people: 12 },
    { stair: "Stairwell B", floors: "5", people: 8 },
  ]);
  assert.deepEqual(plan.notAtRisk, { floors: 1, people: 7 });
});

test("floorRange joins runs", () => {
  assert.equal(floorRange([8, 6, 7, 10, 12, 11]), "6-8, 10-12");
  assert.equal(floorRange([3]), "3");
});

test("tool: uses run.forecast, stores run.exits, stays small", async () => {
  const f = asForecast(forecast7Break);
  const { server, calls } = fakeServer(f);
  const env = envWith(server, { forecast: f });
  const out = (await findClearExitsTool.run({}, env)) as ExitPlan;
  assert.equal(calls.length, 0);
  assert.equal(env.run.exits, f.exits);
  assert.equal(out.originFloor, 7);
  assert.ok(JSON.stringify(out).length < 1200, `${JSON.stringify(out).length} bytes`);
  assert.equal(findClearExitsTool.schema.function.name, "find_clear_exits");
});

test("tool: no forecast but an origin -> calls server.forecast once", async () => {
  const f = asForecast(forecast7Break);
  const { server, calls } = fakeServer(f);
  const env = envWith(server, { origin: { roomId: "7-break", roomName: "Floor 7 Break Room", confidence: 0.9 } });
  const out = (await findClearExitsTool.run({}, env)) as ExitPlan;
  assert.deepEqual(calls, ["7-break"]);
  assert.equal(env.run.forecast, f);
  assert.equal(env.run.exits, f.exits);
  assert.equal(out.peopleAtRisk, 54);
});

test("tool: neither forecast nor origin -> error, no server call", async () => {
  const { server, calls } = fakeServer(asForecast(forecast7Break));
  const env = envWith(server);
  assert.deepEqual(await findClearExitsTool.run({}, env), { error: "no forecast yet: call run_spread first" });
  assert.equal(calls.length, 0);
  assert.equal(env.run.exits, undefined);
});

test("tool: a failing server.forecast -> error, not a throw", async () => {
  const server: ServerApi = { ...fakeServer(asForecast(forecast7Break)).server, forecast: () => Promise.reject(new Error("unknown origin")) };
  const env = envWith(server, { origin: { roomId: "7-nope", roomName: "?", confidence: 0.5 } });
  const out = (await findClearExitsTool.run({}, env)) as { error: string };
  assert.match(out.error, /unknown origin/);
});

test("tool: floors filter limits the per-floor list only", async () => {
  const f = asForecast(forecast7Break);
  const env = envWith(fakeServer(f).server, { forecast: f });
  const out = (await findClearExitsTool.run({ floors: [8, 10, 3] }, env)) as ExitPlan;
  assert.deepEqual(
    out.floors.map((p) => p.floor),
    [8, 10],
  );
  assert.deepEqual(out.requestedNotAtRisk, [3]);
  assert.equal(out.peopleAtRisk, 54);
  assert.deepEqual(out.byStair, [{ stair: "Stairwell A", floors: "6-12", people: 54 }]);
});

test("tool: bad floors argument -> error", async () => {
  const f = asForecast(forecast7Break);
  const env = envWith(fakeServer(f).server, { forecast: f });
  for (const floors of ["7", [7, "8"], [7.5], { a: 1 }]) {
    const out = (await findClearExitsTool.run({ floors }, env)) as { error?: string };
    assert.ok(out.error, JSON.stringify(floors));
  }
});
