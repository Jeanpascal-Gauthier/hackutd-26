// No network: find_building against a fake ServerApi.
//   npm test -w agent
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Building, BuildingLookup } from "@firewatch/shared/types";
import sharedBuilding from "@firewatch/shared/building.json" with { type: "json" };
import { syntheticBuilding } from "../../fixtures/synthetic.ts";
import { addressTokens, findBuildingTool, sameAddress } from "./findBuilding.ts";
import type { RunState, ServerApi, ToolEnv } from "./types.ts";

const demo = sharedBuilding as Building;

const lookupFor = (query: string, status: BuildingLookup["status"] = "searching"): BuildingLookup => ({
  query,
  status,
  candidates: [],
  time: 1,
});

function fakeServer(fails = false) {
  const calls: [string, string | undefined][] = [];
  const server: ServerApi = {
    getState: () => Promise.reject(new Error("not used")),
    getBuilding: () => Promise.reject(new Error("not used")),
    forecast: () => Promise.reject(new Error("not used")),
    lookupAddress: async (address, caller) => {
      calls.push([address, caller]);
      if (fails) throw new Error("POST /incident/address failed: HTTP 503 geocoder not configured");
      return { ...lookupFor(address), caller, match: { formatted: `${address}, USA`, lat: 1, lon: 2 } };
    },
  };
  return { server, calls };
}

function env(server: ServerApi, heard: string, building: Building = demo, currentLookup?: BuildingLookup): ToolEnv {
  const run: RunState = { report: { id: "r1", text: heard, caller: "+15550100", time: 0 } };
  if (currentLookup) run.currentLookup = currentLookup;
  return { ctx: { building, server }, heard, run };
}

const run = (args: Record<string, unknown>, e: ToolEnv) => findBuildingTool.run(args, e) as Promise<Record<string, unknown>>;

test("schema: find_building with a required address", () => {
  assert.equal(findBuildingTool.schema.function.name, "find_building");
  assert.deepEqual(findBuildingTool.schema.function.parameters?.required, ["address"]);
});

test("a new address starts a lookup with the caller, and marks the run", async () => {
  const { server, calls } = fakeServer();
  const e = env(server, "fire at 800 West Campbell Road in Richardson, third floor");
  const out = await run({ address: "800 W Campbell Rd, Richardson" }, e);
  assert.deepEqual(calls, [["800 W Campbell Rd, Richardson", "+15550100"]]);
  assert.equal(out.started, true);
  assert.equal(out.status, "searching");
  assert.equal(out.match, "800 W Campbell Rd, Richardson, USA");
  assert.equal(e.run.lookup?.query, "800 W Campbell Rd, Richardson");
});

test("the active building's address: no lookup, carry on", async () => {
  const { server, calls } = fakeServer();
  const b = syntheticBuilding({ address: "800 W Campbell Rd, Richardson, TX 75080" });
  const e = env(server, "smoke at 800 west campbell road on floor 2", b);
  const out = await run({ address: "800 West Campbell Road" }, e);
  assert.equal(out.started, false);
  assert.match(String(out.reason), /active building/);
  assert.equal(calls.length, 0);
  assert.equal(e.run.lookup, undefined);
});

test("the same address as the lookup in progress: no second lookup; a failed one may be retried", async () => {
  const { server, calls } = fakeServer();
  const heard = "it's 1313 Broadway, Tacoma";
  const pending = await run({ address: "1313 Broadway, Tacoma" }, env(server, heard, demo, lookupFor("1313 broadway tacoma", "needs_confirmation")));
  assert.equal(pending.started, false);
  assert.match(String(pending.reason), /already needs confirmation/);
  assert.equal(calls.length, 0);
  const retried = await run({ address: "1313 Broadway, Tacoma" }, env(server, heard, demo, lookupFor("1313 Broadway, Tacoma", "failed")));
  assert.equal(retried.started, true);
  assert.equal(calls.length, 1);
});

test("an address the caller never said is refused", async () => {
  const { server, calls } = fakeServer();
  const out = await run({ address: "1600 Pennsylvania Ave, Washington" }, env(server, "smoke on the 7th floor"));
  assert.match(String(out.error), /never said/);
  assert.equal(calls.length, 0);
});

test("bad arguments and server failures come back as errors; the run keeps going", async () => {
  const { server } = fakeServer(true);
  assert.match(String((await run({}, env(server, "x"))).error), /address must be/);
  assert.match(String((await run({ address: "x".repeat(300) }, env(server, "x"))).error), /address must be/);
  const e = env(server, "fire at 800 Campbell Rd");
  const out = await run({ address: "800 Campbell Rd" }, e);
  assert.match(String(out.error), /lookup failed .*continue with locate_room/);
  assert.equal(e.run.lookup, undefined);
});

test("address matching ignores case, punctuation and common abbreviations", () => {
  assert.deepEqual(addressTokens("800 West Campbell Road, Richardson"), ["800", "w", "campbell", "rd", "richardson"]);
  assert.ok(sameAddress("800 W. Campbell Rd", "800 West Campbell Road, Richardson, TX"));
  assert.ok(!sameAddress("800 W Campbell Rd", "801 W Campbell Rd"));
  assert.ok(!sameAddress("", "800 W Campbell Rd"));
});
