import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { GeoPoint, MapIncident } from "@firewatch/shared/types";
import { createApp } from "../app.ts";
import { createBuildingService } from "../buildings/service.ts";
import { VOICE_INCIDENT_FALLBACK, VOICE_INCIDENT_NEW, VOICE_INCIDENT_NOT_FOUND, VOICE_INCIDENT_UPDATE, VOICE_INCIDENT_WHAT, VOICE_INCIDENT_WHERE } from "../transport/voice.ts";
import type { RoadWay } from "./crashModel.ts";
import type { MapProviders } from "./providers.ts";
import { MapIncidents, type MapIncidentInput } from "./service.ts";
import { parseMapIncident } from "../transport/http.ts";
import { IncidentStore } from "../state/store.ts";

const TOKEN = "voice-test-token";
const auth = { "x-firesight-token": TOKEN };
const A: GeoPoint = { lat: 32.99, lon: -96.75 };
const FAR: GeoPoint = { lat: 33.1, lon: -96.75 };
const NEAR_A: GeoPoint = { lat: 32.9901, lon: -96.75 };
const ROADS: RoadWay[] = [{ id: 1, name: "Main St", highway: "primary", oneway: "both", lanes: null, nodes: [1, 2], geometry: [{ lat: 32.99, lon: -96.76 }, { lat: 32.99, lon: -96.74 }] }];

const PLACES: Record<string, GeoPoint> = { "1 main st": A, "1 main street at the light": NEAR_A, "9 far rd": FAR };

function providers(over: Partial<MapProviders> = {}): MapProviders & { calls: Record<string, number> } {
  const calls: Record<string, number> = { geocode: 0, roads: 0 };
  return {
    calls,
    geocode: async (query) => {
      calls.geocode!++;
      const location = PLACES[query.toLowerCase()];
      return location ? { location, formatted: `${query}, Richardson, TX 75080, United States` } : null;
    },
    roads: async () => { calls.roads!++; return ROADS; },
    buildings: async () => [],
    wind: async () => ({ speedMps: 4, fromDegrees: 180 }),
    ...over,
  };
}

async function serve(mapProviders = providers()) {
  const app = createApp({ voiceToken: TOKEN, mapProviders, buildings: createBuildingService({ geoapifyApiKey: "x", fetch: (async () => { throw new Error("no network in tests"); }) as typeof fetch }) });
  app.httpServer.listen(0, "127.0.0.1");
  await once(app.httpServer, "listening");
  const base = `http://127.0.0.1:${(app.httpServer.address() as AddressInfo).port}`;
  const call = async (path: string, body: unknown, headers: Record<string, string> = auth) => {
    const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const incidents = () => app.store.get().mapIncidents ?? [];
  const settled = async (): Promise<MapIncident[]> => {
    for (let i = 0; i < 200 && incidents().some((x) => x.forecastStatus === "running" || x.status === "locating"); i++) await new Promise((r) => setTimeout(r, 5));
    return incidents();
  };
  const close = async () => {
    app.httpServer.closeAllConnections();
    await new Promise<void>((resolve) => app.httpServer.close(() => resolve()));
  };
  return { app, call, incidents, settled, close, mapProviders };
}

const quietly = <T>(fn: () => Promise<T>) => async () => {
  const { log, error, warn } = console;
  console.log = console.error = console.warn = () => {};
  try { return await fn(); } finally { Object.assign(console, { log, error, warn }); }
};

const crash = { type: "crash", address: "1 Main St", description: "two cars hit head on", lanes_blocked: "all", severity: "serious", caller: "+15550100" };

test("POST /voice/incident: needs the token and a description", quietly(async () => {
  const s = await serve();
  try {
    assert.equal((await s.call("/voice/incident", crash, {})).status, 401);
    assert.deepEqual((await s.call("/voice/incident", { type: "crash" })).body, { ok: false, reply: VOICE_INCIDENT_WHAT });
    assert.deepEqual(s.incidents(), []);
  } finally { await s.close(); }
}));

test("crash: pinned, read back to the caller, congestion forecast appears", quietly(async () => {
  const s = await serve();
  try {
    const r = await s.call("/voice/incident", crash);
    assert.equal(r.body.reply, `I have the location as 1 Main St, Richardson. ${VOICE_INCIDENT_NEW.crash}`);
    const [incident] = await s.settled();
    assert.equal(incident!.kind, "crash");
    assert.equal(incident!.severity, "serious");
    assert.deepEqual(incident!.location, A);
    assert.equal(incident!.forecastStatus, "ready");
    assert.equal(incident!.crash!.road, "Main St");
    assert.ok(incident!.crash!.segments.length > 0);
  } finally { await s.close(); }
}));

test("other emergencies are a pin with no forecast, and keep the caller's label", quietly(async () => {
  const s = await serve();
  try {
    const r = await s.call("/voice/incident", { type: "something odd", what: "gas leak", address: "9 Far Rd", description: "smells like gas", caller: "+1" });
    assert.match(r.body.reply, new RegExp(VOICE_INCIDENT_NEW.other.replace(/\?/g, "\\?")));
    const [incident] = await s.settled();
    assert.equal(incident!.kind, "other");
    assert.equal(incident!.label, "Gas leak");
    assert.equal(incident!.status, "located");
    assert.equal(incident!.forecastStatus, "none");
  } finally { await s.close(); }
}));

test("fire: the map gets a plume; a building fire also starts the lookup and asks for the floor", quietly(async () => {
  const s = await serve();
  try {
    const r = await s.call("/voice/incident", { type: "fire", in_building: true, address: "1 Main St", description: "kitchen fire", caller: "+1" });
    assert.ok(r.body.reply.endsWith(VOICE_INCIDENT_NEW.buildingFire));
    assert.equal(s.app.store.get().buildingLookup?.query, "1 Main St");
    const [incident] = await s.settled();
    assert.equal(incident!.fire!.wind!.fromDegrees, 180);
    assert.equal(incident!.fire!.steps.length, 5);
  } finally { await s.close(); }
}));

test("the same caller adds to their incident; a changed lane count re-forecasts from cached roads", quietly(async () => {
  const s = await serve();
  try {
    await s.call("/voice/incident", { ...crash, lanes_blocked: "some" });
    await s.settled();
    const before = s.incidents()[0]!.crash!;
    const r = await s.call("/voice/incident", { ...crash, description: "now both lanes are stopped" });
    assert.equal(r.body.reply, VOICE_INCIDENT_UPDATE);
    const list = await s.settled();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.reports.length, 2);
    assert.equal(list[0]!.lanesBlocked, "all");
    assert.notDeepEqual(list[0]!.crash, before);
    assert.equal(s.mapProviders.calls.roads, 1);
  } finally { await s.close(); }
}));

test("a caller's correction moves the pin", quietly(async () => {
  const s = await serve();
  try {
    await s.call("/voice/incident", crash);
    await s.settled();
    await s.call("/voice/incident", { ...crash, address: "9 Far Rd", description: "sorry, it is on Far Road" });
    const list = await s.settled();
    assert.equal(list.length, 1);
    assert.deepEqual(list[0]!.location, FAR);
  } finally { await s.close(); }
}));

test("two callers at the same spot become one incident; a different kind or place does not", quietly(async () => {
  const s = await serve();
  try {
    await s.call("/voice/incident", crash);
    await s.settled();
    const second = await s.call("/voice/incident", { ...crash, address: "1 Main Street at the light", description: "saw a wreck", caller: "+15550200" });
    assert.equal(second.status, 200);
    assert.equal(second.body.ok, true);
    await s.settled();
    assert.equal(s.incidents().length, 1);
    assert.equal(s.incidents()[0]!.reports.length, 2);
    await s.call("/voice/incident", { type: "fire", address: "1 Main St", description: "car on fire", caller: "+15550300" });
    await s.call("/voice/incident", { ...crash, address: "9 Far Rd", caller: "+15550400" });
    assert.equal((await s.settled()).length, 3);
  } finally { await s.close(); }
}));

test("an unknown place asks again, and the answer locates the same incident", quietly(async () => {
  const s = await serve();
  try {
    assert.equal((await s.call("/voice/incident", { ...crash, address: "nowhere special" })).body.reply, VOICE_INCIDENT_NOT_FOUND);
    assert.equal(s.incidents()[0]!.status, "needs_location");
    await s.call("/voice/incident", crash);
    const list = await s.settled();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.status, "located");
  } finally { await s.close(); }
}));

test("no location given: the incident is logged and the caller is asked where", quietly(async () => {
  const s = await serve();
  try {
    assert.equal((await s.call("/voice/incident", { type: "crash", description: "bad wreck", caller: "+1" })).body.reply, VOICE_INCIDENT_WHERE);
    assert.equal(s.incidents()[0]!.status, "needs_location");
  } finally { await s.close(); }
}));

test("outages: geocoder down marks it failed; no road data fails only the forecast; the caller still gets a reply", quietly(async () => {
  const down = await serve(providers({ geocode: async () => { throw new Error("503"); } }));
  try {
    const r = await down.call("/voice/incident", crash);
    assert.equal(r.body.reply, VOICE_INCIDENT_NEW.crash);
    assert.equal(down.incidents()[0]!.status, "failed");
  } finally { await down.close(); }

  const noRoads = await serve(providers({ roads: async () => { throw new Error("overpass"); } }));
  try {
    await noRoads.call("/voice/incident", crash);
    const [incident] = await noRoads.settled();
    assert.equal(incident!.status, "located");
    assert.equal(incident!.forecastStatus, "failed");
  } finally { await noRoads.close(); }

  const noWeather = await serve(providers({ wind: async () => { throw new Error("x"); }, buildings: async () => { throw new Error("y"); } }));
  try {
    await noWeather.call("/voice/incident", { type: "fire", address: "1 Main St", description: "brush fire", caller: "+1" });
    const [incident] = await noWeather.settled();
    assert.equal(incident!.forecastStatus, "ready");
    assert.equal(incident!.fire!.wind, null);
  } finally { await noWeather.close(); }
  assert.ok(VOICE_INCIDENT_FALLBACK);
}));

test("a slow geocoder does not hold up the reply, and its late answer still places the pin", quietly(async () => {
  let finish!: (match: { location: GeoPoint; formatted: string }) => void;
  const store = new IncidentStore();
  const service = new MapIncidents(store, providers({ geocode: () => new Promise((resolve) => (finish = resolve)) }), undefined, { geocodeWaitMs: 5 });
  const { incident, reply } = await service.report({ kind: "other", what: "flood", address: "1 Main St", description: "water rising", severity: "unknown", lanesBlocked: "unknown", inBuilding: false, channel: "voice" });
  assert.equal(reply, VOICE_INCIDENT_NEW.other);
  assert.equal(incident.status, "locating");
  finish({ location: A, formatted: "1 Main St" });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(store.get().mapIncidents![0]!.status, "located");
}));

test("no caller id: the answer to 'where is it' fills in the same incident", quietly(async () => {
  const s = await serve();
  try {
    await s.call("/voice/incident", { type: "crash", description: "bad wreck" });
    await s.call("/voice/incident", { type: "crash", address: "1 Main St", description: "it is on Main" });
    const list = await s.settled();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.status, "located");
  } finally { await s.close(); }
}));

test("a building change keeps the map; POST /live/reset empties it", quietly(async () => {
  const s = await serve();
  try {
    await s.call("/voice/incident", crash);
    await s.settled();
    s.app.live.reset();
    assert.equal(s.incidents().length, 1, "a building change keeps the map");
    assert.equal((await s.call("/live/reset", {})).status, 200);
    assert.deepEqual(s.incidents(), []);
    assert.equal((await s.call("/map-incidents", {}, {})).status, 400);
    assert.equal((await s.call("/map-incidents", crash, {})).status, 200);
  } finally { await s.close(); }
}));

test("the caller's own words count when the voice agent leaves lanes_blocked out", () => {
  const lanes = (description: string, lanes_blocked?: string) => (parseMapIncident({ type: "crash", description, lanes_blocked }, "voice") as MapIncidentInput).lanesBlocked;
  assert.equal(lanes("Two cars crashed and all lanes are blocked."), "all");
  assert.equal(lanes("both lanes are stopped"), "all");
  assert.equal(lanes("the road is completely blocked"), "all");
  assert.equal(lanes("a fender bender", "all lanes"), "all");
  assert.equal(lanes("not all lanes are blocked"), "unknown");
  assert.equal(lanes("one lane is blocked"), "unknown");
  assert.equal(lanes("all lanes are blocked", "some"), "some", "an explicit value wins");
});
