import assert from "node:assert/strict";
import { test } from "node:test";
import { mapFixture } from "../devFixture";
import { buildingImpact, buildingRisk, buildForecastScene, executeMitigation, interpolateRing, readExecutions, totalImpact } from "./forecastModel";

test("fixture starts at six buildings, 1,240 people and $380K; an execution reduces exposure exactly once", () => {
  const { mapScenario: scenario } = mapFixture();
  const building = scenario.buildings[0]!;
  const action = building.actions[0]!;
  assert.deepEqual(totalImpact(scenario, [], 0), { buildings: 6, people: 1240, loss: 380_000 });
  const once = executeMitigation(scenario, [], building.id, action.id, 10, 100);
  const twice = executeMitigation(scenario, once, building.id, action.id, 10, 200);
  assert.equal(twice.length, 1);
  assert.equal(totalImpact(scenario, twice, 10).loss, 323_000);
  assert.equal(buildingRisk(building, twice, 10), "moderate");
  const both = executeMitigation(scenario, twice, building.id, building.actions[1]!.id, 10, 300);
  assert.equal(buildingImpact(building, both).people, 0);
  assert.equal(totalImpact(scenario, both, 10).people, 1060);
  assert.equal(buildingRisk(building, both, 10), "low");
  assert.equal(executeMitigation(scenario, both, building.id, "unknown", 10), both);
});

test("restoring history validates action ownership and timestamps, rejects corruption, and deduplicates", () => {
  const { mapScenario: scenario } = mapFixture();
  const valid = { buildingId: "x-origin", actionId: "x-origin-isolate", time: 123, forecastMinute: 10 };
  const restored = readExecutions(scenario, JSON.stringify([null, valid, valid, { ...valid, actionId: "x-1-isolate" }, { ...valid, time: "yesterday" }]));
  assert.deepEqual(restored, [valid]);
  assert.deepEqual(readExecutions(scenario, "{broken"), []);
  assert.deepEqual(readExecutions(scenario, "{}"), []);
});

test("fire, smoke and flood interpolate together while the camera extent stays fixed", () => {
  const { mapScenario: scenario, state } = mapFixture();
  const incidents = state.mapIncidents!;
  const early = buildForecastScene(incidents, 5, scenario);
  const later = buildForecastScene(incidents, 20, scenario);
  for (const id of ["fixture-fire-fire", "fixture-fire-smoke", "commerce-flood"]) {
    assert.notDeepEqual(early.shapes.find((shape) => shape.id === id)!.path, later.shapes.find((shape) => shape.id === id)!.path);
  }
  assert.deepEqual(early.extent, later.extent);
  assert.equal(early.shapes.some((shape) => shape.id === "flooded-commerce"), false);
  assert.equal(later.shapes.some((shape) => shape.id === "flooded-commerce"), true);
  assert.equal(later.shapes.filter((shape) => shape.id.startsWith("link-")).length, 3);
  assert.equal(later.shapes.filter((shape) => shape.buildingId).length, 6);
  const resolved = incidents.map((incident) => ({ ...incident, phase: "resolved" as const }));
  assert.equal(buildForecastScene(resolved, 20, scenario).shapes.some((shape) => shape.id.startsWith("link-") || shape.id === "commerce-flood" || shape.id === "gas-perimeter"), false);
});

test("interpolation handles empty, zero, intermediate, and beyond-horizon forecasts", () => {
  const origin = { lat: 0, lon: 0 };
  const steps = [{ minute: 10, ring: [{ lat: 10, lon: 20 }] }, { minute: 20, ring: [{ lat: 20, lon: 40 }] }];
  assert.deepEqual(interpolateRing([], 10, origin), []);
  assert.deepEqual(interpolateRing(steps, 0, origin), [origin]);
  assert.deepEqual(interpolateRing(steps, 5, origin), [{ lat: 5, lon: 10 }]);
  assert.deepEqual(interpolateRing(steps, 15, origin), [{ lat: 15, lon: 30 }]);
  assert.deepEqual(interpolateRing(steps, 50, origin), steps[1]!.ring);
});
