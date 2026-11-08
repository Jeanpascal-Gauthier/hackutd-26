import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { IncidentState } from "@firewatch/shared/types";
import { DEMO } from "../live/buildingData.ts";
import { HOLD_REPLY } from "../live/lookup.ts";
import { VOICE_ADDRESS_PROMPT, VOICE_ADDRESS_REPLY } from "./voice.ts";
import { ADDRESS, fakeApp, gate } from "../testing/lookupFakes.ts";

const TOKEN = "voice-test-token";

async function serve(options: Parameters<typeof fakeApp>[0] = {}) {
  const { app, world, fakes } = fakeApp({ voiceToken: TOKEN, ...options });
  app.httpServer.listen(0, "127.0.0.1");
  await once(app.httpServer, "listening");
  const base = `http://127.0.0.1:${(app.httpServer.address() as AddressInfo).port}`;
  const post = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const get = async (path: string) => (await fetch(base + path)).json() as Promise<Record<string, any>>;
  const close = async () => {
    app.httpServer.closeAllConnections();
    await new Promise<void>((resolve) => app.httpServer.close(() => resolve()));
  };
  return { app, world, fakes, base, post, get, close };
}

const quietly = <T>(fn: () => Promise<T>) => async () => {
  const { log, error, warn } = console;
  console.log = console.error = console.warn = () => {};
  try { return await fn(); } finally { Object.assign(console, { log, error, warn }); }
};

test("POST /voice/address: token required; empty address asks for it; an address starts the lookup", quietly(async () => {
  const s = await serve();
  try {
    assert.equal((await s.post("/voice/address", { address: ADDRESS })).status, 401);
    assert.equal((await s.post("/voice/address", { address: ADDRESS }, { "x-firesight-token": "nope" })).status, 401);
    const auth = { "x-firesight-token": TOKEN };
    const empty = await s.post("/voice/address", { address: "  ", caller: "+1" }, auth);
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body, { ok: false, reply: VOICE_ADDRESS_PROMPT });
    assert.equal(s.app.store.get().buildingLookup, undefined);

    const ok = await s.post("/voice/address", { address: ADDRESS, caller: "+15550100" }, { authorization: `Bearer ${TOKEN}` });
    assert.deepEqual(ok.body, { ok: true, reply: VOICE_ADDRESS_REPLY });
    assert.equal(VOICE_ADDRESS_REPLY, "Thank you, I have the address. Which floor is the fire or smoke on, and which room?");
    assert.equal(s.app.store.get().buildingLookup?.query, ADDRESS);
    assert.equal(s.app.store.get().buildingLookup?.caller, "+15550100");

    // While the operator confirms, a call report gets the hold reply.
    await s.app.lookups.idle();
    const call = await s.post("/voice/report", { text: "smoke in the break room on floor 2", caller: "+15550100" }, auth);
    assert.equal(call.body.reply, HOLD_REPLY);
    assert.equal(call.body.roomId, null);
  } finally {
    await s.close();
  }
  const off = await serve({ voiceToken: undefined });
  try {
    assert.equal((await off.post("/voice/address", { address: ADDRESS })).status, 503);
  } finally {
    await off.close();
  }
}));

test("POST /incident/address answers before Overpass; /incident/building confirms; GET /building serves the active building", quietly(async () => {
  const s = await serve();
  try {
    const overpass = gate();
    s.world.overpassGate = overpass.promise;
    const bad = await s.post("/incident/address", { address: "x" });
    assert.equal(bad.status, 400);
    const started = await s.post("/incident/address", { address: ADDRESS, caller: "form" });
    assert.equal(started.status, 200);
    assert.equal(started.body.ok, true);
    assert.equal(started.body.lookup.status, "searching", "returned while Overpass is still pending");
    overpass.open();
    await s.app.lookups.idle();
    assert.equal((await s.get("/state")).buildingLookup.status, "needs_confirmation");

    assert.equal((await s.post("/incident/building", { buildingId: "osm:way:999" })).status, 409);
    const confirmed = await s.post("/incident/building", { buildingId: "osm:way:100" });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.lookup.status, "loading");
    await s.app.lookups.idle();

    const info = await s.get("/building");
    assert.deepEqual(Object.keys(info).sort(), ["building", "doors", "inspections", "occupants", "sprinklers"]);
    assert.equal(info.building.profile.id, "osm:way:100");
    assert.equal(info.building.profile.timezone, "America/Chicago");
    assert.equal(info.building.rooms.length, 8);
    assert.equal(info.occupants.length, 2);
    assert.ok(info.occupants.every((o: { estimated?: boolean }) => o.estimated));
    assert.deepEqual(info.inspections, []);
    assert.equal(Object.keys(info.sprinklers).length, 8);
    assert.equal(info.doors.length, 6);
    const state = (await s.get("/state")) as IncidentState;
    assert.deepEqual(state.building, { id: "osm:way:100", name: "Science Hall", version: 2, layoutEstimated: true });

    // The incident endpoints use the active building's rooms.
    assert.equal((await s.post("/forecast", { origin: "7-break" })).status, 400);
    const fc = await s.post("/forecast", { origin: "2-break" });
    assert.equal(fc.status, 200);
    assert.ok(fc.body.exits.length > 0);
    assert.equal((await s.post("/ingest", { text: "fire", caller: "a", roomId: "7-break", confidence: 0.9 })).status, 400);
    const ing = await s.post("/ingest", { text: "fire", caller: "a", roomId: "2-break", confidence: 0.9 });
    assert.equal(ing.body.report.roomId, "2-break");
    assert.equal((await s.get("/state")).origin.roomId, "2-break");

    // Back to the demo building.
    const demo = await s.post("/incident/building/demo");
    assert.equal(demo.status, 200);
    const back = await s.get("/building");
    assert.equal(back.building.profile.id, "demo");
    assert.equal(back.building.rooms.length, DEMO.building.rooms.length);
    assert.equal(back.inspections.length, DEMO.inspections.length);
  } finally {
    await s.close();
  }
}));

test("POST /live/reset returns to the demo building and clears the lookup", quietly(async () => {
  const s = await serve();
  try {
    await s.post("/incident/address", { address: ADDRESS });
    await s.app.lookups.idle();
    await s.post("/incident/building", { buildingId: "osm:way:100" });
    await s.app.lookups.idle();
    assert.equal((await s.get("/building")).building.profile.id, "osm:way:100");
    assert.equal((await s.post("/live/reset")).status, 200);
    const state = (await s.get("/state")) as IncidentState;
    assert.equal(state.building?.id, "demo");
    assert.equal(state.building?.version, 3);
    assert.equal(state.buildingLookup, undefined);
    assert.deepEqual(state.reports, []);
    const info = await s.get("/building");
    assert.equal(info.building.profile.id, "demo");
    assert.deepEqual(info.doors, DEMO.doors);
  } finally {
    await s.close();
  }
}));

test("mock mode: the lookup endpoints answer 409 and the demo building stays", quietly(async () => {
  const s = await serve({ mock: true });
  try {
    const r = await s.post("/incident/address", { address: ADDRESS });
    assert.equal(r.status, 409);
    assert.equal(r.body.ok, false);
    assert.equal((await s.post("/incident/building", { buildingId: "osm:way:100" })).status, 409);
    assert.equal((await s.post("/incident/building/demo")).status, 409);
    const voice = await s.post("/voice/address", { address: ADDRESS }, { "x-firesight-token": TOKEN });
    assert.equal(voice.body.reply, VOICE_ADDRESS_REPLY);
    assert.equal(voice.body.ok, false);
    assert.equal((await s.get("/state")).building.id, "demo");
    assert.equal(s.world.calls.geoapify, 0);
  } finally {
    s.app.mock?.stop();
    await s.close();
  }
}));
