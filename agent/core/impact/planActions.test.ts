// No network: checks plan_actions against small hand-built buildings and failure chains.
//   npx tsx --test core/impact/planActions.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateCost } from "./cost.ts";
import { applyActions, alternateRoad, MAX_ACTIONS_PER_BUILDING, planActions, planActionsTool } from "./planActions.ts";
import type {
  AffectedProperty,
  AgentIncident,
  FailureStep,
  ImpactRun,
  PlannedAction,
  PortfolioBuilding,
  PortfolioSystem,
} from "./types.ts";

// ---- Fixtures ----

const HERE = { lat: 32.99, lon: -96.75 };
const EAST = { lat: 32.99, lon: -96.74 };

const sys = (id: string, kind: PortfolioSystem["kind"], more: Partial<PortfolioSystem> = {}): PortfolioSystem => ({
  id,
  kind,
  label: id,
  dependsOn: [],
  level: "ground",
  restoreHours: 1,
  damageUsd: 0,
  ...more,
});

function dataCenter(opts: { generator?: boolean } = {}): PortfolioBuilding {
  return {
    id: "dc-1",
    name: "Telecom Corridor DC",
    address: "1 Test Way",
    use: "data_center",
    location: HERE,
    elevationM: 190,
    occupancy: { day: 80, night: 20 },
    systems: [
      sys("utility", "utility_power", { label: "Utility feed", restoreHours: 2 }),
      sys("elec", "electrical_room", { label: "Main switchgear", level: "basement", dependsOn: ["utility"], backups: ["generator"], restoreHours: 12, damageUsd: 150_000 }),
      ...(opts.generator === false ? [] : [sys("generator", "generator", { label: "Generator 1", dependsOn: ["fuel"], runtimeHours: 24, restoreHours: 4 })]),
      sys("fuel", "fuel_supply", { label: "Diesel tank", restoreHours: 1 }),
      sys("intake", "air_intake", { label: "Rooftop intake", level: "roof", facingDegrees: 90, restoreHours: 2 }),
      sys("ahu", "hvac", { label: "AHU-1", level: "roof", dependsOn: ["intake"], restoreHours: 6, damageUsd: 20_000 }),
      sys("cooling", "cooling", { label: "CRAC units", dependsOn: ["elec", "ahu"], restoreHours: 4 }),
      sys("ups", "ups", { label: "UPS bank", level: "basement", dependsOn: ["elec"], lagMinutes: 10, restoreHours: 1 }),
      sys("servers", "servers", { label: "Server hall", dependsOn: ["cooling", "ups"], restoreHours: 8, damageUsd: 50_000 }),
    ],
    tenants: [
      { name: "CloudCo", slaPenaltyPerHour: 10_000, rentPerMonth: 200_000, dependsOn: ["servers"] },
      { name: "Bistro", slaPenaltyPerHour: 0, rentPerMonth: 5_000, dependsOn: ["ahu"] },
    ],
    access: { roads: ["Coit Rd", "Campbell Rd"], fuelRoute: "Coit Rd" },
  };
}

const step = (id: string, minute: number, systemId: string, hazard: FailureStep["hazard"], causedBy: string | null, incidentId = "fire-1"): FailureStep => ({
  id: `dc-1:${id}`,
  minute,
  systemId,
  label: id,
  hazard,
  causedBy: causedBy && `dc-1:${causedBy}`,
  incidentId,
});

/** Smoke through the intake, water in the switchgear, and a crash on the fuel route. */
const FULL_CHAIN: FailureStep[] = [
  step("intake", 4, "intake", "smoke", null),
  step("ahu", 5, "ahu", "smoke", "intake"),
  step("servers-smoke", 9, "servers", "smoke", "ahu"),
  step("elec", 12, "elec", "water", null, "flood-1"),
  step("cooling", 12, "cooling", "power", "elec", "flood-1"),
  step("servers-heat", 20, "servers", "heat", "cooling", "flood-1"),
  step("ups", 22, "ups", "power", "elec", "flood-1"),
  step("fuel", 120, "fuel", "access", null, "crash-1"),
  step("generator", 1560, "generator", "power", "fuel", "crash-1"),
];

function property(chain: FailureStep[], building = dataCenter()): AffectedProperty {
  const cost = estimateCost(building, chain);
  return {
    id: building.id,
    name: building.name,
    use: building.use,
    location: building.location,
    risk: "high",
    incidentIds: [...new Set(chain.map((s) => s.incidentId))],
    chain,
    people: 80,
    downtimeHours: cost.downtimeHours,
    cost: { slaUsd: cost.slaUsd, lostRentUsd: cost.lostRentUsd, damageUsd: cost.damageUsd, totalUsd: cost.totalUsd },
    accessCut: false,
    actions: [],
    reasons: [],
  };
}

const INCIDENTS: AgentIncident[] = [
  { id: "fire-1", kind: "fire", severity: "critical", location: EAST, inBuilding: false },
  { id: "flood-1", kind: "flood", severity: "serious", location: { lat: 33.0, lon: -96.75 } },
  {
    id: "crash-1",
    kind: "crash",
    severity: "serious",
    location: { lat: 32.98, lon: -96.75 },
    lanesBlocked: "all",
    affectedRoads: [{ path: [], road: "Coit Rd", reason: "crash", fromMinute: 0 }],
    crash: { road: "Coit Rd", segments: [], steps: [], alternateRoads: ["Renner Rd"], summary: "", assumptions: [] },
  },
];

const plan = (chain = FULL_CHAIN, building = dataCenter(), incidents = INCIDENTS) =>
  planActions(property(chain, building), building, incidents);
const find = (actions: PlannedAction[], slug: string) => actions.find((a) => a.id === `dc-1:${slug}`);

// ---- The rules ----

test("smoke at the intake: one close-dampers action on the root step, a minute early", () => {
  const a = find(plan(), "close-dampers");
  assert.ok(a);
  assert.deepEqual(a.prevents, ["dc-1:intake"]);
  assert.equal(a.deadlineMinute, 3);
  assert.match(a.text, /east-facing/);
  assert.match(a.text, /AHU-1 to recirculate/);
});

test("water in the switchgear: flood barriers 3 minutes before, naming what they protect", () => {
  const a = find(plan(), "flood-barriers");
  assert.ok(a);
  assert.deepEqual(a.prevents, ["dc-1:elec"]);
  assert.equal(a.deadlineMinute, 9);
  assert.match(a.text, /north-side loading dock/);
  assert.match(a.text, /Main switchgear/);
});

test("the generator action stops the power-loss steps under the electrical room, now", () => {
  const a = find(plan(), "start-generator");
  assert.ok(a);
  assert.equal(a.deadlineMinute, 0);
  assert.deepEqual([...a.prevents].sort(), ["dc-1:cooling", "dc-1:ups"]);
  assert.match(a.text, /Generator 1/);
});

test("no generator action without a generator, or when the generator fails first", () => {
  assert.equal(find(plan(FULL_CHAIN, dataCenter({ generator: false })), "start-generator"), undefined);
  const early = FULL_CHAIN.map((s) => (s.systemId === "generator" ? { ...s, minute: 5 } : s));
  assert.equal(find(plan(early), "start-generator"), undefined);
});

test("fuel reroute names an unblocked road, never the blocked fuel route", () => {
  const a = find(plan(), "reroute-fuel");
  assert.ok(a);
  assert.match(a.text, /via Campbell Rd/);
  assert.match(a.text, /Coit Rd is blocked/);
  assert.equal(a.deadlineMinute, 60);
  assert.deepEqual(a.prevents, ["dc-1:fuel"]);

  // Campbell blocked too: falls back to the crash's alternate road.
  const both = INCIDENTS.map((i) =>
    i.id === "crash-1" ? { ...i, affectedRoads: [...i.affectedRoads!, { path: [], road: "Campbell Rd", reason: "flood" as const, fromMinute: 0 }] } : i,
  );
  assert.match(find(plan(FULL_CHAIN, dataCenter(), both), "reroute-fuel")!.text, /via Renner Rd/);
  assert.equal(alternateRoad(dataCenter(), both), "Renner Rd");

  // Nothing open: no reroute.
  const none = both.map((i) => (i.id === "crash-1" ? { ...i, crash: { ...i.crash!, alternateRoads: ["Campbell Rd"] } } : i));
  assert.equal(find(plan(FULL_CHAIN, dataCenter(), none), "reroute-fuel"), undefined);
});

test("server heat: shed load stops the heat step", () => {
  const a = find(plan(), "shed-load");
  assert.ok(a);
  assert.deepEqual(a.prevents, ["dc-1:servers-heat"]);
  assert.equal(a.deadlineMinute, 18);
  assert.match(a.text, /Server hall/);
});

test("fire evacuation goes out the side away from the incident; SLA tenants are named", () => {
  const chain = [...FULL_CHAIN.slice(0, 3), step("evac", 6, "building", "fire", null)];
  const actions = plan(chain);
  const evac = find(actions, "evacuate");
  assert.ok(evac);
  assert.match(evac.text, /west-side exits/);
  assert.equal(evac.savesUsd, 0);
  assert.deepEqual(evac.prevents, []);
  assert.equal(evac.deadlineMinute, 0);
  const sla = find(actions, "notify-sla");
  assert.ok(sla);
  assert.equal(sla.text, "Notify tenants with SLAs: CloudCo");
  assert.equal(sla.savesUsd, 0);
});

test("hospital: medical gas to reserve cylinders, and critical patients moved", () => {
  const b: PortfolioBuilding = {
    ...dataCenter(),
    id: "dc-1",
    use: "hospital",
    systems: [
      sys("elec", "electrical_room", { label: "Switchgear", level: "basement", restoreHours: 12 }),
      sys("o2", "medical_gas", { label: "Oxygen manifold", dependsOn: ["elec"], restoreHours: 6, damageUsd: 10_000 }),
    ],
    tenants: [{ name: "ICU", slaPenaltyPerHour: 0, rentPerMonth: 100_000, dependsOn: ["o2"] }],
  };
  const chain = [step("elec", 10, "elec", "water", null, "flood-1"), step("o2", 15, "o2", "power", "elec", "flood-1")];
  const actions = plan(chain, b);
  const gas = find(actions, "medical-gas");
  assert.ok(gas);
  assert.deepEqual(gas.prevents, ["dc-1:o2"]);
  assert.equal(gas.deadlineMinute, 13);
  assert.ok(find(actions, "move-patients"));
});

// ---- The invariants ----

test("deadlines are before the steps they stop and never negative; prevents are real ids", () => {
  const atZero = FULL_CHAIN.map((s) => ({ ...s, minute: Math.max(0, s.minute - 12) }));
  for (const chain of [FULL_CHAIN, atZero]) {
    const ids = new Map(chain.map((s) => [s.id, s]));
    for (const a of plan(chain)) {
      assert.ok(a.deadlineMinute >= 0, a.id);
      assert.equal(a.status, "pending");
      for (const p of a.prevents) {
        const s = ids.get(p);
        assert.ok(s, `${a.id} prevents unknown ${p}`);
        assert.ok(a.deadlineMinute === 0 || a.deadlineMinute < s.minute, `${a.id} deadline ${a.deadlineMinute} vs ${s.minute}`);
      }
    }
  }
});

test("savesUsd is the standalone saving under estimateCost", () => {
  const b = dataCenter();
  const base = estimateCost(b, FULL_CHAIN).totalUsd;
  const actions = plan();
  assert.ok(actions.some((a) => a.savesUsd > 0));
  for (const a of actions) assert.equal(a.savesUsd, base - estimateCost(b, FULL_CHAIN, a.prevents).totalUsd, a.id);
});

test("two smoke roots make one damper action covering both", () => {
  const b = dataCenter();
  b.systems.push(sys("intake2", "air_intake", { label: "West intake", level: "roof", facingDegrees: 270 }));
  const chain = [step("intake", 4, "intake", "smoke", null), step("intake2", 6, "intake2", "smoke", null), step("ahu", 7, "ahu", "smoke", "intake")];
  const dampers = plan(chain, b).filter((a) => a.id.endsWith(":close-dampers"));
  assert.equal(dampers.length, 1);
  assert.deepEqual(dampers[0]!.prevents, ["dc-1:intake", "dc-1:intake2"]);
  assert.equal(dampers[0]!.deadlineMinute, 3);
});

test("ordered by deadline then savings, ids unique, at most the cap", () => {
  const actions = plan();
  assert.ok(actions.length <= MAX_ACTIONS_PER_BUILDING);
  assert.equal(new Set(actions.map((a) => a.id)).size, actions.length);
  for (let i = 1; i < actions.length; i++) {
    const [p, c] = [actions[i - 1]!, actions[i]!];
    assert.ok(p.deadlineMinute < c.deadlineMinute || (p.deadlineMinute === c.deadlineMinute && p.savesUsd >= c.savesUsd), `${p.id} before ${c.id}`);
  }
  // Same input, same output.
  assert.deepEqual(plan(), actions);
});

test("an empty chain plans nothing", () => {
  assert.deepEqual(plan([]), []);
});

// ---- applyActions ----

test("applyActions lowers the cost, and execute order does not matter", () => {
  const b = dataCenter();
  const p = { ...property(FULL_CHAIN, b), actions: plan() };
  const ids = ["dc-1:close-dampers", "dc-1:start-generator", "dc-1:flood-barriers"];
  const one = applyActions(p, b, [ids[0]!]);
  assert.ok(one.cost.totalUsd < p.cost.totalUsd);
  assert.equal(one.property.actions.find((a) => a.id === ids[0])!.status, "done");
  assert.equal(p.actions.find((a) => a.id === ids[0])!.status, "pending", "input is not mutated");

  const forward = applyActions(applyActions(applyActions(p, b, [ids[0]!]).property, b, [ids[1]!]).property, b, [ids[2]!]);
  const backward = applyActions(applyActions(p, b, [ids[2]!, ids[1]!]).property, b, [ids[0]!]);
  assert.deepEqual(forward.cost, backward.cost);
  assert.deepEqual(forward.cost, applyActions(p, b, ids).cost);
  assert.ok(forward.cost.totalUsd < one.cost.totalUsd);
  assert.equal(applyActions(p, b, []).cost.totalUsd, p.cost.totalUsd);
});

// ---- The tool ----

function makeRun(properties?: AffectedProperty[]): ImpactRun {
  return {
    incidents: INCIDENTS,
    portfolio: [dataCenter()],
    opts: { horizonMinutes: 30, now: 0 },
    impacts: {},
    actions: {},
    ...(properties ? { properties } : {}),
  };
}

test("the tool is named plan_actions and errors before assess_property_impact", () => {
  assert.equal(planActionsTool.schema.function.name, "plan_actions");
  const out = planActionsTool.run({}, makeRun()) as { error?: string };
  assert.match(out.error ?? "", /assess_property_impact first/);
});

test("the tool writes run.actions and property.actions and returns a small summary", () => {
  const p = property(FULL_CHAIN);
  const run = makeRun([p]);
  const out = planActionsTool.run({}, run) as {
    properties: { id: string; name: string; actions: { text: string; deadlineMinute: number; savesUsd: number }[] }[];
    totalSavesUsd: number;
  };
  assert.equal(run.actions["dc-1"]!.length, out.properties[0]!.actions.length);
  assert.equal(p.actions, run.actions["dc-1"]);
  assert.deepEqual(Object.keys(out.properties[0]!.actions[0]!).sort(), ["deadlineMinute", "savesUsd", "text"]);
  const b = dataCenter();
  const allDone = estimateCost(b, FULL_CHAIN, p.actions.flatMap((a) => a.prevents)).totalUsd;
  assert.equal(out.totalSavesUsd, p.cost.totalUsd - allDone);

  // Filtered to ids the model names; unknown ones are reported back.
  const run2 = makeRun([property(FULL_CHAIN)]);
  const out2 = planActionsTool.run({ property_ids: ["nope"] }, run2) as { properties: unknown[]; unknown: string[] };
  assert.deepEqual(out2.properties, []);
  assert.deepEqual(out2.unknown, ["nope"]);
  assert.deepEqual(run2.actions, {});
});
