import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import type { GeoPoint, IncidentState, MapIncident } from "@firewatch/shared/types";
import { createApp } from "../app.ts";
import { createBuildingService } from "../buildings/service.ts";
import { VOICE_INCIDENT_FALLBACK, VOICE_INCIDENT_NEW, VOICE_INCIDENT_NOT_FOUND, VOICE_INCIDENT_UPDATE, VOICE_INCIDENT_WHAT, VOICE_INCIDENT_WHERE } from "../transport/voice.ts";
import type { RoadWay } from "./crashModel.ts";
import type { MapProviders } from "./providers.ts";
import { MapIncidents, type MapIncidentInput } from "./service.ts";
import { parseMapIncident } from "../transport/http.ts";
import { IncidentStore, mapRecommendations } from "../state/store.ts";

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

test("every call shows in caller reports and fills Next actions; a building change keeps them; a reset clears them", quietly(async () => {
  const s = await serve();
  try {
    await s.call("/voice/incident", crash);
    await s.settled();
    await s.call("/voice/incident", { ...crash, description: "someone is trapped" });
    let state = s.app.store.get();
    assert.equal(state.reports.length, 2);
    assert.match(state.reports[0]!.text, /^Car crash at 1 Main St: two cars hit head on/);
    assert.equal(state.reports[0]!.channel, "voice");
    assert.equal(state.reports[0]!.roomId, undefined);
    assert.match(state.recommendation!.actions[0]!, /^Send responders to 1 Main St, Richardson\.$/);
    assert.match(state.recommendation!.actions[1]!, /^Modeled forecast: /);

    s.app.live.reset();
    state = s.app.store.get();
    assert.equal(state.reports.length, 2);
    assert.ok(state.recommendation);

    await s.call("/live/reset", {});
    state = s.app.store.get();
    assert.deepEqual(state.reports, []);
    assert.equal(state.recommendation, undefined);
  } finally { await s.close(); }
}));

test("a pin-only emergency gets Next actions, and never replaces a building fire's plan", quietly(async () => {
  const s = await serve();
  try {
    await s.call("/voice/incident", { type: "other", what: "gas leak", address: "9 Far Rd", description: "smells like gas", caller: "+1" });
    assert.match(s.app.store.get().recommendation!.actions[0]!, /for: Gas leak\.$/);
    assert.equal(s.app.store.get().recommendation!.actions.length, 1);

    const plan = { actions: ["Evacuate floors 6 to 12 by Stairwell A"] };
    s.app.store.setRecommendation(plan);
    await s.call("/voice/incident", crash);
    await s.settled();
    assert.equal(s.app.store.get().recommendation, plan);
  } finally { await s.close(); }
}));

const report = (over: Partial<MapIncidentInput> = {}): MapIncidentInput => ({ kind: "crash", address: "1 Main St", description: "wreck", severity: "unknown", lanesBlocked: "unknown", inBuilding: false, caller: "+1", channel: "voice", ...over });

/** The service on its own, with refreshes off unless a test turns them on. */
function direct(over: Partial<MapProviders> = {}, options: { forecastRefreshMs?: number } = {}) {
  const store = new IncidentStore();
  const service = new MapIncidents(store, providers(over), undefined, { forecastRefreshMs: 0, ...options });
  const incident = (id = "inc-1") => store.get().mapIncidents!.find((x) => x.id === id)!;
  return { store, service, incident, list: () => store.get().mapIncidents ?? [] };
}

async function until(what: string, check: () => boolean, ms = 2000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 2))) if (check()) return;
  assert.fail(`timed out waiting for: ${what}`);
}
const ready = (s: ReturnType<typeof direct>, id = "inc-1") => until("forecast", () => s.incident(id).forecastStatus === "ready");

test("reports and log entries carry the incident id; the caller's reply is stored on both records", quietly(async () => {
  const s = direct();
  const { reply, incident } = await s.service.report(report());
  await ready(s);
  assert.equal(incident.id, "inc-1");
  assert.equal(incident.reports[0]!.reply, reply, "the returned incident already has it");
  assert.equal(s.incident().reports[0]!.reply, reply);
  assert.equal(s.store.get().reports[0]!.reply, reply);
  assert.equal(s.store.get().reports[0]!.incidentId, "inc-1");
  assert.ok(s.store.get().log!.length >= 3);
  assert.ok(s.store.get().log!.every((l) => l.incidentId === "inc-1"));

  const follow = await s.service.report(report({ description: "still blocked" }));
  assert.equal(follow.reply, VOICE_INCIDENT_UPDATE);
  assert.equal(s.incident().reports[1]!.reply, VOICE_INCIDENT_UPDATE);
  assert.equal(s.store.get().reports[1]!.reply, VOICE_INCIDENT_UPDATE);
  assert.equal(s.incident().reports[0]!.reply, reply, "the earlier reply stays");
}));

test("a duplicate merged by the 150 m check hands its reports and log entries to the survivor", quietly(async () => {
  const s = direct();
  await s.service.report(report({ caller: "+1" }));
  await ready(s);
  const second = await s.service.report(report({ address: "1 Main Street at the light", caller: "+2" }));
  assert.equal(second.incident.id, "inc-1");
  assert.equal(s.list().length, 1);
  assert.equal(s.incident().reports[1]!.reply, second.reply);
  assert.ok(s.store.get().reports.every((r) => r.incidentId === "inc-1"));
  assert.ok(s.store.get().log!.every((l) => l.incidentId === "inc-1"));
}));

test("a follow-up identifying a building fire activates its building tools", quietly(async () => {
  const store = new IncidentStore();
  const queries: unknown[] = [];
  const service = new MapIncidents(store, providers(), { lookupAddress: (query) => queries.push(query) }, { forecastRefreshMs: 0 });
  await service.report(report({ kind: "fire" }));
  assert.equal(queries.length, 0);
  const follow = await service.report(report({ kind: "fire", inBuilding: true, address: undefined, description: "it is inside the kitchen" }));
  assert.equal(follow.incident.inBuilding, true);
  assert.deepEqual(queries, ["1 Main St"]);
  assert.equal(follow.reply, VOICE_INCIDENT_NEW.buildingFire);
  await service.report(report({ kind: "fire", description: "still burning" }));
  assert.equal(store.get().mapIncidents![0]!.inBuilding, true, "an omitted flag does not remove building ownership");
  assert.equal(queries.length, 1, "ordinary follow-ups do not restart the lookup");
}));

test("merged callers preserve urgent scene details and the surviving building address", quietly(async () => {
  const store = new IncidentStore();
  const queries: unknown[] = [];
  const service = new MapIncidents(store, providers(), { lookupAddress: (query) => queries.push(query) }, { forecastRefreshMs: 0 });
  await service.report(report({ kind: "fire", severity: "minor" }));
  const merged = await service.report(report({ kind: "fire", caller: "+2", address: "1 Main Street at the light", inBuilding: true, severity: "critical" }));
  assert.equal(merged.incident.id, "inc-1");
  assert.equal(merged.incident.inBuilding, true);
  assert.equal(merged.incident.severity, "critical");
  assert.deepEqual(queries, ["1 Main St"], "lookup address still matches the incident that owns it");

  const s = direct();
  await s.service.report(report({ lanesBlocked: "some", severity: "critical" }));
  await ready(s);
  const before = s.incident().crash;
  await s.service.report(report({ caller: "+2", address: "1 Main Street at the light", lanesBlocked: "all", severity: "minor" }));
  await ready(s);
  assert.equal(s.incident().lanesBlocked, "all");
  assert.equal(s.incident().severity, "critical", "a merged report does not hide a critical report");
  assert.notEqual(s.incident().crash, before, "new blockage details rebuild the queue");
}));

test("POST /map-incidents: channel is console; an operator's two reports stay separate incidents", quietly(async () => {
  const s = await serve();
  try {
    const manual = { type: "crash", address: "1 Main St", description: "two cars", severity: "serious", lanes_blocked: "all", what: "pileup", in_building: false };
    await s.call("/map-incidents", manual, {});
    await s.call("/map-incidents", { ...manual, address: "9 Far Rd", caller: "Dispatcher" }, {});
    await s.call("/map-incidents", { ...manual, address: "1 Main St", caller: "Dispatcher" }, {});
    const list = await s.settled();
    assert.equal(list.length, 2, "same place still joins; the same operator elsewhere does not");
    assert.equal(list[0]!.reports[0]!.channel, "console");
    assert.equal(list[0]!.reports[0]!.caller, "console operator");
    assert.equal(list[0]!.label, "Pileup");
    assert.equal(list[0]!.severity, "serious");
    assert.equal(list[0]!.lanesBlocked, "all");
    assert.equal(s.app.store.get().reports[0]!.channel, "console");
  } finally { await s.close(); }
}));

test("recommend writes the incident's and the global slot with one object; a building plan is never replaced", quietly(async () => {
  const s = direct();
  await s.service.report(report());
  await ready(s);
  assert.ok(s.incident().recommendation);
  assert.equal(s.store.get().recommendation, s.incident().recommendation, "same object");
  assert.ok(mapRecommendations.has(s.incident().recommendation!));

  const plan = { actions: ["Evacuate floors 6 to 12 by Stairwell A"] };
  s.store.setRecommendation(plan);
  await s.service.report(report({ kind: "other", what: "gas leak", address: "9 Far Rd", caller: "+2" }));
  assert.equal(s.store.get().recommendation, plan, "the building's plan stays");
  assert.match(s.incident("inc-2").recommendation!.actions[0]!, /for: Gas leak\.$/, "but the incident has its own");
}));

test("dispatch, phase and notes: an open incident moves on, and unknown ids are refused", quietly(async () => {
  const s = direct();
  await s.service.report(report());
  await ready(s);
  assert.equal(s.incident().phase, "open");

  assert.deepEqual(s.service.dispatch("inc-1", "Engine 3"), { ok: true });
  assert.equal(s.incident().phase, "dispatched");
  assert.equal(s.incident().dispatches![0]!.unit, "Engine 3");
  assert.equal(s.store.get().log!.at(-1)!.kind, "dispatch");
  assert.equal(s.store.get().log!.at(-1)!.incidentId, "inc-1");
  s.service.dispatch("inc-1");
  assert.equal(s.incident().dispatches!.length, 2);
  assert.equal(s.incident().dispatches![1]!.unit, undefined);

  s.service.setPhase("inc-1", "on_scene");
  s.service.dispatch("inc-1", "Ladder 1");
  assert.equal(s.incident().phase, "on_scene", "a later dispatch does not move it backwards");

  for (let i = 0; i < 60; i++) s.service.addNote("inc-1", `note ${i}`);
  assert.equal(s.incident().notes!.length, 50);
  assert.equal(s.incident().notes!.at(-1)!.text, "note 59");

  assert.equal(s.service.dispatch("nope").ok, false);
  assert.equal(s.service.setPhase("nope", "resolved").ok, false);
  assert.equal(s.service.addNote("nope", "x").ok, false);

  s.service.setPhase("inc-1", "resolved");
  assert.equal(s.service.dispatch("inc-1", "Engine 9").ok, false, "a resolved incident takes no more units");
}));

test("resolved: stays listed, clears its pending recommendation, and a new report opens a new incident", quietly(async () => {
  const s = direct();
  await s.service.report(report());
  await ready(s);
  assert.ok(s.store.get().recommendation);
  s.service.setPhase("inc-1", "resolved");
  assert.equal(s.list().length, 1);
  assert.equal(s.incident().recommendation, undefined);
  assert.equal(s.store.get().recommendation, undefined);

  const same = await s.service.report(report({ description: "another crash here" }));
  assert.equal(same.incident.id, "inc-2", "same caller and address");
  await ready(s, "inc-2");
  assert.equal(s.list().length, 2);
  assert.equal(s.incident("inc-2").phase, "open");
  assert.equal(s.incident("inc-1").reports.length, 1);

  // The 150 m check also skips it: resolve the new one, then report from nearby with another caller.
  s.service.setPhase("inc-2", "resolved");
  await s.service.report(report({ address: "1 Main Street at the light", caller: "+9" }));
  await ready(s, "inc-3");
  assert.equal(s.list().length, 3);
}));

test("MAX_INCIDENTS drops the oldest resolved incident first, then the oldest of any phase", quietly(async () => {
  const s = direct();
  for (let i = 0; i < 50; i++) await s.service.report(report({ kind: "other", what: `thing ${i}`, address: undefined, caller: `+${i}` }));
  s.service.setPhase("inc-10", "resolved");
  s.service.setPhase("inc-20", "resolved");

  await s.service.report(report({ kind: "other", what: "next", address: undefined, caller: "+a" }));
  assert.equal(s.list().length, 50);
  assert.ok(!s.list().some((x) => x.id === "inc-10"), "oldest resolved goes first");
  assert.ok(s.list().some((x) => x.id === "inc-1"), "the oldest open one stays");
  await s.service.report(report({ kind: "other", what: "next 2", address: undefined, caller: "+b" }));
  assert.ok(!s.list().some((x) => x.id === "inc-20"));
  await s.service.report(report({ kind: "other", what: "next 3", address: undefined, caller: "+c" }));
  assert.ok(!s.list().some((x) => x.id === "inc-1"), "no resolved left: the oldest goes");
  assert.equal(s.list().at(-1)!.label, "Next 3");
}));

test("other incidents join only with the same label; a report that gives no label can still attach", quietly(async () => {
  const s = direct();
  const gas = report({ kind: "other", what: "gas leak", address: "1 Main St", caller: "+1" });
  await s.service.report(gas);
  await s.service.report({ ...gas, what: "flood", description: "water everywhere" });
  assert.equal(s.list().length, 2, "same caller, different emergency");
  assert.equal(s.incident("inc-2").status, "located", "and its pin was not merged by distance");

  await s.service.report({ ...gas, what: "  GAS   LEAK ", description: "the smell is stronger" });
  assert.equal(s.incident("inc-1").reports.length, 2, "normalized labels match");
  await s.service.report({ ...gas, what: undefined, description: "still here" });
  assert.equal(s.list().length, 2);
  const joined = s.incident("inc-2").reports.length + s.incident("inc-1").reports.length;
  assert.equal(joined, 4, "no label attaches to the caller's latest");

  await s.service.report(report({ kind: "other", what: "flood", address: "1 Main Street at the light", caller: "+5" }));
  assert.equal(s.list().length, 2, "a flood within 150 m joins the flood");
  assert.equal(s.incident("inc-2").reports.at(-1)!.caller, "+5");
  await s.service.report(report({ kind: "other", what: "sinkhole", address: "1 Main Street at the light", caller: "+6" }));
  assert.equal(s.list().length, 3, "a sinkhole within 150 m does not");
}));

test("a correction clears the old place's forecast and recommendation; a late forecast for it is dropped", quietly(async () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const s = direct({ roads: async () => { await hold; return ROADS; } });
  await s.service.report(report());
  assert.equal(s.incident().forecastStatus, "running");
  await s.service.report(report({ address: "nowhere special" }));
  release();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(s.incident().status, "needs_location");
  assert.equal(s.incident().crash, undefined, "the old forecast did not land");
  assert.equal(s.incident().forecastStatus, "none");
  assert.equal(s.store.get().recommendation, undefined);
}));

test("forecastAt is set when a forecast is written, and refresh picks up a wind change without a flicker", quietly(async () => {
  let wind = { speedMps: 4, fromDegrees: 180 };
  let clock = 1000;
  const store = new IncidentStore();
  const service = new MapIncidents(store, providers({ wind: async () => wind }), undefined, { forecastRefreshMs: 5, now: () => clock });
  const s = { store, incident: () => store.get().mapIncidents![0]! };
  await service.report(report({ kind: "fire", caller: "+1" }));
  await until("first forecast", () => s.incident().forecastStatus === "ready");
  assert.equal(s.incident().forecastAt, 1000);
  const recs = store.get().log!.filter((l) => l.kind === "recommendation").length;

  const statuses: string[] = [];
  const stop = store.subscribe((state) => statuses.push(state.mapIncidents![0]!.forecastStatus));
  clock = 2000;
  wind = { speedMps: 9, fromDegrees: 90 };
  await until("wind change", () => s.incident().fire?.wind?.fromDegrees === 90);
  assert.equal(s.incident().forecastAt, 2000);
  assert.ok(statuses.every((status) => status === "ready"), `no flicker, saw ${[...new Set(statuses)]}`);
  assert.equal(store.get().log!.filter((l) => l.kind === "recommendation").length, recs, "no log noise");
  assert.equal(store.get().recommendation, s.incident().recommendation, "the global slot follows the refreshed one");
  stop();
  service.clear();
}));

test("refresh failures keep the last forecast, and it never overwrites an accepted recommendation", quietly(async () => {
  let wind: { speedMps: number; fromDegrees: number } | null = { speedMps: 4, fromDegrees: 180 };
  let calls = 0;
  const s = direct({ wind: async () => { calls++; if (!wind) throw new Error("open-meteo"); return wind; } }, { forecastRefreshMs: 5 });
  await s.service.report(report({ kind: "fire" }));
  await ready(s);
  const original = s.incident().fire;

  wind = null;
  const after = calls;
  await until("a refresh with no wind", () => calls > after + 2);
  assert.equal(s.incident().fire, original, "a missed reading does not erase the plume");
  assert.equal(s.incident().forecastStatus, "ready");

  wind = { speedMps: 9, fromDegrees: 90 };
  s.store.acceptIncidentRecommendation("inc-1");
  const accepted = s.incident().accepted;
  const before = s.store.get().log!.length;
  await until("a refresh", () => s.incident().fire?.wind?.fromDegrees === 90);
  assert.equal(s.incident().accepted, accepted);
  assert.equal(s.incident().recommendation, undefined, "no new pending recommendation");
  assert.equal(s.store.get().recommendation, undefined);
  assert.equal(s.store.get().log!.length, before);
  s.service.clear();
}));

test("a failed forecast retries on refresh and recovers", quietly(async () => {
  let up = false;
  const s = direct({ roads: async () => { if (!up) throw new Error("overpass"); return ROADS; } }, { forecastRefreshMs: 5 });
  await s.service.report(report());
  await until("failure", () => s.incident().forecastStatus === "failed");
  assert.ok(s.incident().error);
  assert.equal(s.incident().recommendation!.actions.length, 1);
  up = true;
  await ready(s);
  assert.equal(s.incident().error, undefined);
  assert.equal(s.incident().recommendation!.actions.length, 2, "the pending recommendation gains the forecast");
  s.service.clear();
}));

test("timers stop on resolve, reset and when disabled; reopening resumes", quietly(async () => {
  let calls = 0;
  const counted = { wind: async () => { calls++; return { speedMps: 4, fromDegrees: 180 }; } };
  const s = direct(counted, { forecastRefreshMs: 5 });
  await s.service.report(report({ kind: "fire" }));
  await ready(s);
  await until("some refreshes", () => calls >= 3);
  s.service.setPhase("inc-1", "resolved");
  await new Promise((r) => setTimeout(r, 10));
  const resolvedCalls = calls;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls, resolvedCalls, "resolve stops the refresh");

  s.service.setPhase("inc-1", "on_scene");
  await until("refresh resumes", () => calls >= resolvedCalls + 2);
  s.service.clear();
  await new Promise((r) => setTimeout(r, 10));
  const clearedCalls = calls;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls, clearedCalls, "clear stops it");

  let offCalls = 0;
  const off = direct({ wind: async () => { offCalls++; return { speedMps: 4, fromDegrees: 180 }; } }, { forecastRefreshMs: 0 });
  await off.service.report(report({ kind: "fire" }));
  await ready(off);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(offCalls, 1, "0 disables it");
}));

test("resolving during a forecast run does not leave it spinning", quietly(async () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const s = direct({ roads: async () => { await hold; return ROADS; } });
  await s.service.report(report());
  assert.equal(s.incident().forecastStatus, "running");
  s.service.setPhase("inc-1", "resolved");
  assert.equal(s.incident().forecastStatus, "none");
  release();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(s.incident().crash, undefined);
  assert.equal(s.incident().recommendation, undefined);
}));

test("manual reports and response actions reach WebSocket clients and survive reconnect", quietly(async () => {
  const s = await serve();
  const url = `ws://127.0.0.1:${(s.app.httpServer.address() as AddressInfo).port}`;
  const ws = new WebSocket(url);
  let reconnected: WebSocket | undefined;
  let received: IncidentState | undefined;
  ws.on("message", (data) => { received = JSON.parse(data.toString()).state; });
  try {
    await once(ws, "open");
    const response = await s.call("/map-incidents", crash, {});
    assert.equal(response.status, 200);
    const [{ id }] = (await s.settled()) as [MapIncident];
    await until("manual report broadcast", () => received?.mapIncidents?.[0]?.forecastStatus === "ready");
    assert.equal(received!.reports[0]!.incidentId, id);
    assert.equal(received!.reports[0]!.channel, "console");
    assert.equal(received!.reports[0]!.reply, response.body.reply);
    assert.equal(received!.mapIncidents![0]!.reports[0]!.reply, response.body.reply);
    const send = (event: Record<string, unknown>) => ws.send(JSON.stringify({ ...event, incidentId: id }));

    send({ type: "dispatchIncident", unit: " Engine 3 " });
    await until("dispatch", () => s.incidents()[0]!.phase === "dispatched");
    assert.equal(s.incidents()[0]!.dispatches![0]!.unit, "Engine 3");

    send({ type: "addIncidentNote", text: "  gate code 4412 " });
    await until("note", () => s.incidents()[0]!.notes?.[0]?.text === "gate code 4412");

    send({ type: "acceptRecommendation" });
    await until("accept", () => s.incidents()[0]!.accepted !== undefined);
    assert.equal(s.app.store.get().recommendation, undefined);

    send({ type: "setIncidentPhase", phase: "resolved" });
    await until("resolve broadcast", () => received?.mapIncidents?.[0]?.phase === "resolved");
    ws.terminate();
    reconnected = new WebSocket(url);
    const [snapshot] = await once(reconnected, "message");
    const restored = JSON.parse(snapshot.toString()).state as IncidentState;
    assert.equal(restored.mapIncidents![0]!.id, id);
    assert.equal(restored.mapIncidents![0]!.phase, "resolved");
    assert.equal(restored.mapIncidents![0]!.dispatches![0]!.unit, "Engine 3");
    assert.equal(restored.mapIncidents![0]!.notes![0]!.text, "gate code 4412");
    assert.ok(restored.mapIncidents![0]!.accepted);
    assert.equal(restored.mapIncidents![0]!.recommendation, undefined);

    await s.call("/live/reset", {});
    assert.deepEqual(s.incidents(), []);
    assert.equal(s.app.store.get().recommendation, undefined);
  } finally {
    ws.terminate();
    reconnected?.terminate();
    await s.close();
  }
}));
