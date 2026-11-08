import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildingApiError, createBuildingService } from "./service.ts";
import { addressKey, createSnapshotStore, parseSnapshot, writeSnapshot, type BuildingSnapshot } from "./snapshots.ts";
import type { OsmElement } from "./types.ts";
import { ADDRESS, ELEMENTS, fakeApp, fakeFetch, fakeWorld, LOCATION } from "../testing/lookupFakes.ts";

const SAVED_AT = "2026-11-07T18:30:00.000Z";
const rectangle = (s: number, w: number, n: number, e: number) => [
  { lat: s, lon: w }, { lat: s, lon: e }, { lat: n, lon: e }, { lat: n, lon: w }, { lat: s, lon: w },
];
const ROOM = { type: "way", id: 101, tags: { indoor: "room", name: "Server Room", ref: "105", level: "0" }, geometry: rectangle(32.0001, -95.9999, 32.0003, -95.9997) };

function snapshot(): BuildingSnapshot {
  return {
    version: 1, savedAt: SAVED_AT, query: ADDRESS, aliases: ["Science Hall"],
    search: [{
      placeId: "p-1", address: "800 West Campbell Road, Richardson, TX 75080, United States", name: null, location: LOCATION,
      resultType: "building", confidence: 1, matchType: "full_match", timezone: "America/Chicago",
      source: { provider: "geoapify", name: null, attribution: null, license: null },
    }],
    location: LOCATION, nearby: ELEMENTS as OsmElement[], interiors: { "osm:way:100": [ROOM as OsmElement] },
  };
}
function snapshotDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "firesight-snapshots-"));
  writeSnapshot(dir, snapshot());
  return dir;
}
const quiet = <T>(fn: () => Promise<T>) => async () => {
  const { log, error, warn } = console;
  console.log = console.error = console.warn = () => {};
  try { return await fn(); } finally { Object.assign(console, { log, error, warn }); }
};
/** The fake world, but Overpass answers 429. */
function overpassRateLimited(calls: { overpass: number }): typeof fetch {
  const world = fakeWorld();
  const live = fakeFetch(world);
  return async (input, init) => {
    if (new URL(String(input)).hostname === "api.geoapify.com") return live(input, init);
    calls.overpass++;
    return new Response("slow down", { status: 429 });
  };
}

test("an Overpass 429 serves the saved outlines and interiors, marked as an offline copy", quiet(async () => {
  const calls = { overpass: 0 };
  const service = createBuildingService({ fetch: overpassRateLimited(calls), geoapifyApiKey: "k", snapshotDir: snapshotDir(), offline: false });
  await assert.rejects(service.resolve(LOCATION), (e: unknown) => {
    assert.ok(e instanceof BuildingApiError);
    assert.equal(e.code, "building_selection_required", "candidates and confirmation still work");
    assert.deepEqual((e.details.candidates as { id: string }[]).map((c) => c.id), ["osm:way:100", "osm:way:200"]);
    assert.equal((e.details.cache as { source: string }).source, "snapshot");
    return true;
  });
  const { building, cache } = await service.resolve({ ...LOCATION, buildingId: "osm:way:100" });
  assert.equal(cache.source, "snapshot");
  assert.equal(cache.offlineReason, "provider_rate_limited");
  assert.equal(cache.fetchedAt, SAVED_AT, "the record says when it was saved");
  assert.equal(cache.stale, false);
  assert.equal(building.name, "Science Hall");
  assert.equal(building.rooms[0].name, "Server Room", "interiors come from the snapshot too");
  assert.ok(building.warnings.includes("Offline copy saved 2026-11-07; live lookup unavailable (provider_rate_limited)."));
  assert.equal(building.source.fetchedAt, SAVED_AT);
  assert.equal(calls.overpass, 1, "right after a failure the snapshot is used without waiting on Overpass again");
  assert.equal(service.providers().snapshots.saved, 1);
}));

test("a Geoapify timeout serves the saved search; other spellings of the address find it", quiet(async () => {
  const world = fakeWorld();
  const never = new Promise<void>(() => {});
  for (const q of [ADDRESS, "800 west campbell road", "science hall", "1 unknown st, nowhere"]) world.gates.set(q.toLowerCase(), never);
  const service = createBuildingService({ fetch: fakeFetch(world), geoapifyApiKey: "k", timeoutMs: 20, snapshotDir: snapshotDir(), offline: false, providerCooldownMs: 0 });
  const result = await service.search(ADDRESS);
  assert.equal(result.cache.source, "snapshot");
  assert.equal(result.cache.offlineReason, "provider_timeout");
  assert.deepEqual(result.candidates[0].location, LOCATION);
  assert.equal((await service.search("800 West Campbell Road")).cache.source, "snapshot", "abbreviations and a missing city still match");
  assert.equal((await service.search("Science Hall")).cache.source, "snapshot", "aliases match");
  await assert.rejects(service.search("1 Unknown St, Nowhere"), (e: unknown) => e instanceof BuildingApiError && e.code === "provider_timeout");
}));

test("offline mode never calls fetch; an address without a snapshot fails clearly", async () => {
  const service = createBuildingService({
    fetch: async () => { throw new Error("offline mode must not contact a provider"); },
    geoapifyApiKey: "", snapshotDir: snapshotDir(), offline: true,
  });
  const { candidates, cache } = await service.search(ADDRESS);
  assert.equal(cache.offlineReason, "offline_mode");
  await assert.rejects(service.resolve(candidates[0].location), (e: unknown) => e instanceof BuildingApiError && e.code === "building_selection_required");
  const { building } = await service.resolve({ ...candidates[0].location, buildingId: "osm:way:100" });
  assert.equal(building.rooms.length, 1);
  // A building without saved interiors still loads its footprint, with the usual warning.
  const annex = await service.resolve({ ...candidates[0].location, buildingId: "osm:way:200" });
  assert.ok(annex.building.footprint);
  assert.ok(annex.building.warnings.some((w) => w.includes("offline_no_snapshot")));
  await assert.rejects(service.search("1 Unknown St, Nowhere"), (e: unknown) => e instanceof BuildingApiError && e.status === 503 && e.code === "offline_no_snapshot");
  await assert.rejects(service.resolve({ lat: 10, lon: 10 }), (e: unknown) => e instanceof BuildingApiError && e.code === "offline_no_snapshot");
  assert.equal(service.providers().snapshots.offlineMode, true);
});

test("with no matching snapshot the provider error is unchanged", quiet(async () => {
  for (const dir of [snapshotDir(), false as const]) {
    const calls = { overpass: 0 };
    const service = createBuildingService({ fetch: overpassRateLimited(calls), geoapifyApiKey: "k", snapshotDir: dir, offline: false });
    await assert.rejects(service.resolve({ lat: 33, lon: -97 }),
      (e: unknown) => e instanceof BuildingApiError && e.status === 503 && e.code === "provider_rate_limited");
    const world = fakeWorld();
    world.geoapifyDown = true;
    const geo = createBuildingService({ fetch: fakeFetch(world), geoapifyApiKey: "k", snapshotDir: dir, offline: false });
    await assert.rejects(geo.search("1 Unknown St, Nowhere"), (e: unknown) => e instanceof BuildingApiError && e.status === 502 && e.code === "provider_unavailable");
  }
  // Input errors are never replaced by a snapshot.
  const service = createBuildingService({ fetch: fakeFetch(fakeWorld()), snapshotDir: snapshotDir(), offline: false });
  await assert.rejects(service.resolve({ ...LOCATION, buildingId: "osm:way:999" }), (e: unknown) => e instanceof BuildingApiError && e.code === "building_not_at_location");
}));

test("order: live, then the stale in-memory copy, then the snapshot", quiet(async () => {
  let clock = 1_000_000;
  let down = false;
  const world = fakeWorld();
  world.outlines.set(`${LOCATION.lat},${LOCATION.lon}`, [ELEMENTS[0]]); // live has one outline, the snapshot two
  const live = fakeFetch(world);
  const service = createBuildingService({
    now: () => clock, lookupTtlMs: 10, snapshotDir: snapshotDir(), offline: false, geoapifyApiKey: "k",
    fetch: async (input, init) => down ? new Response("", { status: 502 }) : live(input, init),
  });
  const ids = (e: unknown) => ((e as BuildingApiError).details.candidates as { id: string }[]).map((c) => c.id);
  const first = await service.resolve(LOCATION).catch((e: unknown) => e);
  assert.deepEqual(ids(first), ["osm:way:100"]);
  assert.equal(((first as BuildingApiError).details.cache as { source: string }).source, "live");
  clock += 100;
  down = true;
  const again = await service.resolve(LOCATION).catch((e: unknown) => e);
  assert.deepEqual(ids(again), ["osm:way:100"], "the in-memory live result wins over the snapshot");
  assert.deepEqual((again as BuildingApiError).details.cache, { stale: true, fetchedAt: new Date(1_000_000).toISOString(), expiresAt: new Date(1_000_010).toISOString(), source: "live" });
}));

test("lookup flow in offline mode: search, confirmation and activation without the network; the operator is told", quiet(async () => {
  const { app, world } = fakeApp({}, { snapshotDir: snapshotDir(), offline: true });
  app.lookups.lookupAddress(ADDRESS);
  await app.lookups.idle();
  const l = app.store.get().buildingLookup!;
  assert.equal(l.status, "needs_confirmation", l.error);
  assert.equal(l.candidates.length, 2);
  app.lookups.confirmBuilding("osm:way:100");
  await app.lookups.idle();
  assert.equal(app.store.get().buildingLookup?.status, "active", app.store.get().buildingLookup?.error);
  assert.deepEqual(world.calls, { geoapify: 0, overpass: 0 });
  const log = app.store.get().log!.filter((e) => e.kind === "building").map((e) => e.text);
  assert.equal(log.filter((t) => t.includes("offline copy saved 2026-11-07")).length, 1, log.join("\n"));
  assert.match(log.find((t) => t.includes("offline copy"))!, /live lookup unavailable \(offline_mode\)/);
  assert.match(app.active.get().building.profile.assumptions[0], /^Offline copy saved 2026-11-07/);
}));

test("lookup flow: Geoapify down falls back to the snapshot and Overpass still answers live", quiet(async () => {
  const { app, world } = fakeApp({}, { snapshotDir: snapshotDir() });
  world.geoapifyDown = true;
  app.lookups.lookupAddress(ADDRESS);
  await app.lookups.idle();
  assert.equal(app.store.get().buildingLookup?.status, "needs_confirmation");
  assert.ok(app.store.get().log!.some((e) => /Address match from an offline copy saved 2026-11-07; live lookup unavailable \(provider_unavailable\)/.test(e.text)));
  assert.equal(world.calls.overpass, 1);
}));

test("snapshot files are readable JSON that round-trips; invalid files are skipped", quiet(async () => {
  const dir = snapshotDir();
  const file = join(dir, "800-w-campbell-rd-richardson-tx.json");
  const text = readFileSync(file, "utf8");
  assert.ok(text.includes('\n  "nearby": [\n    {"type":"way","id":100'), "one OSM element per line");
  assert.deepEqual(parseSnapshot(JSON.parse(text)), snapshot());
  writeFileSync(join(dir, "broken.json"), "{ not json");
  writeFileSync(join(dir, "old.json"), JSON.stringify({ ...snapshot(), version: 0 }));
  const store = createSnapshotStore(dir);
  assert.equal(store.count(), 1);
  assert.ok(store.nearby({ lat: LOCATION.lat + 0.0002, lon: LOCATION.lon }), "about 22 m away still matches");
  assert.equal(store.nearby({ lat: LOCATION.lat + 0.001, lon: LOCATION.lon }), undefined, "about 110 m away does not");
  assert.equal(addressKey("800 West Campbell Road, Richardson, Texas 75080, United States of America"), "800 w campbell rd richardson tx 75080");
}));
