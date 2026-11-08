import { test } from "node:test";
import assert from "node:assert/strict";
import { BuildingApiError, createBuildingService } from "./service.ts";

const location = { lat: 32.0005, lon: -95.9995 };
const rectangle = (s: number, w: number, n: number, e: number) => [
  { lat: s, lon: w }, { lat: s, lon: e }, { lat: n, lon: e }, { lat: n, lon: w }, { lat: s, lon: w },
];
const building = { type: "way", id: 100, tags: { building: "yes", name: "Public Building" }, geometry: rectangle(32, -96, 32.001, -95.999) };
const room = { type: "way", id: 101, tags: { indoor: "room", name: "Coffee Room", ref: "305", level: "0", "level:ref": "G" }, geometry: rectangle(32.0001, -95.9999, 32.0003, -95.9997) };

test("even one candidate requires confirmation; selected details preserve labels for the catalog", async () => {
  let requests = 0;
  const service = createBuildingService({ fetch: async () => {
    requests++;
    return Response.json({ elements: [building, room] });
  } });
  await assert.rejects(service.resolve(location), (e: unknown) => {
    assert.ok(e instanceof BuildingApiError);
    assert.equal(e.status, 409);
    assert.equal(e.code, "building_selection_required");
    assert.equal((e.details.candidates as { id: string }[])[0].id, "osm:way:100");
    return true;
  });
  const resolved = await service.resolve({ ...location, buildingId: "osm:way:100" });
  assert.equal(requests, 2, "Candidate lookup is reused for selection");
  assert.equal(resolved.building.name, "Public Building");
  const catalog = service.rooms("osm:way:100");
  assert.equal(catalog.rooms[0].name, "Coffee Room");
  assert.equal(catalog.rooms[0].number, "305");
  assert.equal(catalog.floors[0].label, "G");
  assert.equal(catalog.floors[0].sourceLevel, "0");
  assert.equal(catalog.routeAnalysisAvailable, false);
  assert.equal(catalog.source.provider, "openstreetmap");
  assert.equal(requests, 2);
});

test("a building ID cannot select a building absent from this location's candidates", async () => {
  const service = createBuildingService({ fetch: async () => Response.json({ elements: [building] }) });
  await assert.rejects(service.resolve({ ...location, buildingId: "osm:way:999" }),
    (e: unknown) => e instanceof BuildingApiError && e.status === 409 && e.code === "building_not_at_location");
});

test("no footprints yields a cached location-only record and unknown interiors", async () => {
  const service = createBuildingService({ fetch: async () => Response.json({ elements: [] }) });
  const result = await service.resolve(location);
  assert.equal(result.building.footprint, null);
  assert.equal(result.building.heightMeters, null);
  assert.deepEqual(result.building.rooms, []);
  assert.equal(result.building.completeness.routeReady, false);
  assert.equal(service.rooms(result.building.id).routeAnalysisAvailable, false);
  assert.equal(service.get(result.building.id).building.id, result.building.id);
});

test("stale cache records are explicitly labelled and the cache has a bounded size", async () => {
  let clock = 1000;
  const service = createBuildingService({
    now: () => clock, cacheTtlMs: 10, lookupTtlMs: 10, maxCachedBuildings: 1,
    fetch: async () => Response.json({ elements: [] }),
  });
  const first = await service.resolve(location);
  assert.equal(first.cache.stale, false);
  assert.equal(first.cache.fetchedAt, new Date(1000).toISOString());
  clock = 1011;
  assert.equal(service.get(first.building.id).cache.stale, true);
  await service.resolve({ lat: 33, lon: -96 });
  assert.throws(() => service.get(first.building.id), (e: unknown) => e instanceof BuildingApiError && e.status === 404);
});

test("indoor lookup failure preserves the footprint with an explicit warning", async () => {
  let calls = 0;
  const service = createBuildingService({ fetch: async () => {
    calls++;
    return calls === 1 ? Response.json({ elements: [building] }) : new Response("upstream details must not escape", { status: 503 });
  } });
  const result = await service.resolve({ ...location, buildingId: "osm:way:100" });
  assert.ok(result.building.footprint);
  assert.ok(result.building.warnings.some((warning) => warning.includes("provider_unavailable")));
  assert.equal(JSON.stringify(result).includes("upstream details must not escape"), false);
  assert.equal(result.building.completeness.interiors, "none");
});

test("identical simultaneous resolutions share requests and search results are cached", async () => {
  let requests = 0;
  const service = createBuildingService({ geoapifyApiKey: "test-key", fetch: async (input) => {
    requests++;
    if (String(input).includes("api.geoapify.com")) return Response.json({ results: [] });
    return Response.json({ elements: [] });
  } });
  const [one, two] = await Promise.all([service.resolve(location), service.resolve(location)]);
  assert.equal(one.building.id, two.building.id);
  assert.equal(requests, 1);
  await service.search("Public Building");
  await service.search("public building");
  assert.equal(requests, 2);
});
