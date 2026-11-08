// No network, and no agent: the flood model, zones and links, road names, and the tracker with a fake engine.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AffectedProperty, GeoPoint, MapIncident, PlannedAction } from "@firewatch/shared/types";
import { createApp } from "../app.ts";
import { createBuildingService } from "../buildings/service.ts";
import type { RoadWay } from "../incidents/crashModel.ts";
import { forecastFlood, floodRadius } from "../incidents/floodModel.ts";
import { geoDistance } from "../incidents/geo.ts";
import type { MapProviders } from "../incidents/providers.ts";
import { parseClientEvent } from "../state/actions.ts";
import { IncidentStore } from "../state/store.ts";
import { PORTFOLIO } from "../portfolio/portfolio.ts";
import { roadKey, type ImpactComputation, type ImpactEngine } from "./engine.ts";
import { ImpactTracker } from "./tracker.ts";
import { ZONE_METERS, linkIncidents, zoneOf } from "./zones.ts";

const HERE: GeoPoint = { lat: 32.9756, lon: -96.7704 };
const east = (metres: number): GeoPoint => ({ lat: HERE.lat, lon: HERE.lon + metres / (111_320 * Math.cos((HERE.lat * Math.PI) / 180)) });
const way = (name: string, geometry: GeoPoint[]): RoadWay => ({ id: 1, name, highway: "primary", oneway: "both", lanes: null, nodes: geometry.map((_, i) => i), geometry });

// ---- Flood model ----

test("flood: the water grows every step and every ring is centred on the source", () => {
  const { flood } = forecastFlood(HERE, [], "serious", "water main burst");
  assert.deepEqual(flood.steps.map((s) => s.minute), [5, 10, 15, 20, 30]);
  const reach = flood.steps.map((s) => Math.max(...s.water.map((p) => geoDistance(HERE, p))));
  for (let i = 1; i < reach.length; i++) assert.ok(reach[i]! > reach[i - 1]!);
  assert.ok(Math.abs(reach.at(-1)! - floodRadius("serious", 30)) < 5);
  assert.match(flood.summary!, /water main burst/);
  assert.ok(flood.assumptions!.length > 0);
});

test("flood: critical spreads faster than minor", () => {
  assert.ok(floodRadius("critical", 30) > floodRadius("serious", 30));
  assert.ok(floodRadius("serious", 30) > floodRadius("minor", 30));
});

test("flood: roads turn red in the order the water reaches them, and far roads stay open", () => {
  const roads = [
    way("Coit Road", [east(60), east(120)]),
    way("Plano Road", [east(200), east(260)]),
    way("Far Road", [east(2000), east(2100)]),
  ];
  const { roads: red } = forecastFlood(HERE, roads, "serious");
  assert.deepEqual(red.map((r) => r.road), ["Coit Road", "Plano Road"]);
  assert.ok(red.every((r) => r.reason === "flood" && r.path.length >= 2));
  assert.ok(red[0]!.fromMinute < red[1]!.fromMinute);
  assert.ok(red.every((r) => r.fromMinute <= 30));
});

// ---- Zones and links ----

const located = (id: string, kind: MapIncident["kind"], location: GeoPoint, over: Partial<MapIncident> = {}): MapIncident => ({
  id, kind, label: kind, severity: "serious", status: "located", location, reports: [], time: 0, updated: 0, phase: "open", forecastStatus: "none", ...over,
});

test("zones: nearby points share a cell, far points do not", () => {
  assert.equal(zoneOf(HERE), zoneOf({ lat: HERE.lat + 0.00001, lon: HERE.lon }));
  assert.notEqual(zoneOf(HERE), zoneOf(east(3000)));
});

test("links: different kinds within a zone are linked, never the same kind, never the far or resolved", () => {
  const list = [
    located("fire", "fire", HERE),
    located("crash", "crash", east(300)),
    located("fire2", "fire", east(100)),
    located("flood", "flood", east(5000)),
    located("old", "crash", east(50), { phase: "resolved" }),
    located("pin", "crash", east(60), { status: "locating", location: undefined }),
  ];
  const links = linkIncidents(list);
  assert.deepEqual(links.get("fire")!.related, ["crash"]);
  assert.deepEqual(links.get("crash")!.related.sort(), ["fire", "fire2"]);
  assert.deepEqual(links.get("flood")!.related, []);
  assert.equal(links.has("old"), false);
  assert.equal(links.has("pin"), false);
  assert.ok(ZONE_METERS >= 500);
});

// ---- Road names ----

test("roadKey: abbreviations and direction words do not change the road", () => {
  assert.equal(roadKey("W Campbell Rd"), roadKey("West Campbell Road"));
  assert.equal(roadKey("Coit Rd."), roadKey("Coit Road"));
  assert.equal(roadKey("N Central Expy"), roadKey("North Central Expressway"));
  assert.notEqual(roadKey("Coit Road"), roadKey("Plano Road"));
});

// ---- The portfolio ----

test("portfolio: every dependency, backup and tenant need names a system in the building", () => {
  assert.ok(PORTFOLIO.length >= 8);
  for (const b of PORTFOLIO) {
    const ids = new Set(b.systems.map((s) => s.id));
    assert.equal(ids.size, b.systems.length, `${b.id} has duplicate system ids`);
    for (const s of b.systems) for (const d of [...s.dependsOn, ...(s.backups ?? [])]) assert.ok(ids.has(d), `${b.id}:${s.id} -> ${d}`);
    for (const t of b.tenants) for (const d of t.dependsOn) assert.ok(ids.has(d), `${b.id} tenant ${t.name} -> ${d}`);
    assert.ok(b.access.roads.length > 0 && b.occupancy.day >= 0);
    assert.ok(geoDistance(HERE, b.location) < 1500, `${b.id} is not near the demo area`);
  }
  assert.equal(new Set(PORTFOLIO.map((b) => b.id)).size, PORTFOLIO.length);
});

// ---- The tracker, with a fake engine ----

const action = (id: string, savesUsd: number): PlannedAction => ({ id, text: `Do ${id}`, deadlineMinute: 5, prevents: [], savesUsd, reason: "because", status: "pending" });
const property = (incidentIds: string[]): AffectedProperty => ({
  id: "dc-coit", name: "Coit Road Data Center", use: "data_center", location: HERE, risk: "high", incidentIds, chain: [],
  people: 60, downtimeHours: 8, cost: { slaUsd: 300_000, lostRentUsd: 20_000, damageUsd: 60_000, totalUsd: 380_000 }, accessCut: false,
  actions: [action("dc-coit:close-dampers", 290_000)], reasons: [],
});

/** Prices the one property at $380K, less what the done actions save. */
function fakeEngine(over: Partial<ImpactEngine> = {}): ImpactEngine & { calls: { done: string[] }[] } {
  const calls: { done: string[] }[] = [];
  const compute = (incidents: MapIncident[], done: string[]): ImpactComputation => {
    const p = property(incidents.map((i) => i.id));
    p.actions = p.actions.map((a) => (done.includes(a.id) ? { ...a, status: "done" as const } : a));
    const total = 380_000 - p.actions.filter((a) => a.status === "done").reduce((sum, a) => sum + a.savesUsd, 0);
    return {
      impacts: Object.fromEntries(incidents.map((i) => [i.id, { center: i.location!, radiusMeters: 400, reasons: ["serious " + i.kind] }])),
      affectedProperties: [p],
      summary: { buildings: 1, people: 60, usdAtRisk: 380_000, usdAtRiskAfterActions: total, horizonMinutes: 30, headline: `1 building · $${total}` },
      trail: [], mode: "rules", briefing: "fake",
    };
  };
  return {
    calls,
    load: async () => {},
    rules: (incidents, _portfolio, opts) => (calls.push({ done: opts.doneActionIds }), compute(incidents, opts.doneActionIds)),
    ...over,
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

function tracked(engine = fakeEngine()) {
  const store = new IncidentStore();
  const tracker = new ImpactTracker(store, engine, PORTFOLIO, { llm: false });
  return { store, tracker, engine };
}

test("tracker: a located fire gets a blast radius, properties and a portfolio impact; an `other` pin gets none", async () => {
  const { store, tracker } = tracked();
  store.patch({ mapIncidents: [located("inc-1", "fire", HERE), located("inc-2", "other", east(900))] });
  tracker.refresh();
  await tick();
  const [fire, pin] = store.get().mapIncidents!;
  assert.equal(fire!.impact?.radiusMeters, 400);
  assert.deepEqual(fire!.affectedProperties?.map((p) => p.id), ["dc-coit"]);
  assert.equal(pin!.impact, undefined);
  assert.equal(store.get().portfolioImpact?.summary.usdAtRisk, 380_000);
  assert.equal(fire!.zoneId, zoneOf(HERE));
});

test("tracker: a fire and a crash close together are linked, not merged", async () => {
  const { store, tracker } = tracked();
  store.patch({ mapIncidents: [located("inc-1", "fire", HERE), located("inc-2", "crash", east(200))] });
  tracker.refresh();
  await tick();
  const [fire, crash] = store.get().mapIncidents!;
  assert.deepEqual(fire!.related, ["inc-2"]);
  assert.deepEqual(crash!.related, ["inc-1"]);
  assert.equal(fire!.zoneId, crash!.zoneId);
});

test("tracker: Execute marks the action done and the dollars at risk drop", async () => {
  const { store, tracker, engine } = tracked();
  store.patch({ mapIncidents: [located("inc-1", "fire", HERE)] });
  tracker.refresh();
  await tick();
  assert.equal(store.get().portfolioImpact!.summary.usdAtRiskAfterActions, 380_000);

  assert.deepEqual(tracker.execute("dc-coit", "dc-coit:close-dampers"), { ok: true });
  const after = store.get().portfolioImpact!;
  assert.equal(after.summary.usdAtRiskAfterActions, 90_000);
  assert.equal(after.properties[0]!.actions[0]!.status, "done");
  assert.equal(store.get().mapIncidents![0]!.affectedProperties![0]!.actions[0]!.status, "done");
  assert.deepEqual(engine.calls.at(-1)!.done, ["dc-coit:close-dampers"]);
  assert.match(store.get().log!.at(-1)!.text, /Executed at Coit Road Data Center: Do dc-coit:close-dampers/);
  assert.equal(store.get().log!.at(-1)!.incidentId, "inc-1");

  // Running it twice changes nothing, and the done action survives the next re-assessment.
  assert.deepEqual(tracker.execute("dc-coit", "dc-coit:close-dampers"), { ok: true });
  tracker.refresh();
  await tick();
  assert.equal(store.get().portfolioImpact!.summary.usdAtRiskAfterActions, 90_000);
});

test("tracker: Execute on an unknown building or action is refused", async () => {
  const { store, tracker } = tracked();
  assert.equal(tracker.execute("dc-coit", "x").ok, false);
  store.patch({ mapIncidents: [located("inc-1", "fire", HERE)] });
  tracker.refresh();
  await tick();
  assert.match(tracker.execute("nope", "x").error!, /unknown property/);
  assert.match(tracker.execute("dc-coit", "nope").error!, /unknown action/);
});

test("tracker: resolving the only incident clears the impact; clear() forgets executed actions", async () => {
  const { store, tracker } = tracked();
  store.patch({ mapIncidents: [located("inc-1", "fire", HERE)] });
  tracker.refresh();
  await tick();
  tracker.execute("dc-coit", "dc-coit:close-dampers");
  store.patch({ mapIncidents: store.get().mapIncidents!.map((i) => ({ ...i, phase: "resolved" as const })) });
  tracker.refresh();
  await tick();
  assert.equal(store.get().portfolioImpact, undefined);
  assert.equal(store.get().mapIncidents![0]!.impact, undefined);

  tracker.clear();
  store.patch({ mapIncidents: [located("inc-3", "crash", HERE)] });
  tracker.refresh();
  await tick();
  assert.equal(store.get().portfolioImpact!.summary.usdAtRiskAfterActions, 380_000);
});

test("tracker: an agent that can't load leaves the incidents alone and the server running", async () => {
  const { store, tracker } = tracked(fakeEngine({ load: async () => { throw new Error("no agent"); } }));
  const { error } = console;
  console.error = () => {};
  try {
    store.patch({ mapIncidents: [located("inc-1", "fire", HERE)] });
    tracker.refresh();
    await tick();
  } finally {
    console.error = error;
  }
  assert.equal(store.get().portfolioImpact, undefined);
  assert.equal(store.get().mapIncidents![0]!.impact, undefined);
  assert.equal(store.get().mapIncidents![0]!.id, "inc-1");
});

test("tracker: Nemotron's answer replaces the rules answer, and a stale one is dropped", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const engine = fakeEngine({
    llm: async (incidents, _portfolio, opts) => {
      await gate;
      const base = fakeEngine().rules(incidents, PORTFOLIO, opts);
      return { ...base, mode: "llm", briefing: "from nemotron", trail: [{ time: 1, tool: "classify_blast_radius", summary: "ok" } as never] };
    },
  });
  const store = new IncidentStore();
  const tracker = new ImpactTracker(store, engine, PORTFOLIO, { llm: true });
  store.patch({ mapIncidents: [located("inc-1", "fire", HERE)] });
  tracker.refresh();
  await tick();
  assert.equal(store.get().portfolioImpact!.mode, "rules");
  release();
  await tick();
  assert.equal(store.get().portfolioImpact!.mode, "llm");
  assert.equal(store.get().portfolioImpact!.briefing, "from nemotron");
  assert.equal(store.get().portfolioImpact!.trail!.length, 1);
});

// ---- The WebSocket event ----

test("executeAction: needs a building and an action", () => {
  assert.deepEqual(parseClientEvent({ type: "executeAction", propertyId: "dc-coit", actionId: "dc-coit:close-dampers" }), { type: "executeAction", propertyId: "dc-coit", actionId: "dc-coit:close-dampers" });
  assert.equal(typeof parseClientEvent({ type: "executeAction", propertyId: "dc-coit" }), "string");
  assert.equal(typeof parseClientEvent({ type: "executeAction", actionId: "x" }), "string");
});

// ---- A flood through the whole server ----

const ROADS: RoadWay[] = [way("Coit Road", [east(40), east(150)]), way("Plano Road", [east(5000), east(5100)])];
const PLACES: Record<string, GeoPoint> = { "campbell and coit": HERE, "coit road crash": east(250) };
const providers = (): MapProviders => ({
  geocode: async (query) => (PLACES[query.toLowerCase()] ? { location: PLACES[query.toLowerCase()]!, formatted: `${query}, Richardson, TX` } : null),
  roads: async () => ROADS,
  buildings: async () => [],
  wind: async () => ({ speedMps: 4, fromDegrees: 180 }),
});

test("a water main burst becomes a flood with water, red roads, a blast radius, and a linked crash", async () => {
  const app = createApp({ mapProviders: providers(), impactEngine: fakeEngine(), impactLlm: false, buildings: createBuildingService({ geoapifyApiKey: "x", fetch: (async () => { throw new Error("no network"); }) as typeof fetch }) });
  const { log, error } = console;
  console.log = console.error = () => {};
  try {
    const flood = await app.mapIncidents.report({ kind: "flood", what: "water main burst", address: "campbell and coit", description: "water main burst, street flooding", severity: "serious", lanesBlocked: "unknown", inBuilding: false, channel: "console" });
    assert.equal(flood.incident.kind, "flood");
    for (let i = 0; i < 100 && app.store.get().mapIncidents!.some((x) => x.forecastStatus !== "ready"); i++) await tick();
    let [f] = app.store.get().mapIncidents!;
    assert.equal(f!.forecastStatus, "ready");
    assert.equal(f!.flood!.steps.length, 5);
    assert.deepEqual(f!.affectedRoads!.map((r) => [r.road, r.reason]), [["Coit Road", "flood"]]);
    assert.match(f!.recommendation!.actions.join(" "), /Water spreads/);

    await app.mapIncidents.report({ kind: "crash", address: "coit road crash", description: "two cars, all lanes blocked", severity: "serious", lanesBlocked: "all", inBuilding: false, channel: "console" });
    for (let i = 0; i < 100 && app.store.get().mapIncidents!.some((x) => x.forecastStatus !== "ready"); i++) await tick();
    await tick();
    const [water, crash] = app.store.get().mapIncidents!;
    assert.deepEqual(water!.related, [crash!.id]);
    assert.deepEqual(crash!.related, [water!.id]);
    assert.equal(water!.zoneId, crash!.zoneId);
    assert.ok(water!.impact && crash!.impact);
    assert.equal(app.store.get().portfolioImpact?.properties[0]?.id, "dc-coit");

    assert.deepEqual(app.mapIncidents.executeAction("dc-coit", "dc-coit:close-dampers"), { ok: true });
    assert.equal(app.store.get().portfolioImpact!.summary.usdAtRiskAfterActions, 90_000);
    app.mapIncidents.clear();
    assert.equal(app.store.get().portfolioImpact, undefined);
  } finally {
    Object.assign(console, { log, error });
  }
});
