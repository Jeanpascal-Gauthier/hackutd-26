import assert from "node:assert/strict";
import { test } from "node:test";
import portfolioJson from "../../../data/portfolio.json";
import { assessIncidentRules } from "../../../agent/core/impact/assess";
import { DEMO_INCIDENTS, DEMO_NOW } from "../../../agent/fixtures/demoIncidents";
import type { PortfolioBuilding, PortfolioImpact, MapIncidentPlus } from "../../../server/src/incidents/stepZero";
import { buildingImpact, buildForecastScene } from "./forecastModel";
import { liveMapLayers, portfolioScenario } from "./portfolioModel";

const portfolio = portfolioJson as PortfolioBuilding[];
const incidents: MapIncidentPlus[] = DEMO_INCIDENTS.map((incident) => ({
  ...incident, kind: incident.kind === "flood" ? "other" : incident.kind,
  label: incident.kind === "flood" ? "Flood" : incident.kind,
  status: "located", phase: "open", reports: [], time: 1, updated: 1, forecastStatus: "ready",
}));
function assessment(done: string[] = []): PortfolioImpact {
  const result = assessIncidentRules(DEMO_INCIDENTS, portfolio, { now: DEMO_NOW, doneActionIds: done });
  return { ...result, done, updated: 1 };
}

test("published portfolio data becomes the map's actual buildings, chains, actions and costs", () => {
  const published = assessment();
  const original = structuredClone(published);
  const scenario = portfolioScenario(published, incidents, portfolio)!;
  assert.equal(scenario.source, "server");
  assert.equal(scenario.buildings.length, 6);
  assert.equal(scenario.buildings.reduce((sum, building) => sum + building.people, 0), 1240);
  assert.equal(scenario.buildings.reduce((sum, building) => sum + buildingImpact(building, []).loss, 0), published.summary.usdAtRiskAfterActions);
  const dataCenter = scenario.buildings.find((building) => building.id === "dc-lookout")!;
  const property = published.affectedProperties.find((building) => building.id === dataCenter.id)!;
  assert.equal(dataCenter.chain.length, property.chain.length);
  assert.deepEqual(dataCenter.actions.map((action) => action.id), property.actions.map((action) => action.id));
  assert.ok(dataCenter.actions.every((action) => action.deadlineMinute !== undefined && action.reason));
  assert.deepEqual(published, original, "adapting data never mutates the published state");
});

test("server-confirmed actions use the common cost model and interrupt downstream steps", () => {
  const before = assessment();
  const property = before.affectedProperties.find((building) => building.id === "dc-lookout")!;
  const done = property.actions.filter((action) => action.id.endsWith("close-dampers") || action.id.endsWith("flood-barriers")).map((action) => action.id);
  assert.equal(done.length, 2);
  const after = assessment(done);
  const scenario = portfolioScenario(after, incidents, portfolio)!;
  assert.ok(after.summary.usdAtRiskAfterActions > 80_000 && after.summary.usdAtRiskAfterActions < 100_000);
  assert.equal(scenario.buildings.reduce((sum, building) => sum + buildingImpact(building, []).loss, 0), after.summary.usdAtRiskAfterActions);
  const dataCenter = scenario.buildings.find((building) => building.id === "dc-lookout")!;
  assert.equal(dataCenter.actions.filter((action) => action.status === "done").length, 2);
  assert.ok(dataCenter.chain.some((step) => step.interrupted));
  assert.equal(buildingImpact(dataCenter, [{ buildingId: dataCenter.id, actionId: done[0]!, time: 1, forecastMinute: 0 }]).loss, dataCenter.server!.remainingLoss, "local fixture history cannot lower server costs a second time");
});

test("missing building details do not produce invented savings or demo buildings", () => {
  assert.equal(portfolioScenario(undefined, incidents, portfolio), undefined);
  assert.equal(portfolioScenario({ ...assessment(), affectedProperties: [] }, incidents, portfolio), undefined);
  const scenario = portfolioScenario(assessment(), incidents, [])!;
  assert.ok(scenario.buildings.every((building) => building.server?.remainingLoss === null));
  assert.ok(scenario.buildings.every((building) => buildingImpact(building, []).loss === building.loss));
});

test("server floods, roads, incident links, and radii render without a fixture scenario", () => {
  const published = assessIncidentRules(DEMO_INCIDENTS, portfolio, { now: DEMO_NOW });
  const linked = incidents.map((incident) => ({ ...incident, related: incidents.filter((other) => other.id !== incident.id).map((other) => other.id), impact: published.impacts[incident.id] }));
  assert.deepEqual(liveMapLayers(linked), { flood: true, impact: true, links: true, forecast: true });
  const early = buildForecastScene(linked, 0);
  const later = buildForecastScene(linked, 30);
  assert.equal(later.shapes.filter((shape) => shape.id.startsWith("linked-")).length, 3, "symmetric links are drawn once");
  assert.ok(later.shapes.some((shape) => shape.id.endsWith("-flood")));
  assert.ok(later.shapes.some((shape) => shape.id.endsWith("-impact")));
  assert.ok(later.shapes.some((shape) => shape.title.includes("Flooded")));
  assert.ok(later.shapes.length > early.shapes.length, "roads appear at their forecast minute");
});
