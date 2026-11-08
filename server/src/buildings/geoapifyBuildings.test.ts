import { test } from "node:test";
import assert from "node:assert/strict";
import { getGeoapifyBuildings } from "./geoapifyBuildings.ts";
import { createBuildingService } from "./service.ts";
import { BuildingApiError } from "./provider.ts";
import { createApp } from "../app.ts";

const location = { lat: 47.250759, lon: -122.4391592 };
const fetchedAt = "2026-11-08T12:00:00.000Z";
const outer = [[-122.44, 47.25], [-122.438, 47.25], [-122.438, 47.252], [-122.44, 47.252], [-122.44, 47.25]];
const hole = [[-122.4395, 47.251], [-122.439, 47.251], [-122.439, 47.2515], [-122.4395, 47.2515], [-122.4395, 47.251]];
const feature = (geometry: unknown = { type: "Polygon", coordinates: [outer] }, osmType = "w") => ({
  type: "Feature", geometry,
  properties: {
    feature_type: "building", formatted: "1313 Broadway, Tacoma, WA 98402", building: { levels: 6 },
    datasource: { sourcename: "openstreetmap", raw: { osm_id: 32506351, osm_type: osmType, building: "yes", "building:levels": 6, height: "21 m" } },
  },
});
const collection = (...features: unknown[]) => ({ type: "FeatureCollection", features });

test("managed lookup requests only the building and preserves its OSM identity, geometry, metadata and attribution", async () => {
  const key = "server-only-test-key";
  const records = await getGeoapifyBuildings(location, key, fetchedAt, { fetch: async (input) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.geoapify.com");
    assert.equal(url.pathname, "/v2/place-details");
    assert.equal(url.searchParams.get("lat"), String(location.lat));
    assert.equal(url.searchParams.get("lon"), String(location.lon));
    assert.equal(url.searchParams.get("features"), "building");
    assert.equal(url.searchParams.get("apiKey"), key);
    return Response.json(collection(feature()));
  } });
  const record = records[0];
  assert.equal(record.id, "osm:way:32506351");
  assert.equal(record.floorsAboveGround, 6);
  assert.equal(record.heightMeters, 21);
  assert.equal(record.address, "1313 Broadway, Tacoma, WA 98402");
  assert.deepEqual(record.footprint, { type: "Polygon", coordinates: [outer] });
  assert.match(record.source.attribution, /Geoapify.*OpenStreetMap/);
  assert.equal(record.source.fetchedAt, fetchedAt);
  assert.deepEqual(record.rooms, []);
  assert.equal(record.completeness.routeReady, false);
  assert.equal(record.completeness.footprint, true);
  assert.ok(record.warnings.some(line => line.includes("interior coverage is unknown")));
  assert.equal(JSON.stringify(records).includes(key), false);
});

test("managed relation outlines preserve courtyard holes and every MultiPolygon component", async () => {
  const geometry = { type: "MultiPolygon", coordinates: [[outer, hole], [outer]] };
  const records = await getGeoapifyBuildings(location, "key", fetchedAt, {
    fetch: async () => Response.json(collection(feature(geometry, "r"))),
  });
  assert.equal(records[0].id, "osm:relation:32506351");
  assert.deepEqual(records[0].footprint, geometry);
});

test("managed malformed geometry and missing OSM identity cannot become a fabricated building", async () => {
  for (const f of [
    feature({ type: "Polygon", coordinates: [outer.slice(0, -1)] }),
    feature({ type: "Polygon", coordinates: [[[999, 47.25], ...outer.slice(1)]] }),
    feature({ type: "Polygon", coordinates: [outer, hole.slice(0, -1)] }),
    feature({ type: "Polygon", coordinates: [Array(4).fill(outer[0])] }),
    feature(undefined, "unknown"),
    { ...feature(), properties: { feature_type: "building" } },
  ]) {
    await assert.rejects(getGeoapifyBuildings(location, "key", fetchedAt, {
      fetch: async () => Response.json(collection(f)),
    }), (error: unknown) => error instanceof BuildingApiError && error.code === "provider_invalid_response");
  }
});

test("managed lookup validates configuration and preserves sanitized upstream failures", async () => {
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => { calls++; throw new Error("url?apiKey=secret"); };
  await assert.rejects(getGeoapifyBuildings(location, "", fetchedAt, { fetch }),
    (e: unknown) => e instanceof BuildingApiError && e.code === "geoapify_not_configured");
  await assert.rejects(getGeoapifyBuildings({ lat: NaN, lon: 0 }, "key", fetchedAt, { fetch }),
    (e: unknown) => e instanceof BuildingApiError && e.code === "invalid_location");
  assert.equal(calls, 0);
  await assert.rejects(getGeoapifyBuildings(location, "key", fetchedAt, { fetch }), (e: unknown) => {
    assert.ok(e instanceof BuildingApiError);
    assert.equal(e.code, "provider_unavailable");
    assert.equal(String(e).includes("secret"), false);
    return true;
  });
});

test("a configured Geoapify key resolves and confirms a building without any Overpass request", async () => {
  let calls = 0;
  const service = createBuildingService({ geoapifyApiKey: "key", fetch: async (input) => {
    calls++;
    assert.equal(new URL(String(input)).hostname, "api.geoapify.com", "Overpass must not delay confirmation");
    return Response.json(collection(feature()));
  } });
  assert.equal(service.providers().providers.buildingLookup.provider, "geoapify");
  await assert.rejects(service.resolve(location), (e: unknown) => {
    assert.ok(e instanceof BuildingApiError);
    assert.equal(e.code, "building_selection_required");
    assert.equal((e.details.candidates as { id: string }[])[0].id, "osm:way:32506351");
    return true;
  });
  await assert.rejects(service.resolve({ ...location, buildingId: "osm:way:999" }),
    (e: unknown) => e instanceof BuildingApiError && e.code === "building_not_at_location");
  const result = await service.resolve({ ...location, buildingId: "osm:way:32506351" });
  assert.equal(result.building.floorsAboveGround, 6);
  assert.equal(service.get(result.building.id).building.id, result.building.id);
  assert.deepEqual(service.rooms(result.building.id).rooms, []);
  assert.equal(calls, 1, "Confirmation reuses the retrieved record");
});

test("managed empty results are explicit; provider failures never masquerade as no mapped building", async () => {
  const empty = createBuildingService({ geoapifyApiKey: "key", fetch: async () => Response.json(collection()) });
  assert.equal((await empty.resolve(location)).building.source.provider, "location");
  await assert.rejects(empty.resolve({ ...location, buildingId: "osm:way:32506351" }),
    (e: unknown) => e instanceof BuildingApiError && e.code === "building_not_at_location");
  for (const response of [new Response("unavailable", { status: 503 }), Response.json({ error: "not a feature collection" })]) {
    const service = createBuildingService({ geoapifyApiKey: "key", fetch: async () => response });
    await assert.rejects(service.resolve(location), (e: unknown) => e instanceof BuildingApiError && e.status === 502);
  }
});

test("managed lookup activates the real synthesized building after confirmation and processes reports on its rooms", async () => {
  let requests = 0;
  const buildings = createBuildingService({ geoapifyApiKey: "key", fetch: async (input) => {
    requests++;
    const url = new URL(String(input));
    assert.equal(url.hostname, "api.geoapify.com");
    if (url.pathname === "/v1/geocode/search") return Response.json({ results: [{ ...location, formatted: "1313 Broadway, Tacoma, WA" }] });
    assert.equal(url.pathname, "/v2/place-details");
    return Response.json(collection(feature()));
  } });
  const app = createApp({ buildings, mock: false });
  assert.ok(app.lookups.lookupAddress("1313 Broadway, Tacoma, WA").ok);
  await app.lookups.idle();
  assert.equal(app.store.get().buildingLookup?.status, "needs_confirmation");
  assert.equal(app.store.get().building?.id, "demo");
  assert.ok(app.lookups.confirmBuilding("osm:way:32506351").ok);
  await app.lookups.idle();
  const building = app.active.get().building;
  assert.equal(app.store.get().buildingLookup?.status, "active");
  assert.equal(building.profile.id, "osm:way:32506351");
  assert.equal(building.profile.floors, 6);
  assert.equal(building.profile.layoutEstimated, true);
  assert.ok(building.profile.outline?.length);
  await app.ingest({ text: "fire in the hallway on floor 2", caller: "test" });
  assert.equal(app.store.get().origin?.roomId, "2-hall");
  assert.equal(requests, 2, "Geocoding and building lookup only; confirmation must use the cache");
});
