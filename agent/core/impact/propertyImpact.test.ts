// No network: assess_property_impact against the demo portfolio and incidents, plus small
// hand-built buildings for the generator, smoke-fallback and road-matching rules.
//   npx tsx --test core/impact/propertyImpact.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { GeoPoint } from "@firewatch/shared/types";
import portfolioJson from "../../fixtures/portfolio.json" with { type: "json" };
import { DEMO_CRASH, DEMO_FIRE, DEMO_FLOOD, DEMO_INCIDENTS, DEMO_NOW } from "../../fixtures/demoIncidents.ts";
import { estimateCost } from "./cost.ts";
import { offsetPoint } from "./geo.ts";
import { assessPropertyImpact, assessPropertyImpactTool, isDaytime, sameRoad, type AssessSummary } from "./propertyImpact.ts";
import type { AffectedProperty, AgentIncident, AssessOptions, BlastImpact, ImpactRun, PortfolioBuilding, PortfolioSystem } from "./types.ts";

const PORTFOLIO = portfolioJson as PortfolioBuilding[];
const DC = "dc-lookout";
const HOUR = 3_600_000;

/** Fixed zones, so these tests don't depend on classify_blast_radius's exact numbers. */
const IMPACTS: Record<string, BlastImpact> = {
  [DEMO_FIRE.id]: { center: DEMO_FIRE.location, radiusMeters: 450, stretch: { towardDegrees: 45, factor: 1.67 }, reasons: [] },
  [DEMO_CRASH.id]: { center: DEMO_CRASH.location, radiusMeters: 300, reasons: [] },
  [DEMO_FLOOD.id]: { center: DEMO_FLOOD.location, radiusMeters: 840, reasons: [] },
};

const assess = (incidents: AgentIncident[], opts: AssessOptions = {}) =>
  assessPropertyImpact(incidents, PORTFOLIO, { now: DEMO_NOW, impacts: IMPACTS, ...opts });
const find = (props: AffectedProperty[], id: string) => props.find((p) => p.id === id);
const dcOf = (props: AffectedProperty[]) => find(props, DC)!;
/** [minute, systemId, causedBy systemId | null] per step. */
const shape = (p: AffectedProperty) => p.chain.map((s) => [s.minute, s.systemId, s.causedBy?.split(":")[1] ?? null]);
const total = (props: AffectedProperty[]) => props.reduce((s, p) => s + p.cost.totalUsd, 0);
const within = (actual: number, target: number, tol = 0.15) => Math.abs(actual - target) <= target * tol;

// ---- Hand-built buildings ----

const HERE: GeoPoint = { lat: 32.9, lon: -96.8 };
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
function building(id: string, location: GeoPoint, systems: PortfolioSystem[], more: Partial<PortfolioBuilding> = {}): PortfolioBuilding {
  return {
    id,
    name: id,
    address: "1 Test Way",
    use: "office",
    location,
    elevationM: 190,
    occupancy: { day: 100, night: 10 },
    systems,
    tenants: [{ name: "Tenant", slaPenaltyPerHour: 1000, rentPerMonth: 10_000, dependsOn: ["servers"] }],
    access: { roads: ["Side St"] },
    ...more,
  };
}

// ---- The demo, computed once so the numbers can go in the test name ----

const ALL = assess(DEMO_INCIDENTS);
const ALL_DC = dcOf(ALL);
const AFTER_DC_ACTIONS = (() => {
  // "Close dampers" stops the smoke reaching the intake; "flood barriers" stops the electrical room flooding.
  const roots = ALL_DC.chain.filter((s) => s.causedBy === null && (s.hazard === "smoke" || s.hazard === "water")).map((s) => s.id);
  const dcBuilding = PORTFOLIO.find((b) => b.id === DC)!;
  return total(ALL) - ALL_DC.cost.totalUsd + estimateCost(dcBuilding, ALL_DC.chain, roots).totalUsd;
})();
const PEOPLE = ALL.reduce((s, p) => s + p.people, 0);

test(`demo totals: ${ALL.length} buildings, ${PEOPLE} people, $${total(ALL)} at risk (data center $${ALL_DC.cost.totalUsd}), $${AFTER_DC_ACTIONS} after the data center's actions`, () => {
  console.log(
    ALL.map((p) => `${p.name.padEnd(28)} ${p.risk.padEnd(8)} ${String(p.people).padStart(4)} people  $${String(p.cost.totalUsd).padStart(7)}  ${p.chain[0] ? `minute ${p.chain[0].minute}: ${p.chain[0].label}` : "-"}`).join("\n"),
  );
  assert.equal(ALL.length, 6);
  assert.ok(within(PEOPLE, 1240), `people ${PEOPLE}`);
  assert.ok(within(total(ALL), 380_000), `usd ${total(ALL)}`);
  assert.ok(within(ALL_DC.cost.totalUsd, 290_000), `data center ${ALL_DC.cost.totalUsd}`);
  assert.ok(within(AFTER_DC_ACTIONS, 90_000), `after ${AFTER_DC_ACTIONS}`);
});

test("fire only: smoke at the data center intake at 8 -> HVAC -> cooling -> servers, each caused by the last", () => {
  const dc = dcOf(assess([DEMO_FIRE]));
  assert.deepEqual(shape(dc), [
    [8, "air_intake", null],
    [9, "hvac", "air_intake"],
    [11, "cooling", "hvac"],
    [26, "servers", "cooling"],
  ]);
  assert.equal(dc.chain[0]!.label, "Smoke reaches HVAC intake");
  assert.equal(dc.chain[0]!.hazard, "smoke");
  assert.equal(dc.chain.at(-1)!.label, "Servers overheat → SLA breach");
  assert.ok(dc.chain.every((s) => s.incidentId === DEMO_FIRE.id));
  assert.equal(dc.risk, "high");
  assert.ok(dc.reasons.includes("Downwind of the Campbell Rd fire: smoke at HVAC intake in 8 min"), dc.reasons.join(" | "));
  // A data center is not evacuated for smoke in its air handlers.
  assert.ok(!dc.chain.some((s) => s.systemId === "building"));
});

test("flood only: the electrical room floods at 12 and the generator carries the UPS: no SLA breach", () => {
  const dc = dcOf(assess([DEMO_FLOOD]));
  assert.deepEqual(shape(dc), [[12, "electrical_room", null]]);
  assert.equal(dc.chain[0]!.label, "Electrical room floods");
  assert.equal(dc.chain[0]!.hazard, "water");
  assert.equal(dc.risk, "moderate");
  assert.equal(dc.cost.slaUsd, 0);
  assert.equal(dc.cost.totalUsd, 38_000);
  assert.ok(dc.reasons.includes("Backup generator covers the UPS battery room from minute 12"), dc.reasons.join(" | "));
});

test("crash only: the fuel route is cut at 0 and the generator runs dry at 240", () => {
  const dc = dcOf(assess([DEMO_CRASH]));
  assert.deepEqual(shape(dc), [
    [0, "fuel_supply", null],
    [240, "generator", "fuel_supply"],
  ]);
  assert.deepEqual(dc.chain.map((s) => s.hazard), ["access", "access"]);
  assert.equal(dc.risk, "moderate");
  assert.equal(dc.cost.totalUsd, 0);
  assert.equal(dc.accessCut, false, "Lookout Dr is still open");
  assert.ok(dc.reasons.includes("Only fuel route (Coit Rd) blocked by crash: generator has 4 h of fuel"), dc.reasons.join(" | "));
});

test("linked incidents compound: all three cost more than any one, and flood + crash breaks the generator backup", () => {
  const dcAll = ALL_DC.cost.totalUsd;
  for (const inc of DEMO_INCIDENTS) {
    const one = assess([inc]);
    assert.ok(dcAll > (find(one, DC)?.cost.totalUsd ?? 0), inc.id);
    assert.ok(total(ALL) > total(one), inc.id);
  }
  assert.deepEqual(ALL_DC.incidentIds, DEMO_INCIDENTS.map((i) => i.id));
  assert.equal(ALL_DC.accessCut, true, "Coit Rd (crash) and Lookout Dr (flood) both blocked");

  // Flood + crash, no fire: generator starts at 12, runs dry 4 h later, the UPS then drains, servers overheat.
  const dc = dcOf(assess([DEMO_CRASH, DEMO_FLOOD]));
  assert.deepEqual(shape(dc), [
    [0, "fuel_supply", null],
    [12, "electrical_room", null],
    [252, "generator", "fuel_supply"],
    [262, "ups", "electrical_room"],
    [264, "cooling", "ups"],
    [277, "servers", "ups"],
  ]);
  assert.equal(dc.risk, "high");
  assert.ok(dc.cost.totalUsd > dcOf(assess([DEMO_FLOOD])).cost.totalUsd + dcOf(assess([DEMO_CRASH])).cost.totalUsd);
  assert.ok(dc.reasons.includes("Backup generator covers the UPS battery room from minute 12 until minute 262"), dc.reasons.join(" | "));
});

test("all three: the data center's big costs hang off the smoke and water first contacts", () => {
  const byId = new Map(ALL_DC.chain.map((s) => [s.id, s]));
  const root = (id: string): string => {
    let s = byId.get(id)!;
    while (s.causedBy) s = byId.get(s.causedBy)!;
    return s.systemId;
  };
  assert.equal(root(`${DC}:servers`), "air_intake");
  assert.equal(root(`${DC}:ups`), "electrical_room");
  assert.equal(root(`${DC}:generator`), "fuel_supply");
  assert.ok(ALL_DC.chain.every((s, i, c) => i === 0 || c[i - 1]!.minute <= s.minute), "time ordered");
  assert.ok(ALL_DC.chain.every((s) => s.causedBy === null || byId.has(s.causedBy)), "causedBy points into the chain");
});

test("upwind and far buildings are untouched", () => {
  for (const incidents of [[DEMO_FIRE], [DEMO_CRASH], [DEMO_FLOOD], DEMO_INCIDENTS]) {
    const ids = assess(incidents).map((p) => p.id);
    assert.ok(!ids.includes("lab-telecom-ridge"), "lab is upwind (SW) of the fire");
    assert.ok(!ids.includes("grocery-campbell-fresh"));
  }
  const fireOnly = assess([DEMO_FIRE]).map((p) => p.id);
  assert.ok(!fireOnly.includes("med-coit-creek"), "crosswind of the plume");
  assert.ok(!fireOnly.includes("office-lookout-commons"));
});

test("evacuation: smoke drawn into an occupied office's air handlers evacuates it", () => {
  const office = find(ALL, "office-campbell-point")!;
  const evac = office.chain.find((s) => s.systemId === "building")!;
  assert.equal(evac.label, "Smoke drawn inside → building must evacuate");
  assert.equal(evac.causedBy, "office-campbell-point:hvac");
  assert.equal(office.risk, "high");
  const mall = find(ALL, "retail-campbell-plaza")!;
  assert.ok(mall.chain.some((s) => s.hazard === "fire" && s.systemId === "electrical_room" && s.causedBy === null), "fire reaches the rear electrical room");
});

test("a backup generator holds the load until its fuel runs out; without one the UPS drains at once", () => {
  const floodAt = offsetPoint(HERE, 300, 0);
  const flood: AgentIncident = { id: "flood-x", kind: "flood", severity: "serious", location: floodAt };
  const crash: AgentIncident = {
    id: "crash-x",
    kind: "crash",
    severity: "serious",
    location: offsetPoint(HERE, 2000, 90),
    lanesBlocked: "all",
    affectedRoads: [{ path: [], road: "Main Street", reason: "crash", fromMinute: 3 }],
  };
  const impacts = { "flood-x": { center: floodAt, radiusMeters: 500, reasons: [] }, "crash-x": { center: crash.location, radiusMeters: 100, reasons: [] } };
  const systems = (generator: boolean) => [
    sys("utility", "utility_power"),
    sys("elec", "electrical_room", { level: "basement", dependsOn: ["utility"] }),
    sys("fuel", "fuel_supply"),
    ...(generator ? [sys("gen", "generator", { dependsOn: ["fuel"], runtimeHours: 2 })] : []),
    sys("ups", "ups", { dependsOn: ["elec"], backups: ["gen"], lagMinutes: 5 }),
    sys("servers", "servers", { dependsOn: ["ups"], lagMinutes: 10 }),
  ];
  const b = (generator: boolean) => building("b", HERE, systems(generator), { access: { roads: ["Main St", "Side St"], fuelRoute: "Main St" } });
  const run = (generator: boolean, incidents: AgentIncident[]) => assessPropertyImpact(incidents, [b(generator)], { now: DEMO_NOW, impacts })[0]!;

  // Water: 300 m at 30 m/min (no forecast) -> minute 10.
  assert.deepEqual(shape(run(true, [flood])), [[10, "elec", null]]);
  assert.deepEqual(shape(run(true, [flood, crash])), [
    [3, "fuel", null],
    [10, "elec", null],
    [130, "gen", "fuel"],
    [135, "ups", "elec"],
    [145, "servers", "ups"],
  ]);
  assert.deepEqual(shape(run(false, [flood])), [
    [10, "elec", null],
    [15, "ups", "elec"],
    [25, "servers", "ups"],
  ]);
});

test("smoke without a forecast: sooner downwind than crosswind, none upwind beyond 150 m", () => {
  const fire: AgentIncident = { id: "fire-x", kind: "fire", severity: "serious", location: HERE, wind: { speedMps: 5, fromDegrees: 270 } };
  const impacts = { "fire-x": { center: HERE, radiusMeters: 400, stretch: { towardDegrees: 90, factor: 2 }, reasons: [] } };
  const smoky = (id: string, at: GeoPoint) => building(id, at, [sys("intake", "air_intake"), sys("ahu", "hvac", { dependsOn: ["intake"] })]);
  const props = assessPropertyImpact(
    [fire],
    [
      smoky("downwind", offsetPoint(HERE, 380, 90)),
      smoky("crosswind", offsetPoint(HERE, 380, 20)),
      smoky("upwind", offsetPoint(HERE, 300, 270)),
      smoky("upwind-near", offsetPoint(HERE, 100, 270)),
      smoky("outside", offsetPoint(HERE, 1500, 0)),
    ],
    { now: DEMO_NOW, impacts },
  );
  const intakeAt = (id: string) => find(props, id)?.chain.find((s) => s.systemId === "intake")?.minute;
  assert.equal(intakeAt("downwind"), 3);
  assert.equal(intakeAt("crosswind"), 4);
  assert.equal(intakeAt("upwind-near"), 2);
  assert.equal(intakeAt("upwind"), undefined);
  assert.equal(find(props, "upwind")?.risk, "low", "inside the zone, but no smoke");
  assert.equal(find(props, "outside"), undefined);
});

test("day vs night people (8 am-6 pm Central)", () => {
  const night = DEMO_NOW + 12 * HOUR; // 2 am
  assert.equal(dcOf(ALL).people, 40);
  assert.equal(dcOf(assess(DEMO_INCIDENTS, { now: night })).people, 12);
  assert.equal(find(assess(DEMO_INCIDENTS, { now: night }), "res-prairie-creek")!.people, 410);
  const at = (h: number) => DEMO_NOW + (h - 14) * HOUR;
  assert.deepEqual([7, 8, 17, 18].map((h) => isDaytime(at(h))), [false, true, true, false]);
  // Low risk counts a quarter: the hospital is only on a blocked road.
  const hospital = find(ALL, "med-coit-creek")!;
  assert.equal(hospital.risk, "low");
  assert.equal(hospital.people, 165);
  assert.deepEqual(hospital.reasons, ["Coit Rd blocked by crash"]);
});

test("output: highest cost first, actions empty, deterministic", () => {
  for (let i = 1; i < ALL.length; i++) assert.ok(ALL[i - 1]!.cost.totalUsd >= ALL[i]!.cost.totalUsd);
  assert.equal(ALL[0]!.id, DC);
  assert.ok(ALL.every((p) => p.actions.length === 0 && p.reasons.length > 0));
  assert.ok(ALL.every((p) => new Set(p.chain.map((s) => s.id)).size === p.chain.length));
  assert.deepEqual(assess(DEMO_INCIDENTS), ALL);
  assert.deepEqual(assess([]), []);
});

test("missing impacts are computed with classify_blast_radius", () => {
  const props = assessPropertyImpact(DEMO_INCIDENTS, PORTFOLIO, { now: DEMO_NOW });
  assert.equal(dcOf(props).risk, "high");
  assert.ok(!props.some((p) => p.id === "lab-telecom-ridge"));
});

test("sameRoad tolerates Rd/Road and direction prefixes", () => {
  assert.ok(sameRoad("Coit Rd", "coit road"));
  assert.ok(sameRoad("N Coit Rd", "Coit Rd"));
  assert.ok(sameRoad("Coit", "Coit Rd"));
  assert.ok(sameRoad("Main Street", "Main St."));
  assert.ok(!sameRoad("Campbell Rd", "Campbell Ave"));
  assert.ok(!sameRoad("Coit Rd", "Lookout Dr"));
});

// ---- The tool ----

const newRun = (): ImpactRun => ({
  incidents: DEMO_INCIDENTS,
  portfolio: PORTFOLIO,
  opts: { horizonMinutes: 30, now: DEMO_NOW },
  impacts: { ...IMPACTS },
  actions: {},
});

test("tool: schema, stores run.properties, small summary with totals", () => {
  assert.equal(assessPropertyImpactTool.schema.function.name, "assess_property_impact");
  assert.deepEqual(assessPropertyImpactTool.schema.function.parameters?.required, []);
  const run = newRun();
  const out = assessPropertyImpactTool.run({}, run) as AssessSummary;
  assert.deepEqual(run.properties, ALL);
  assert.deepEqual(out.totals, { buildings: ALL.length, people: PEOPLE, usdAtRisk: total(ALL) });
  assert.deepEqual(out.properties[0], {
    id: DC,
    name: "Lookout Ridge Data Center",
    risk: "high",
    people: 40,
    totalUsd: ALL_DC.cost.totalUsd,
    firstFailure: "minute 0: Fuel route (Coit Rd) blocked by crash",
    accessCut: true,
  });
  assert.ok(JSON.stringify(out).length < 1500, `${JSON.stringify(out).length}`);
});

test("tool: incident_ids restricts the assessment; missing impacts are filled in", () => {
  const run = newRun();
  run.impacts = {};
  const out = assessPropertyImpactTool.run({ incident_ids: [DEMO_FIRE.id] }, run) as AssessSummary;
  assert.equal(out.properties[0]!.firstFailure, "minute 8: Smoke reaches HVAC intake");
  assert.ok(run.properties!.every((p) => p.incidentIds.join() === DEMO_FIRE.id));
  assert.deepEqual(Object.keys(run.impacts), [DEMO_FIRE.id]);
});

test("tool: bad incident_ids -> { error }, nothing stored", () => {
  const run = newRun();
  const bad = assessPropertyImpactTool.run({ incident_ids: "inc-fire-campbell" }, run) as { error: string };
  assert.match(bad.error, /incident_ids must be an array/);
  const unknown = assessPropertyImpactTool.run({ incident_ids: ["fire-9"] }, run) as { error: string };
  assert.match(unknown.error, /unknown incident id "fire-9": use inc-fire-campbell, inc-crash-coit, inc-flood-lookout/);
  assert.equal(run.properties, undefined);
});
