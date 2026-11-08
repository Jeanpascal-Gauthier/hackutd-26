import { test } from "node:test";
import assert from "node:assert/strict";
import type { Building, Occupant } from "@firewatch/shared/types";
import { synthesizeBuilding, summarizeCandidate, type SynthesizedBuilding } from "./synthesize.ts";
import { createLocationOnlyRecord } from "./normalize.ts";
import { METRES_PER_DEGREE, pointInRing, type Pt } from "./geometry.ts";
import type { AreaGeometry, BuildingCandidate, BuildingRecord, Position, RoomRecord } from "./types.ts";
import { simulateSpread } from "../simulation/spread.ts";
import { findExits } from "../simulation/exits.ts";
import { locate } from "../live/locate.ts";
import { recommend } from "../live/recommend.ts";
import { DEMO } from "../live/buildingData.ts";

// Fixtures are drawn in metres (x east, y north) around a point in Richardson, TX.
const LAT = 32.99, LON = -96.75;
const KX = METRES_PER_DEGREE * Math.cos((LAT * Math.PI) / 180);
const ring = (pts: [number, number][]): Position[] => {
  const r = pts.map(([x, y]) => [LON + x / KX, LAT + y / METRES_PER_DEGREE] as Position);
  return [...r, r[0]];
};
const polygon = (pts: [number, number][]): AreaGeometry => ({ type: "Polygon", coordinates: [ring(pts)] });
const rect = (x: number, y: number, w: number, h: number): [number, number][] => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const rotated = (pts: [number, number][], a: number): [number, number][] =>
  pts.map(([x, y]) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)]);

const source = { provider: "openstreetmap" as const, id: "osm:way:1", url: null, attribution: "© OpenStreetMap contributors", license: "ODbL-1.0", fetchedAt: "2026-11-08T12:00:00Z", updatedAt: null };
function record(footprint: AreaGeometry | null, extra: Partial<BuildingRecord> = {}): BuildingRecord {
  return {
    id: "osm:way:1", name: null, address: null, location: { lat: LAT, lon: LON }, footprint, heightMeters: null, floorsAboveGround: 6, source,
    floors: [], rooms: [], connections: [], tags: { building: "office" },
    completeness: { footprint: !!footprint, height: false, floorLabels: false, interiors: "none", routeReady: false }, warnings: [],
    ...extra,
  };
}

const FIXTURES: Record<string, BuildingRecord> = {
  rectangle: record(polygon(rotated(rect(0, 0, 30, 20), 0.35))),
  "L-shape": record(polygon([[0, 0], [40, 0], [40, 12], [12, 12], [12, 40], [0, 40]]), { tags: { building: "apartments" }, floorsAboveGround: 5 }),
  tiny: record(polygon(rect(0, 0, 12, 10)), { tags: { building: "house" }, floorsAboveGround: 2 }),
  huge: record(polygon(rect(0, 0, 150, 80)), { tags: { building: "retail" }, floorsAboveGround: 2 }),
  multipolygon: record(
    { type: "MultiPolygon", coordinates: [[ring(rect(100, 0, 10, 8))], [ring(rect(0, 0, 36, 18))]] },
    { tags: { building: "school" }, floorsAboveGround: 3 },
  ),
  "location-only": createLocationOnlyRecord({ lat: LAT, lon: LON }, "2026-11-08T12:00:00Z"),
  "circle (many vertices)": record(polygon(Array.from({ length: 200 }, (_, i) => [25 * Math.cos((2 * Math.PI * i) / 200), 18 * Math.sin((2 * Math.PI * i) / 200)] as [number, number])), { tags: { building: "hospital" } }),
  "hotel by height": record(polygon(rect(0, 0, 50, 16)), { tags: { building: "hotel" }, floorsAboveGround: null, heightMeters: 28 }),
  "unknown, no levels": record(polygon(rect(0, 0, 24, 18)), { tags: { building: "yes" }, floorsAboveGround: null }),
};

const SHAFTS = ["stair-a", "stair-b", "elev-1"];

/** The checks data/check.ts makes on the demo, adapted to generated buildings, plus outline containment. */
function check({ building, sprinklers, doors, inspections = [] }: SynthesizedBuilding): string[] {
  const errs: string[] = [];
  const err = (m: string) => errs.push(m);
  const profile = building.profile;
  if (!profile) return ["missing profile"];
  const floors = profile.floors;
  const rooms = new Map(building.rooms.map((r) => [r.id, r]));
  if (rooms.size !== building.rooms.length) err("duplicate room ids");

  for (const r of building.rooms) {
    if (!/^\d+-[a-z0-9-]+$/.test(r.id) || !r.id.startsWith(`${r.floor}-`)) err(`${r.id}: bad id`);
    if (!r.name.startsWith(`Floor ${r.floor} `)) err(`${r.id}: bad name ${r.name}`);
    if (!r.kind) err(`${r.id}: no kind`);
    if (!Number.isInteger(r.floor) || r.floor < 1 || r.floor > floors) err(`${r.id}: floor out of range`);
    if (!(r.w > 0 && r.d > 0) || ![r.x, r.z].every(Number.isFinite)) err(`${r.id}: bad box`);
  }

  // Links: valid refs, no self/duplicate links, same floor.
  const seen = new Set<string>();
  const adj = new Map<string, string[]>();
  for (const l of building.links) {
    const a = rooms.get(l.a), b = rooms.get(l.b);
    if (!a || !b) err(`link to unknown room: ${l.a} <-> ${l.b}`);
    if (l.a === l.b) err(`self link ${l.a}`);
    const key = [l.a, l.b].sort().join("|");
    if (seen.has(key)) err(`duplicate link ${key}`);
    seen.add(key);
    if (a && b && a.floor !== b.floor) err(`link crosses floors: ${key}`);
    adj.set(l.a, [...(adj.get(l.a) ?? []), l.b]);
    adj.set(l.b, [...(adj.get(l.b) ?? []), l.a]);
  }
  const door = (a: string, b: string) => building.links.find((l) => l.kind === "door" && ((l.a === a && l.b === b) || (l.a === b && l.b === a)));

  // Floors: one hall, both stairwells and the elevator off the hall; every room has a door to the hall.
  for (let f = 1; f <= floors; f++) {
    const hall = `${f}-hall`;
    if (!rooms.has(hall)) err(`floor ${f}: no hall`);
    for (const s of SHAFTS) {
      const d = door(hall, `${f}-${s}`);
      if (!d) err(`floor ${f}: ${s} not linked to the hall`);
      else if (!d.fireRated || !d.closed) err(`floor ${f}: ${s} door should be rated and closed`);
    }
    const ordinary = building.rooms.filter((r) => r.floor === f && r.id !== hall && !SHAFTS.some((s) => r.id === `${f}-${s}`));
    if (ordinary.length < 1 || ordinary.length > 10) err(`floor ${f}: ${ordinary.length} rooms`);
    for (const r of ordinary) if (!door(hall, r.id)) err(`${r.id}: no door to the hall`);
    // No two rooms on a floor overlap.
    const all = building.rooms.filter((r) => r.floor === f);
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i], b = all[j];
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), oz = Math.min(a.z + a.d, b.z + b.d) - Math.max(a.z, b.z);
        if (ox > 0.01 && oz > 0.01) err(`${a.id} overlaps ${b.id}`);
      }
  }

  // Verticals span every floor.
  assert.deepEqual(building.verticals.map((v) => v.id), SHAFTS);
  for (const v of building.verticals) {
    if (v.floors[0] !== 1 || v.floors[1] !== floors) err(`${v.id}: floors ${v.floors}`);
    if (v.kind !== (v.id === "elev-1" ? "elevator" : "stair")) err(`${v.id}: kind ${v.kind}`);
    // The stairs differ: stair B has a door propped open (on the fire floor); stair A and the elevator don't.
    if (v.doorsClosed !== (v.id !== "stair-b")) err(`${v.id}: doorsClosed ${v.doorsClosed}`);
  }

  // Whole-building connectivity through the shafts.
  const reach = new Set<string>();
  const queue = ["1-hall"];
  while (queue.length) {
    const cur = queue.pop()!;
    if (reach.has(cur)) continue;
    reach.add(cur);
    queue.push(...(adj.get(cur) ?? []));
    const r = rooms.get(cur)!;
    const v = building.verticals.find((x) => cur === `${r.floor}-${x.id}`);
    if (v) for (let f = v.floors[0]; f <= v.floors[1]; f++) queue.push(`${f}-${v.id}`);
  }
  for (const r of building.rooms) if (!reach.has(r.id)) err(`unreachable ${r.id}`);

  // Doors list matches the door links; sprinklers cover every room.
  const doorLinks = building.links.filter((l) => l.kind === "door");
  if (doors.length !== doorLinks.length) err(`doors ${doors.length} != door links ${doorLinks.length}`);
  for (const d of doors) {
    const l = door(d.a, d.b);
    if (!l) err(`door without link ${d.a}|${d.b}`);
    else if (l.fireRated !== d.ratingMinutes > 0) err(`door ${d.a}|${d.b}: rating mismatch`);
  }
  // Inspections: exactly one deficient record per floor, for the hall <-> stair B door.
  const ids = inspections.map((r) => r.id);
  const want = Array.from({ length: floors }, (_, i) => `fire-door:${i + 1}-hall|${i + 1}-stair-b`);
  if (JSON.stringify(ids) !== JSON.stringify(want)) err(`inspections ${ids.join(", ")}`);
  for (const r of inspections) {
    const d = doors.find((x) => `${x.a}|${x.b}` === r.target);
    if (!d || d.ratingMinutes !== 60) err(`${r.id}: target is not a 60-min door`);
    if (r.id !== `${r.system}:${r.target}` || r.system !== "fire-door" || r.status !== "deficient") err(`${r.id}: bad record`);
    if (!r.finding?.includes("propped open")) err(`${r.id}: finding ${r.finding}`);
  }
  for (const r of building.rooms) if (sprinklers[r.id] !== "none") err(`${r.id}: sprinkler ${sprinklers[r.id]}`);
  if (Object.keys(sprinklers).length !== building.rooms.length) err("sprinklers for unknown rooms");

  // Outline: open ring, at most 64 points, rooms inside it.
  const outline = profile.outline ?? [];
  if (outline.length < 3 || outline.length > 64) err(`outline has ${outline.length} points`);
  const [first, last] = [outline[0], outline[outline.length - 1]];
  if (first && last && first[0] === last[0] && first[1] === last[1]) err("outline repeats its first point");
  if (!profile.assumptions.some((a) => a.includes("extend past"))) {
    const m = 0.05; // rounding tolerance
    for (const r of building.rooms) {
      const probes: Pt[] = [[r.x + m, r.z + m], [r.x + r.w - m, r.z + m], [r.x + r.w - m, r.z + r.d - m], [r.x + m, r.z + r.d - m], [r.x + r.w / 2, r.z + r.d / 2]];
      if (!probes.every((p) => pointInRing(p, outline))) err(`${r.id} is outside the outline`);
    }
  }
  return errs;
}

for (const [name, rec] of Object.entries(FIXTURES)) {
  test(`${name}: valid generated building`, () => {
    const out = synthesizeBuilding(rec);
    assert.deepEqual(check(out), []);
    const p = out.building.profile!;
    assert.equal(p.layoutEstimated, true);
    assert.equal(p.source, "osm");
    assert.equal(p.id, rec.id);
    assert.ok(p.assumptions.includes("No sprinkler records for this building; the forecast assumes no working sprinklers."));
  });
}

test("deterministic: same input, same output", () => {
  for (const rec of Object.values(FIXTURES)) assert.deepEqual(synthesizeBuilding(rec), synthesizeBuilding(structuredClone(rec)));
});

test("demo frame and conventions: hall at the origin, stair A west, stair B east, elevator off the hall", () => {
  const { building } = synthesizeBuilding(FIXTURES.rectangle);
  const r = (id: string) => building.rooms.find((x) => x.id === id)!;
  assert.deepEqual([r("3-hall").x, r("3-hall").z, r("3-hall").d], [0, 0, 3]);
  assert.equal(r("3-stair-a").x + r("3-stair-a").w, 0);
  assert.equal(r("3-stair-b").x, r("3-hall").w);
  assert.equal(r("3-hall").name, "Floor 3 Hallway");
  assert.equal(r("3-stair-a").name, "Floor 3 Stairwell A");
  assert.equal(r("3-elev-1").name, "Floor 3 Elevator");
  assert.ok(r("3-elev-1").z + r("3-elev-1").d === 0 || r("3-elev-1").z === 3);
  // A rectangle gets a double-loaded corridor with 4-8 rooms a floor and a lobby on floor 1.
  const ordinary = building.rooms.filter((x) => x.floor === 3 && !["hall", "stair", "elevator"].includes(x.kind!));
  assert.ok(ordinary.length >= 4 && ordinary.length <= 8, `${ordinary.length} rooms`);
  assert.ok(ordinary.some((x) => x.z < 0) && ordinary.some((x) => x.z >= 3), "rooms on both sides");
  assert.ok(building.rooms.some((x) => x.id === "1-lobby" && x.kind === "lobby"));
  // Break room door open and ordinary; other rooms rated and closed; neighbours share walls.
  const link = (b: string) => building.links.find((l) => l.a === "3-hall" && l.b === b)!;
  assert.deepEqual([link("3-break").fireRated, link("3-break").closed], [false, false]);
  assert.deepEqual([link("3-conf").fireRated, link("3-conf").closed], [true, true]);
  assert.ok(building.links.some((l) => l.kind === "wall" && l.a.startsWith("3-")));
});

test("profile: name, address, attribution, time zone, use", () => {
  const p = synthesizeBuilding(FIXTURES.rectangle, { address: "800 W Campbell Rd, Richardson, TX", timezone: "America/Chicago" }).building.profile!;
  assert.equal(p.name, "800 W Campbell Rd, Richardson, TX");
  assert.equal(p.address, "800 W Campbell Rd, Richardson, TX");
  assert.equal(p.timezone, "America/Chicago");
  assert.equal(p.attribution, "© OpenStreetMap contributors (ODbL)");
  assert.equal(p.use, "office");
  assert.deepEqual(p.location, { lat: LAT, lon: LON });
  const named = synthesizeBuilding(record(polygon(rect(0, 0, 30, 20)), { name: "ECSW", address: "800 W Campbell Rd" })).building.profile!;
  assert.equal(named.name, "ECSW");
  const anon = synthesizeBuilding(FIXTURES["location-only"]).building.profile!;
  assert.equal(anon.name, `Building at ${LAT.toFixed(5)}, ${LON.toFixed(5)}`);
  assert.equal(anon.address, undefined);
  assert.ok(anon.assumptions.some((a) => a.includes("30 m × 20 m")));
});

test("floors: levels, else height / 3.5, else a default by use; no upper generation cap", () => {
  const floors = (extra: Partial<BuildingRecord>) => synthesizeBuilding(record(polygon(rect(0, 0, 30, 20)), extra)).building.profile!;
  assert.equal(floors({ floorsAboveGround: 7, heightMeters: 99 }).floors, 7);
  const byHeight = floors({ floorsAboveGround: null, heightMeters: 21 });
  assert.equal(byHeight.floors, 6);
  assert.ok(byHeight.assumptions.some((a) => a.includes("21 m")));
  const none = floors({ floorsAboveGround: null, tags: { building: "school" } });
  assert.equal(none.floors, 2);
  assert.ok(none.assumptions.some((a) => a.includes("no floor count or height")));
  assert.equal(floors({ floorsAboveGround: 120 }).floors, 120);
  assert.equal(floors({ floorsAboveGround: null, heightMeters: 828 }).floors, Math.round(828 / 3.5));
  assert.equal(floors({ floorsAboveGround: null, heightMeters: 1 }).floors, 1);
  assert.equal(floors({ floorsAboveGround: Infinity, heightMeters: 21 }).floors, 6);
  assert.equal(floors({ floorsAboveGround: null, heightMeters: Infinity }).floors, 4);
});

test("163-floor tower: top-floor rooms, shafts, report location and forecast remain usable", () => {
  const generated = synthesizeBuilding(record(polygon(rect(0, 0, 30, 20)), { floorsAboveGround: 163, heightMeters: 828 }));
  assert.deepEqual(check(generated), []);
  const { building } = generated;
  assert.equal(building.profile!.floors, 163);
  assert.equal(new Set(building.rooms.map(r => r.floor)).size, 163);
  assert.ok(building.rooms.some(r => r.id === "163-hall"));
  assert.ok(building.verticals.every(v => v.floors[1] === 163));
  assert.equal(building.profile!.assumptions.some(a => a.includes("capped")), false);
  assert.equal(locate("fire in the hallway on floor 163", building).roomId, "163-hall");
  const snapshots = simulateSpread(building, "163-hall", 2);
  assert.ok(snapshots[2].rooms.some(r => r.roomId === "163-hall" && r.fire > 0));
  const exits = findExits(building, snapshots, [{ room: "163-office", count: 2, flags: [] }]);
  assert.equal(exits[0].floor, 163);
  assert.ok(exits[0].route?.includes("163-stair-a"));
  assert.ok(exits[0].route?.includes("1-stair-a"));
});

test("use: OSM tags pick room kinds and names", () => {
  const rooms = (tags: Record<string, string>, floor = 2) =>
    synthesizeBuilding(record(polygon(rect(0, 0, 40, 20)), { tags, floorsAboveGround: 3 })).building.rooms.filter((r) => r.floor === floor);
  assert.ok(rooms({ building: "apartments" }).some((r) => r.name === "Floor 2 Apartment 2B" && r.kind === "residential"));
  assert.ok(rooms({ building: "school" }).some((r) => r.kind === "classroom" && /^Floor 2 Classroom 2\d\d$/.test(r.name)));
  assert.ok(rooms({ building: "yes", amenity: "hospital" }).some((r) => r.kind === "patient"));
  assert.ok(rooms({ building: "hotel" }).some((r) => r.kind === "hotel-room" && r.name.startsWith("Floor 2 Room 2")));
  assert.ok(rooms({ building: "retail" }, 1).every((r) => !["office", "open-office"].includes(r.kind!)));
  assert.ok(rooms({ building: "retail" }, 1).some((r) => r.kind === "retail"));
  assert.ok(rooms({ building: "university" }).some((r) => r.kind === "lab"));
  const mixed = synthesizeBuilding(record(polygon(rect(0, 0, 40, 20)), { tags: { building: "apartments", shop: "bakery" }, floorsAboveGround: 3 })).building;
  assert.equal(mixed.profile!.use, "mixed");
  assert.ok(mixed.rooms.some((r) => r.floor === 1 && r.kind === "retail"));
  assert.ok(mixed.rooms.some((r) => r.floor === 2 && r.kind === "residential"));
  const unknown = synthesizeBuilding(FIXTURES["unknown, no levels"]).building.profile!;
  assert.equal(unknown.use, "office");
  assert.ok(unknown.assumptions.some((a) => a.includes("does not say what the building is used for")));
  assert.equal(synthesizeBuilding(FIXTURES.tiny).building.profile!.use, "residential");
});

test("tiny footprint: hall, two stairs, an elevator and 1-3 rooms", () => {
  const { building } = synthesizeBuilding(FIXTURES.tiny);
  for (let f = 1; f <= 2; f++) {
    const ordinary = building.rooms.filter((r) => r.floor === f && !["hall", "stair", "elevator"].includes(r.kind!));
    assert.ok(ordinary.length >= 1 && ordinary.length <= 3, `floor ${f}: ${ordinary.length}`);
  }
});

test("huge footprint: at most 10 rooms a floor, made larger", () => {
  const { building } = synthesizeBuilding(FIXTURES.huge);
  const ordinary = building.rooms.filter((r) => r.floor === 2 && !["hall", "stair", "elevator"].includes(r.kind!));
  assert.ok(ordinary.length >= 6 && ordinary.length <= 10, `${ordinary.length}`);
  assert.ok(ordinary.every((r) => r.w * r.d > 200));
});

test("MultiPolygon: only the largest part is modelled", () => {
  const p = synthesizeBuilding(FIXTURES.multipolygon).building.profile!;
  const xs = p.outline!.map(([x]) => x), zs = p.outline!.map(([, z]) => z);
  assert.ok(Math.abs(Math.max(...xs) - Math.min(...xs) - 36) < 0.1);
  assert.ok(Math.abs(Math.max(...zs) - Math.min(...zs) - 18) < 0.1);
  assert.ok(p.assumptions.some((a) => a.includes("2 separate parts")));
});

test("long side of the footprint lies along x, whatever the map rotation", () => {
  for (const a of [0, 0.35, 1.2, -0.8, Math.PI / 2]) {
    const p = synthesizeBuilding(record(polygon(rotated(rect(0, 0, 40, 15), a)))).building.profile!;
    const xs = p.outline!.map(([x]) => x), zs = p.outline!.map(([, z]) => z);
    assert.ok(Math.abs(Math.max(...xs) - Math.min(...xs) - 40) < 0.1, `angle ${a}`);
    assert.ok(Math.abs(Math.max(...zs) - Math.min(...zs) - 15) < 0.1, `angle ${a}`);
  }
});

test("mapped OSM room names replace generated names on the matching floor", () => {
  const box = (x: number, y: number): AreaGeometry => polygon(rect(x, y, 4, 4));
  const room = (id: string, level: string, name: string | null, purpose: string | null, geometry: AreaGeometry | null): RoomRecord => ({
    id, name, number: null, kind: "room", purpose, sourceLevels: [level], floorIds: [], geometry, tags: {}, source,
  });
  const rec = record(polygon(rect(0, 0, 30, 20)), {
    rooms: [room("osm:way:2", "2", "Coffee Room", "kitchen", box(1, 1)), room("osm:way:3", "-1", "Boiler", null, null), room("osm:way:4", "1", null, "conference", null)],
  });
  const { building } = synthesizeBuilding(rec);
  const coffee = building.rooms.find((r) => r.name === "Floor 3 Coffee Room");
  assert.ok(coffee, "level 2 is floor 3");
  assert.equal(coffee.kind, "break");
  assert.ok(building.rooms.some((r) => r.floor === 2 && r.name === "Floor 2 Conference" && r.kind === "conference"));
  assert.ok(!building.rooms.some((r) => r.name.includes("Boiler")), "basement levels are skipped");
  assert.ok(building.profile!.assumptions.some((a) => a.includes("from the map")));
  assert.deepEqual(check(synthesizeBuilding(rec)), []);
});

test("spread model and exit finder run on a synthesized 6-floor building", () => {
  const { building, sprinklers } = synthesizeBuilding(FIXTURES.rectangle);
  assert.equal(building.profile!.floors, 6);
  const sprinklerRooms = Object.entries(sprinklers).filter(([, s]) => s === "active").map(([id]) => id);
  const snaps = simulateSpread(building, "2-break", 30, { sprinklerRooms });
  assert.equal(snaps.length, 31);
  const final = snaps[30].rooms;
  const floorOf = new Map(building.rooms.map((r) => [r.id, r.floor]));
  const upper = final.filter((r) => floorOf.get(r.roomId)! >= 3);
  assert.ok(upper.some((r) => r.smoke > 0.01), `max upper smoke ${Math.max(...upper.map((r) => r.smoke))}`);
  assert.ok(final.find((r) => r.roomId === "2-break")!.fire > 0.5);

  const occupants: Occupant[] = building.rooms
    .filter((r) => !["hall", "stair", "elevator"].includes(r.kind!))
    .map((r) => ({ room: r.id, count: 2, flags: [], estimated: true }));
  const exits = findExits(building, snaps, occupants);
  assert.deepEqual(exits.map((e) => e.floor), [1, 2, 3, 4, 5, 6]);
  for (const e of exits) {
    assert.ok(e.stair === "stair-a" || e.stair === "stair-b", `floor ${e.floor}: ${e.stair}`);
    assert.deepEqual(Object.keys(e.blockedAt).sort(), ["stair-a", "stair-b"]);
    assert.equal(e.route![0], `${e.floor}-hall`);
    assert.equal(e.route!.at(-1), `1-${e.stair}`);
  }
  const rec = recommend(exits, "2-break", building);
  assert.ok(rec.actions.some((a) => a.includes("floor 2 (Break Room)")));
});

test("stairwells differ like the demo's: stair B's door is propped open, stair A's are closed", () => {
  const demoDoor = DEMO.inspections.find((r) => r.id === "fire-door:7-hall|7-stair-b")!;
  for (const [name, rec] of Object.entries({ ...FIXTURES, "1 floor": record(polygon(rect(0, 0, 30, 20)), { floorsAboveGround: 1 }) })) {
    const { building, inspections = [] } = synthesizeBuilding(rec);
    const v = (id: string) => building.verticals.find((x) => x.id === id)!;
    assert.deepEqual([v("stair-a").doorsClosed, v("stair-b").doorsClosed, v("elev-1").doorsClosed], [true, false, true], name);
    // Explains why, in plain words on the console, like the demo's notes.
    assert.ok(building.profile!.assumptions.some((a) => a.includes("Stairwell B") && a.includes("propped open on the fire floor")), name);
    // Same record shape (and system/status) as the demo's "fire-door:7-hall|7-stair-b".
    assert.equal(inspections.length, building.profile!.floors, name);
    for (const r of inspections) {
      assert.deepEqual(Object.keys(r).sort(), Object.keys(demoDoor).sort(), name);
      assert.deepEqual([r.system, r.status], [demoDoor.system, demoDoor.status]);
      assert.equal(r.lastInspected, "2026-11-08", "dated as of the map lookup, no clock read");
    }
  }
});

/** Every ordinary room holds 2 people. */
const everyone = (building: Building): Occupant[] =>
  building.rooms.filter((r) => !["hall", "stair", "elevator"].includes(r.kind!)).map((r) => ({ room: r.id, count: 2, flags: [], estimated: true }));

test("forecast on a synthesized building: the propped stair B smoke-logs from the fire floor up, stair A stays clear", () => {
  const cases: [string, BuildingRecord, number[]][] = [
    ["6 floors", FIXTURES.rectangle, [1, 3, 6]],
    ["12 floors", record(polygon(rect(0, 0, 30, 20)), { floorsAboveGround: 12 }), [2, 7, 12]],
    ["location-only (4 floors)", FIXTURES["location-only"], [2]],
    ["2 floors (retail)", FIXTURES.huge, [1, 2]],
    ["1 floor", record(polygon(rect(0, 0, 30, 20)), { floorsAboveGround: 1 }), [1]],
  ];
  for (const [name, rec, fireFloors] of cases) {
    const { building } = synthesizeBuilding(rec);
    const top = building.profile!.floors;
    for (const fire of fireFloors) {
      // A fire in a room whose door stands open (break room, lobby, shop), so smoke fills the hall.
      const origin = building.links.find((l) => l.a === `${fire}-hall` && l.kind === "door" && !l.closed)!.b;
      const snaps = simulateSpread(building, origin, 30, { sprinklerRooms: [] });
      assert.deepEqual(snaps, simulateSpread(building, origin, 30, { sprinklerRooms: [] }), "deterministic");
      const exits = findExits(building, snaps, everyone(building));
      for (let f = fire; f <= top; f++) {
        const e = exits.find((x) => x.floor === f)!;
        const at = `${name}, fire on ${fire}, floor ${f}`;
        assert.equal(e.stair, "stair-a", at);
        assert.ok(e.blockedAt["stair-b"] !== null, `${at}: stair B smoke-logged`);
        // Closed doors still leak and smoke pools at the top of a shaft, so near the top of a short
        // building (or a 1-floor one) stair A can fill late in the 30 minutes: never within 5 minutes of stair B.
        const a = e.blockedAt["stair-a"];
        assert.ok(a === null || a >= e.blockedAt["stair-b"]! + 5, `${at}: stair A ${a}, B ${e.blockedAt["stair-b"]}`);
        assert.ok(e.route!.every((id) => !id.includes("stair-b")), at);
      }
      // The demo's picture in a tall building: stair A clear for 30 minutes on every floor below the top.
      if (top === 12) for (let f = 1; f < top; f++) assert.equal(exits.find((x) => x.floor === f)!.blockedAt["stair-a"], null, `fire on ${fire}, floor ${f}`);
      const reply = recommend(exits, origin, building).callerReply!;
      assert.match(reply, /by Stairwell A/, `${name}, fire on ${fire}: ${reply}`);
      assert.match(reply, /do not use Stairwell B/i, `${name}, fire on ${fire}: ${reply}`);
    }
  }
});

test("forecast: wherever the fire is (closed rooms too), stair A is picked and never fills before stair B", () => {
  for (const rec of [FIXTURES.rectangle, FIXTURES.tiny]) {
    const { building } = synthesizeBuilding(rec);
    for (const origin of building.rooms.filter((r) => !["hall", "stair", "elevator"].includes(r.kind!))) {
      const exits = findExits(building, simulateSpread(building, origin.id, 30), everyone(building));
      for (const e of exits.filter((x) => x.floor >= origin.floor)) {
        const [a, b] = [e.blockedAt["stair-a"] ?? Infinity, e.blockedAt["stair-b"] ?? Infinity];
        assert.equal(e.stair, "stair-a", `${origin.id}, floor ${e.floor}`);
        assert.ok(a >= b, `${origin.id}, floor ${e.floor}: A ${a}, B ${b}`);
      }
    }
  }
});

test("the propped door is only assumed when no stair B door is recorded open", () => {
  const { building } = synthesizeBuilding(FIXTURES.rectangle);
  // Record stair B's floor-5 door as the open one: the fire on floor 3 no longer opens floor 3's.
  const recorded = structuredClone(building);
  recorded.links.find((l) => l.a === "5-hall" && l.b === "5-stair-b")!.closed = false;
  const blockedB = (b: Building) => findExits(b, simulateSpread(b, "3-break", 30), everyone(b)).find((e) => e.floor === 3)!.blockedAt["stair-b"];
  assert.notEqual(blockedB(building), null);
  assert.equal(blockedB(recorded), null);
  // All of stair B's doors closed (doorsClosed=true): both stairs behave the same again.
  const shut = structuredClone(building);
  shut.verticals.find((v) => v.id === "stair-b")!.doorsClosed = true;
  const e = findExits(shut, simulateSpread(shut, "3-break", 30), everyone(shut)).find((x) => x.floor === 3)!;
  assert.deepEqual(e.blockedAt, { "stair-a": null, "stair-b": null });
});

test("rule-based locator finds rooms in a synthesized office", () => {
  const { building } = synthesizeBuilding(FIXTURES.rectangle);
  assert.deepEqual(locate("smoke in the break room on the 3rd floor", building), { roomId: "3-break", confidence: 0.8, floor: 3 });
  assert.equal(locate("fire in the conference room, floor 5", building).roomId, "5-conf");
  assert.equal(locate("I'm in stairwell B on the 4th floor", building).roomId, "4-stair-b");
});

const candidate = (footprint: AreaGeometry | null, extra: Partial<BuildingCandidate> = {}): BuildingCandidate => ({
  id: "osm:way:9", name: "Hall", address: "1 Main St", location: { lat: LAT, lon: LON }, footprint, heightMeters: 12, floorsAboveGround: 3, source, ...extra,
});

test("summarizeCandidate: metres east/south of the origin, distance 0 inside", () => {
  const origin = { lat: LAT, lon: LON };
  const s = summarizeCandidate(candidate(polygon(rect(-10, -5, 20, 10))), origin);
  assert.equal(s.distanceMeters, 0);
  assert.deepEqual([s.id, s.name, s.address, s.floors, s.heightMeters, s.use], ["osm:way:9", "Hall", "1 Main St", 3, 12, null]);
  assert.equal(s.outline.length, 4);
  const xs = s.outline.map(([x]) => x), zs = s.outline.map(([, z]) => z);
  assert.deepEqual([Math.min(...xs), Math.max(...xs)], [-10, 10]);
  // y north 5 -> z south -5.
  assert.deepEqual([Math.min(...zs), Math.max(...zs)], [-5, 5]);

  // A building 30 m east of the point (west wall at x = 30), mapped north of it.
  const far = summarizeCandidate(candidate(polygon(rect(30, 10, 10, 10))), origin);
  assert.equal(far.distanceMeters, Math.round(Math.hypot(30, 10) * 10) / 10);
  assert.ok(far.outline.every(([x, z]) => x >= 29.9 && z <= -9.9));

  // Largest polygon of a MultiPolygon; distance to the nearest of all parts.
  const multi = summarizeCandidate(candidate({ type: "MultiPolygon", coordinates: [[ring(rect(5, -1, 2, 2))], [ring(rect(50, 0, 30, 20))]] }), origin);
  assert.equal(multi.distanceMeters, 5);
  assert.ok(multi.outline.every(([x]) => x >= 49.9));

  // Many vertices are simplified to <= 64; tags (full records) give `use`.
  const circle = polygon(Array.from({ length: 300 }, (_, i) => [20 * Math.cos((2 * Math.PI * i) / 300), 20 * Math.sin((2 * Math.PI * i) / 300)] as [number, number]));
  const withTags = { ...candidate(circle), tags: { building: "apartments" } } as BuildingCandidate;
  const c = summarizeCandidate(withTags, origin);
  assert.ok(c.outline.length <= 64 && c.outline.length >= 8);
  assert.equal(c.use, "apartments");
  const none = summarizeCandidate(candidate(null, { location: { lat: LAT + 10 / METRES_PER_DEGREE, lon: LON } }), origin);
  assert.deepEqual(none.outline, []);
  assert.equal(none.distanceMeters, 10);
});

