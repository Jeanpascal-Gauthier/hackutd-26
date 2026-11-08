import assert from "node:assert/strict";
import { test } from "node:test";
import type { IncidentState, MapIncident } from "@firewatch/shared/types";
import { buildForecastScene, buildingImpact, buildingRisk } from "./forecastModel";
import { liveScenario, serverExecutions, type LiveIncident, type ServerProperty, type ServerPortfolioImpact } from "./liveScenario";

const here = { lat: 32.9756, lon: -96.7704 };
const incident = (changes: Partial<LiveIncident> = {}): LiveIncident => ({
  id: "inc-1", kind: "fire", label: "Fire", severity: "critical", status: "located", location: here, reports: [], time: 1, updated: 1, phase: "open", forecastStatus: "ready", ...changes,
});
const property = (changes: Partial<ServerProperty> = {}): ServerProperty => ({
  id: "dc-1", name: "Lookout Ridge Data Center", use: "data_center", location: { lat: 32.976, lon: -96.771 }, risk: "high", incidentIds: ["inc-1"],
  chain: [
    { id: "dc-1:intake", minute: 8, systemId: "intake", label: "Smoke reaches air intake", hazard: "smoke", causedBy: null, incidentId: "inc-1" },
    { id: "dc-1:cooling", minute: 14, systemId: "cooling", label: "Cooling fails", hazard: "heat", causedBy: "dc-1:intake", incidentId: "inc-1" },
  ],
  people: 60, downtimeHours: 8, cost: { totalUsd: 200_000 }, accessCut: false, reasons: [],
  actions: [
    { id: "dc-1:close-dampers", text: "Close outside-air dampers", deadlineMinute: 7, prevents: ["dc-1:intake"], savesUsd: 150_000, reason: "Keeps smoke out", status: "pending" },
    { id: "dc-1:notify", text: "Notify tenants", deadlineMinute: 0, prevents: [], savesUsd: 0, reason: "SLA", status: "pending" },
  ],
  ...changes,
});
const impact = (properties: ServerProperty[], changes: Partial<ServerPortfolioImpact> = {}): ServerPortfolioImpact => ({
  summary: { buildings: properties.length, people: 60, usdAtRisk: 200_000, usdAtRiskAfterActions: 200_000, horizonMinutes: 30, headline: "1 building" },
  affectedProperties: properties, briefing: "One data center is hit.", mode: "rules", done: [], updated: 5, ...changes,
});
const state = (mapIncidents: MapIncident[], portfolioImpact?: ServerPortfolioImpact): IncidentState =>
  ({ simMinute: 0, rooms: [], reports: [], occupants: [], mapIncidents, ...(portfolioImpact && { portfolioImpact }) }) as IncidentState;

test("a server with no portfolio data and no extra layers gives no live scenario", () => {
  assert.equal(liveScenario(null), null);
  assert.equal(liveScenario(state([incident()])), null);
  assert.equal(liveScenario(state([incident({ affectedRoads: [{ path: [here, here], road: "Coit Road", reason: "crash", fromMinute: 0 }] })])), null);
});

test("portfolio buildings become scenario buildings with a failure chain and priced actions", () => {
  const live = liveScenario(state([incident()], impact([property()])))!;
  const [building] = live.scenario.buildings;
  assert.equal(building!.name, "Lookout Ridge Data Center");
  assert.equal(building!.loss, 200_000);
  assert.equal(building!.people, 60);
  assert.equal(building!.firstImpactMinute, 8);
  assert.equal(building!.outline.length, 4);
  assert.deepEqual(building!.chain.map((step) => [step.minute, step.title]), [[8, "Smoke reaches air intake"], [14, "Cooling fails"]]);
  assert.equal(building!.chain[1]!.detail, "Follows from: smoke reaches air intake.");
  assert.match(building!.chain[0]!.detail, /^Smoke from Fire/);
  assert.equal(building!.chain[0]!.preventedBy, "dc-1:close-dampers");
  assert.equal(building!.chain[1]!.preventedBy, undefined);
  assert.deepEqual(building!.actions.map((action) => [action.id, action.label, action.lossReduction, action.done]), [["dc-1:close-dampers", "Close outside-air dampers", 150_000, false], ["dc-1:notify", "Notify tenants", 0, false]]);
  assert.equal(building!.actions[0]!.owner, "Before +7 min");
  assert.equal(building!.actions[1]!.owner, "Do now");
  assert.equal(live.summary!.usdAtRisk, 200_000);
  assert.equal(live.mode, "rules");
});

test("actions the server marked done count as executions, lowering loss and risk", () => {
  const done = property({ actions: property().actions.map((action) => (action.id === "dc-1:close-dampers" ? { ...action, status: "done" as const } : action)) });
  const { scenario } = liveScenario(state([incident()], impact([done])))!;
  const executions = serverExecutions(scenario);
  assert.deepEqual(executions.map((event) => event.actionId), ["dc-1:close-dampers"]);
  assert.equal(buildingImpact(scenario.buildings[0]!, executions).loss, 50_000);
  assert.equal(buildingRisk(scenario.buildings[0]!, executions, 20), "low");
  assert.equal(buildingRisk(scenario.buildings[0]!, [], 20), "high");
});

test("the server's risk caps what the loss alone would say", () => {
  const { scenario } = liveScenario(state([incident()], impact([property({ risk: "moderate" }), property({ id: "r2", risk: "low" })])))!;
  assert.equal(buildingRisk(scenario.buildings[0]!, [], 25), "moderate");
  assert.equal(buildingRisk(scenario.buildings[1]!, [], 25), "low");
});

test("a flood, its red roads, blast radius and links reach the scene; crash roads are not drawn twice", () => {
  const flood = incident({
    id: "inc-2", kind: "other", label: "Flood", location: here,
    flood: { steps: [{ minute: 5, water: [here, here, here] }, { minute: 30, water: [here, here, here] }] },
    impact: { center: here, radiusMeters: 350.4, reasons: ["serious flood"] },
    related: ["inc-3"],
    affectedRoads: [
      { path: [here, { lat: 32.9757, lon: -96.7704 }], road: "Coit Road", reason: "flood", fromMinute: 8 },
      { path: [here, { lat: 32.9758, lon: -96.7704 }], road: "Coit Road", reason: "crash", fromMinute: 0 },
    ],
  });
  const crash = incident({ id: "inc-3", kind: "crash", label: "Car crash", related: ["inc-2"] });
  const { scenario } = liveScenario(state([flood, crash], impact([property({ incidentIds: ["inc-2", "inc-3"] })])))!;
  assert.equal(scenario.floods.length, 1);
  assert.deepEqual(scenario.roads.map((road) => [road.road, road.reason, road.minute]), [["Coit Road", "Flooded · impassable", 8]]);
  assert.deepEqual(scenario.blasts.map((blast) => [blast.incidentId, blast.radiusMeters, blast.reasons]), [["inc-2", 350, ["serious flood"]]]);
  assert.equal(scenario.links.length, 1, "a link both incidents name is drawn once");
  const scene = buildForecastScene([flood, crash], 10, scenario);
  const ids = scene.shapes.map((shape) => shape.id);
  assert.ok(ids.includes("inc-2-flood") && ids.includes("inc-2-road-0") && ids.includes("inc-2-blast") && ids.includes("dc-1"));
  assert.ok(ids.some((id) => id.startsWith("link-")));
  assert.equal(scene.shapes.find((shape) => shape.id === "inc-2-blast")!.title, "350 m blast radius · serious flood");
});

test("resolved and unplaced incidents add nothing, and the scenario id follows the set of incidents", () => {
  const a = liveScenario(state([incident()], impact([property()])))!.scenario.id;
  const b = liveScenario(state([incident(), incident({ id: "inc-9" })], impact([property()])))!.scenario.id;
  assert.notEqual(a, b);
  const dropped = liveScenario(state([incident({ phase: "resolved", impact: { center: here, radiusMeters: 100, reasons: [] } }), incident({ id: "x", status: "locating", location: undefined, impact: { center: here, radiusMeters: 100, reasons: [] } })]));
  assert.equal(dropped, null);
});
