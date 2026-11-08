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

const outline = [{ lat: P.lat, lon: P.lon }, { lat: P.lat, lon: P.lon + 0.0001 }, { lat: P.lat + 0.0001, lon: P.lon + 0.0001 }, { lat: P.lat, lon: P.lon }];
const house = { type: "way", id: 1, tags: { building: "yes", name: "House" }, geometry: outline };

/** Answers the two Overpass lookups separately; a thrown error stands in for that lookup failing. */
function overpassFetch(nearby: () => unknown, sites: () => unknown, geoapify?: (url: string) => unknown) {
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("geoapify")) {
      if (!geoapify) throw new Error("no geoapify");
      return json(geoapify(url));
    }
    const query = new URLSearchParams(String(init?.body)).get("data") ?? "";
    return json(query.includes("amenity") ? sites() : nearby());
  }) as typeof globalThis.fetch;
}

test("buildings: the wider lookup adds sensitive sites by centre point, with plain labels", async () => {
  const sites = { elements: [
    { type: "way", id: 2, center: { lat: 32.99, lon: -96.75 }, tags: { amenity: "hospital", name: "General" } },
    { type: "node", id: 3, lat: 32.97, lon: -96.75, tags: { amenity: "social_facility", social_facility: "nursing_home" } },
    { type: "node", id: 4, lat: 32.97, lon: -96.76, tags: { amenity: "cafe" } },
  ] };
  const found = await defaultMapProviders(service as never, { fetch: overpassFetch(() => ({ elements: [house] }), () => sites) }).buildings(P);
  assert.equal(found.sensitiveSitesUnavailable, undefined);
  assert.deepEqual(found.map((b) => [b.id, b.use]), [["osm:way:1", undefined], ["osm:way:2", "hospital"], ["osm:node:3", "nursing home"]]);
  assert.deepEqual(found[1]!.location, { lat: 32.99, lon: -96.75 });
  assert.deepEqual(found[1]!.outline, []);
});

test("buildings: a site that is also a nearby building marks it, and a site mapped twice appears once", async () => {
  const sites = { elements: [
    { type: "way", id: 1, center: P, tags: { amenity: "school", name: "House" } },
    { type: "way", id: 5, center: { lat: 32.99, lon: -96.75 }, tags: { amenity: "hospital", name: "General" } },
    { type: "node", id: 6, lat: 32.9901, lon: -96.75, tags: { amenity: "hospital", name: "General" } },
  ] };
  const found = await defaultMapProviders(service as never, { fetch: overpassFetch(() => ({ elements: [house] }), () => sites) }).buildings(P);
  assert.deepEqual(found.map((b) => b.id), ["osm:way:1", "osm:way:5"]);
  assert.equal(found[0]!.use, "school");
  assert.equal(found[0]!.outline.length, 3, "keeps the footprint");
});

test("buildings: a building's own tags give its use even without the wider lookup", async () => {
  const tagged = { ...house, tags: { building: "hospital" } };
  const found = await defaultMapProviders(service as never, { fetch: overpassFetch(() => ({ elements: [tagged] }), () => ({ elements: [] })) }).buildings(P);
  assert.equal(found[0]!.use, "hospital");
});

test("buildings: when the sensitive-site lookup fails, nearby buildings still come back and say so", async () => {
  const fetch = overpassFetch(() => ({ elements: [house] }), () => { throw new Error("site lookup down"); });
  const found = await defaultMapProviders(service as never, { geoapifyApiKey: " ", fetch }).buildings(P);
  assert.deepEqual(found.map((b) => b.id), ["osm:way:1"]);
  assert.equal(found.sensitiveSitesUnavailable, true);
});

test("buildings: a partial Overpass answer for sites counts as a failed lookup", async () => {
  const found = await defaultMapProviders(service as never, { geoapifyApiKey: " ", fetch: overpassFetch(() => ({ elements: [house] }), () => ({ elements: [], remark: "runtime error" })) }).buildings(P);
  assert.equal(found.sensitiveSitesUnavailable, true);
  assert.equal(found.length, 1);
});

test("buildings: Geoapify stands in for the sensitive-site lookup when Overpass fails it", async () => {
  let asked = "";
  const fetch = overpassFetch(() => ({ elements: [house] }), () => { throw new Error("down"); }, (url) => {
    asked = url;
    return { features: [
      { properties: { name: "Elm", lat: 32.97, lon: -96.75, place_id: "s", categories: ["education", "education.school"] } },
      { properties: { name: "Doc", lat: 32.97, lon: -96.75, place_id: "c", categories: ["healthcare.clinic_or_praxis.general"] } },
      { properties: { name: "Mystery", lat: 32.97, lon: -96.75, place_id: "m", categories: ["commercial"] } },
    ] };
  });
  const found = await defaultMapProviders(service as never, { geoapifyApiKey: "k", fetch }).buildings(P);
  assert.deepEqual(found.map((b) => [b.name, b.use]), [["House", undefined], ["Elm", "school"], ["Doc", "clinic"]]);
  assert.equal(found.sensitiveSitesUnavailable, undefined);
  assert.match(asked, /circle%3A-96\.75%2C32\.98%2C3000/);
});

test("buildings: an ordinary-lookup failure still fails, so the forecast says buildings could not be loaded", async () => {
  const fetch = overpassFetch(() => { throw new Error("down"); }, () => ({ elements: [] }));
  await assert.rejects(defaultMapProviders(service as never, { geoapifyApiKey: " ", fetch }).buildings(P));
});
