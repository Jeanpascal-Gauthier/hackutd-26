import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultMapProviders, intersectionQuery, pickMatch } from "./providers.ts";
import { forecastCrash } from "./crashModel.ts";

const P = { lat: 32.98, lon: -96.75 };
const candidate = (address: string, resultType: string) => ({ address, resultType, location: P });

test("pickMatch: never pins a guess from another city when the geocoder could only find the city", () => {
  const city = candidate("Richardson, TX, United States", "city");
  assert.equal(pickMatch([city, candidate("Buchanan Road & Campbell Drive, Pittsburg, CA, United States", "amenity")]), null);
  assert.equal(pickMatch([city, candidate("Coit @ Campbell, North Coit Road, Richardson, TX 75248, United States", "amenity")])?.formatted, "Coit @ Campbell, North Coit Road, Richardson, TX 75248, United States");
  assert.equal(pickMatch([candidate("800 W Campbell Rd, Richardson, TX", "building")])?.formatted, "800 W Campbell Rd, Richardson, TX");
  assert.equal(pickMatch([]), null);
});

test("intersectionQuery: only rewrites what reads as an intersection", () => {
  assert.equal(intersectionQuery("Campbell Road and Coit Road, Richardson"), "Campbell Road & Coit Road, Richardson");
  assert.equal(intersectionQuery("12 Sand and Gravel Way"), "12 Sand and Gravel Way");
});

const route = (points: number[][], name: string) => ({
  features: [{ geometry: { type: "MultiLineString", coordinates: [points] }, properties: { legs: [{ steps: [{ from_index: 0, to_index: points.length - 1, name, road_class: "primary", lane_count: 2 }] }] } }],
});
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const service = { search: async () => ({ ok: true as const, candidates: [], cache: { stale: false, fetchedAt: "", expiresAt: "" } }) };

test("roads: when Overpass is down, routes in to the crash become a joined street graph", async () => {
  const end = [P.lon, P.lat];
  const north = [[P.lon, P.lat + 0.01], [P.lon, P.lat + 0.005], end];
  const fetch = (async (input: URL | RequestInfo) => {
    const url = String(input);
    if (!url.includes("geoapify")) throw new Error("overpass down");
    return json(route(north, "Coit Rd"));
  }) as typeof globalThis.fetch;
  const providers = defaultMapProviders(service as never, { geoapifyApiKey: "k", fetch, routeBatchDelayMs: 0 });
  const ways = await providers.roads(P);
  assert.equal(ways.length, 2, "18 identical routes add each road piece once");
  assert.ok(ways.every((w) => w.oneway === "forward" && w.name === "Coit Rd" && w.lanes === 2));
  assert.equal(ways[0]!.nodes[1], ways[1]!.nodes[0], "pieces share a node");
  assert.ok(forecastCrash(P, ways, "all").segments.length > 0);
});

test("buildings: when Overpass is down, nearby places come back as points", async () => {
  const fetch = (async (input: URL | RequestInfo) => {
    if (!String(input).includes("geoapify")) throw new Error("overpass down");
    return json({ features: [{ properties: { name: "Hall", lat: P.lat, lon: P.lon, place_id: "abc" } }, { properties: {} }] });
  }) as typeof globalThis.fetch;
  const [only, ...rest] = await defaultMapProviders(service as never, { geoapifyApiKey: "k", fetch }).buildings(P);
  assert.deepEqual(only, { id: "abc", name: "Hall", outline: [], location: P });
  assert.deepEqual(rest, []);
});

test("roads: no Overpass and no Geoapify key is an error, so the forecast reports failed", async () => {
  const fetch = (async () => { throw new Error("down"); }) as typeof globalThis.fetch;
  await assert.rejects(defaultMapProviders(service as never, { geoapifyApiKey: " ", fetch }).roads(P));
});
