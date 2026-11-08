import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { IncidentState } from "@firewatch/shared/types";
import { createHttpServer } from "./http.ts";
import { createBuildingService } from "../buildings/service.ts";

const location = { lat: 32.0005, lon: -95.9995 };
const rectangle = (south: number, west: number, north: number, east: number) => [
  { lat: south, lon: west }, { lat: south, lon: east }, { lat: north, lon: east },
  { lat: north, lon: west }, { lat: south, lon: west },
];
const elements = [
  {
    type: "way", id: 100, tags: { building: "yes", name: "Test Building" },
    geometry: rectangle(32, -96, 32.001, -95.999),
  },
  {
    type: "way", id: 101,
    tags: { indoor: "room", name: "Coffee Room", ref: "105", level: "0", "level:ref": "G", room: "kitchen" },
    geometry: rectangle(32.0001, -95.9999, 32.0003, -95.9997),
  },
];

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function makeServer(buildings: ReturnType<typeof createBuildingService>) {
  const state: IncidentState = { simMinute: 0, rooms: [], reports: [], occupants: [] };
  const building = { rooms: [], links: [], verticals: [] };
  const server = createHttpServer({
    buildings,
    ingest: async () => { throw new Error("A lookup must not ingest an incident report"); },
    getState: () => state,
    buildingInfo: { building, occupants: [], sprinklers: {}, doors: [], inspections: [] },
    forecast: () => { throw new Error("A lookup must not activate a forecast"); },
    resetLive: () => { throw new Error("A lookup must not reset the incident"); },
  });
  return { server, state, building };
}

test("HTTP building lookup selects a source building, preserves labels, and leaves the active incident intact", async () => {
  let calls = 0;
  const key = "server-only-test-key";
  const upstream: typeof fetch = async (input) => {
    calls++;
    const url = new URL(String(input));
    if (url.hostname === "api.geoapify.com") {
      assert.equal(url.searchParams.get("apiKey"), key);
      return Response.json({ results: [{
        formatted: "Test Building", ...location, result_type: "building", place_id: "test-place",
        rank: { confidence: 1, match_type: "full_match" },
      }] });
    }
    return Response.json({ elements });
  };
  const { server, state, building } = makeServer(createBuildingService({ fetch: upstream, geoapifyApiKey: key }));
  const base = await listen(server);
  try {
    const search = await fetch(`${base}/buildings/search?q=Test%20Building`);
    assert.equal(search.status, 200);
    const searchText = await search.text();
    assert.equal(searchText.includes(key), false);
    assert.equal(JSON.parse(searchText).candidates.length, 1);

    const request = (body: unknown) => fetch(`${base}/buildings/resolve`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const selection = await request(location);
    assert.equal(selection.status, 409);
    const choices = await selection.json();
    assert.equal(choices.code, "building_selection_required");
    assert.equal(choices.candidates[0].id, "osm:way:100");

    const selected = await request({ ...location, buildingId: choices.candidates[0].id });
    assert.equal(selected.status, 200);
    const result = await selected.json();
    assert.equal(result.building.id, "osm:way:100");
    assert.equal(result.building.completeness.routeReady, false);
    const callsAfterImport = calls;

    const record = await fetch(`${base}/buildings/${encodeURIComponent(result.building.id)}`);
    assert.equal(record.status, 200);
    assert.equal((await record.json()).building.name, "Test Building");

    const catalog = await fetch(`${base}/buildings/${encodeURIComponent(result.building.id)}/rooms`);
    assert.equal(catalog.status, 200);
    const rooms = await catalog.json();
    assert.equal(rooms.rooms[0].name, "Coffee Room");
    assert.equal(rooms.rooms[0].number, "105");
    assert.equal(rooms.floors[0].label, "G");
    assert.equal(rooms.floors[0].sourceLevel, "0");
    assert.equal(rooms.routeAnalysisAvailable, false);
    assert.equal(calls, callsAfterImport, "Cached reads must not repeat upstream lookups");

    assert.deepEqual(await (await fetch(`${base}/state`)).json(), state);
    assert.deepEqual((await (await fetch(`${base}/building`)).json()).building, building);
    assert.deepEqual(await (await fetch(`${base}/health`)).json(), { ok: true, mock: false });
    assert.equal(record.headers.get("access-control-allow-origin"), "*");
  } finally {
    await close(server);
  }
});

test("HTTP configuration and input failures are controlled without contacting providers", async () => {
  const upstream: typeof fetch = async () => { throw new Error("Unexpected upstream request"); };
  const { server } = makeServer(createBuildingService({ fetch: upstream, geoapifyApiKey: "" }));
  const base = await listen(server);
  try {
    const missingKey = await fetch(`${base}/buildings/search?q=Test%20Building`);
    assert.equal(missingKey.status, 503);
    assert.equal((await missingKey.json()).code, "geoapify_not_configured");

    const malformed = await fetch(`${base}/buildings/resolve`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{",
    });
    assert.equal(malformed.status, 400);

    const oversized = await fetch(`${base}/buildings/resolve`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ padding: "x".repeat(4096) }),
    });
    assert.equal(oversized.status, 413);

    const badPath = await fetch(`${base}/buildings/%E0%A4%A`);
    assert.equal(badPath.status, 400);

    const invalid = await fetch(`${base}/buildings/resolve`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lat: 999, lon: 0 }),
    });
    assert.equal(invalid.status, 400);

    const unknown = await fetch(`${base}/buildings/osm%3Away%3A999`);
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).code, "building_not_cached");

    const options = await fetch(`${base}/buildings/resolve`, { method: "OPTIONS" });
    assert.equal(options.status, 204);
  } finally {
    await close(server);
  }
});
