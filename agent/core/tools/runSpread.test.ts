// No network: run_spread against a fake ServerApi that returns real POST /forecast responses.
//   npm test -w agent
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Building } from "@firewatch/shared/types";
import sharedBuilding from "@firewatch/shared/building.json" with { type: "json" };
import forecast7 from "../../fixtures/forecast-7-break.json" with { type: "json" };
import forecast10 from "../../fixtures/forecast-10-east.json" with { type: "json" };
import buildingInfo from "../../fixtures/building-info.json" with { type: "json" };
import { floorRanges, runSpreadTool, summariseForecast, type SpreadSummary } from "./runSpread.ts";
import type { BuildingInfo, Forecast, ServerApi, ToolEnv } from "./types.ts";

const building = sharedBuilding as Building;
const info = buildingInfo as unknown as BuildingInfo;

/** Strips `ok`, as ServerApi does. */
function asForecast({ ok: _ok, ...rest }: { ok: boolean } & Record<string, unknown>): Forecast {
  return rest as unknown as Forecast;
}
const FIXTURES: Record<string, Forecast> = {
  "7-break": asForecast(forecast7),
  "10-east": asForecast(forecast10),
};

function fakeServer(opts: { forecastFails?: boolean; buildingFails?: boolean } = {}) {
  const calls = { forecast: [] as [string, number | undefined][], getBuilding: 0 };
  const server: ServerApi = {
    async getState() {
      throw new Error("not used");
    },
    async getBuilding() {
      calls.getBuilding++;
      if (opts.buildingFails) throw new Error("GET /building: 500");
      return info;
    },
    async forecast(origin, minutes) {
      calls.forecast.push([origin, minutes]);
      if (opts.forecastFails) throw new Error("POST /forecast: 500 internal error");
      const f = FIXTURES[origin];
      if (!f) throw new Error(`no fixture for ${origin}`);
      return { ...f, minutes: minutes ?? 30 };
    },
    async lookupAddress() {
      throw new Error("not used");
    },
  };
  return { server, calls };
}

function envWith(server: ServerApi, origin?: string): ToolEnv {
  return {
    ctx: { building, server },
    heard: "",
    run: {
      report: { id: "r1", text: "smoke", caller: "+1", time: 0 },
      ...(origin ? { origin: { roomId: origin, roomName: origin, confidence: 0.9 } } : {}),
    },
  };
}

const run = (args: Record<string, unknown>, env: ToolEnv) => runSpreadTool.run(args, env) as Promise<SpreadSummary & { error?: string }>;

test("schema name is run_spread", () => {
  assert.equal(runSpreadTool.schema.function.name, "run_spread");
});

test("floorRanges compresses floor lists", () => {
  assert.equal(floorRanges([12, 6, 7, 8, 9, 10, 11]), "6-12");
  assert.equal(floorRanges([3, 5, 6, 7, 10]), "3, 5-7, 10");
  assert.equal(floorRanges([]), "");
});

test("summary for 7-break: stair-b fills first at minute 11 on floors 6-12", () => {
  const s = summariseForecast(FIXTURES["7-break"]!, building, "active");
  assert.equal(s.origin, "7-break");
  assert.equal(s.originName, "Floor 7 Break Room");
  assert.equal(s.peopleAtRisk, 54);
  assert.deepEqual(s.floorsAtRisk, [6, 7, 8, 9, 10, 11, 12]);
  assert.deepEqual(s.stairsSmoky, { "stair-b": { firstSmokyMinute: 11, floors: "6-12" } });
  assert.deepEqual(s.stairsClear, ["stair-a"]);
  assert.deepEqual(s.roomsBurningAtEnd, ["7-break", "7-stair-b"]);
  assert.equal(s.originSprinkler, "active");
});

test("summary for 10-east: both stairwells stay clear", () => {
  const s = summariseForecast(FIXTURES["10-east"]!, building);
  assert.deepEqual(s.stairsSmoky, {});
  assert.deepEqual(s.stairsClear, ["stair-a", "stair-b"]);
  assert.equal(s.originSprinkler, undefined);
});

test("default origin comes from run.origin, with 30 minutes", async () => {
  const { server, calls } = fakeServer();
  const env = envWith(server, "7-break");
  const out = await run({}, env);
  assert.equal(out.error, undefined);
  assert.equal(out.origin, "7-break");
  assert.deepEqual(calls.forecast, [["7-break", 30]]);
  assert.equal(env.run.forecast?.origin, "7-break");
  assert.equal(env.run.forecast?.exits.length, 12);
  assert.equal(out.originSprinkler, info.sprinklers["7-break"]);
});

test("an explicit origin arg wins over run.origin", async () => {
  const { server, calls } = fakeServer();
  const out = await run({ origin: "10-east", minutes: 20 }, envWith(server, "7-break"));
  assert.equal(out.origin, "10-east");
  assert.equal(out.minutes, 20);
  assert.deepEqual(calls.forecast, [["10-east", 20]]);
});

test("unknown origin -> error naming the format, no server call", async () => {
  const { server, calls } = fakeServer();
  const out = await run({ origin: "break room" }, envWith(server));
  assert.match(out.error ?? "", /unknown room id "break room".*e.g. "1-break"/);
  assert.equal(calls.forecast.length, 0);
});

test("no origin anywhere -> error", async () => {
  const { server } = fakeServer();
  const out = await run({}, envWith(server));
  assert.deepEqual(out, { error: "no fire origin yet: call merge_reports first" });
});

test("bad minutes -> error", async () => {
  const { server, calls } = fakeServer();
  for (const minutes of [0, 61, 2.5, "soon"]) {
    const out = await run({ minutes }, envWith(server, "7-break"));
    assert.match(out.error ?? "", /minutes must be an integer from 1 to 60/);
  }
  assert.equal(calls.forecast.length, 0);
});

test("same origin and minutes again -> reuses run.forecast, no new server call", async () => {
  const { server, calls } = fakeServer();
  const env = envWith(server, "7-break");
  const first = await run({}, env);
  const stored = env.run.forecast;
  const second = await run({ origin: "7-break", minutes: 30 }, env);
  assert.equal(calls.forecast.length, 1);
  assert.equal(env.run.forecast, stored);
  assert.equal(second.cached, true);
  assert.deepEqual({ ...second, cached: undefined }, { ...first, cached: undefined });
  await run({ minutes: 15 }, env); // different minutes -> a new call
  assert.equal(calls.forecast.length, 2);
  assert.equal(env.run.forecast?.minutes, 15);
});

test("server error -> { error }, no throw", async () => {
  const { server } = fakeServer({ forecastFails: true });
  const env = envWith(server, "7-break");
  const out = await run({}, env);
  assert.match(out.error ?? "", /forecast failed: POST \/forecast: 500/);
  assert.equal(env.run.forecast, undefined);
});

test("getBuilding failing does not fail the tool", async () => {
  const { server } = fakeServer({ buildingFails: true });
  const out = await run({}, envWith(server, "7-break"));
  assert.equal(out.error, undefined);
  assert.equal(out.peopleAtRisk, 54);
  assert.equal(out.originSprinkler, undefined);
});

test("output stays under 800 characters of JSON", async () => {
  const { server } = fakeServer();
  for (const origin of ["7-break", "10-east"]) {
    const out = await run({ origin }, envWith(server));
    assert.ok(JSON.stringify(out).length < 800, JSON.stringify(out));
  }
  // A worst case: many burning rooms and both stairs smoky on every floor.
  const all = building.rooms.map((r) => r.id);
  const everyFloor = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`${i + 1}`, i + 3]));
  const big: Forecast = {
    ...FIXTURES["7-break"]!,
    summary: {
      floorsAtRisk: Array.from({ length: 12 }, (_, i) => i + 1),
      peopleAtRisk: 999,
      stairBlocked: { "stair-a": everyFloor, "stair-b": everyFloor },
      roomsBurningAtEnd: all,
    },
  };
  const s = summariseForecast(big, building, "impaired");
  assert.ok(JSON.stringify(s).length < 800, `${JSON.stringify(s).length}`);
  assert.equal(s.roomsBurningAtEnd.at(-1), `+${all.length - 8} more`);
});
