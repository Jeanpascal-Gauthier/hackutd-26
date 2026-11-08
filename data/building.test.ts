import assert from "node:assert/strict";
import { test } from "node:test";
import { validate } from "./check.ts";
import { generate } from "./model.ts";

test("generated building is valid and deterministic", () => {
  const a = generate();
  assert.deepEqual(validate(a.building, a.meta), []);
  assert.equal(JSON.stringify(a), JSON.stringify(generate()));
});

test("shape: 12 floors, demo ids, shafts", () => {
  const { building: b } = generate();
  assert.equal(new Set(b.rooms.map((r) => r.floor)).size, 12);
  const ids = new Set(b.rooms.map((r) => r.id));
  for (const id of ["7-break", "10-east", "1-hall", "12-stair-a", "12-stair-b", "12-elev-1"]) assert.ok(ids.has(id), id);
  assert.deepEqual(b.verticals.map((v) => v.id), ["stair-a", "stair-b", "elev-1"]);
});

test("demo: stair B open path from 7-break, stair A sealed", () => {
  const { building: b } = generate();
  const link = (x: string, y: string) => b.links.find((l) => [l.a, l.b].sort().join() === [x, y].sort().join())!;
  assert.equal(link("7-hall", "7-break").closed, false);
  assert.equal(link("7-hall", "7-stair-b").closed, false);
  assert.equal(link("7-hall", "7-stair-a").closed, true);
  assert.equal(b.verticals.find((v) => v.id === "stair-b")!.doorsClosed, false);
  assert.equal(b.verticals.find((v) => v.id === "stair-a")!.doorsClosed, true);
});

test("validator catches broken data", () => {
  const bad = (mut: (g: ReturnType<typeof generate>) => void, re: RegExp) => {
    const g = generate();
    mut(g);
    assert.ok(validate(g.building, g.meta).some((e) => re.test(e)), String(re));
  };
  bad((g) => g.building.rooms.push({ ...g.building.rooms[0] }), /duplicate room id/);
  bad((g) => g.building.links.push({ a: "1-hall", b: "nope", kind: "door", fireRated: false, closed: false }), /unknown room/);
  bad((g) => (g.building.rooms[1].floor = 13), /out of range/);
  bad((g) => (g.building.rooms[1].w = 0), /must be > 0/);
  bad((g) => (g.meta.occupants[0].count = -1), /invalid occupant count/);
  bad((g) => (g.building.verticals[0].floors = [1, 11]), /expected floors/);
  bad((g) => {
    g.building.links = g.building.links.filter((l) => !(l.a === "6-hall" && l.b === "6-stair-b"));
    g.meta.doors = g.meta.doors.filter((d) => !(d.a === "6-hall" && d.b === "6-stair-b"));
  }, /not linked/);
});

test("demo occupancy: evening, 40 people on floors 8-12, floor 7 occupied", () => {
  const { meta } = generate();
  const floorOf = (room: string) => Number.parseInt(room);
  const on = (lo: number, hi: number) => meta.occupants.filter((o) => floorOf(o.room) >= lo && floorOf(o.room) <= hi);
  const sum = (os: typeof meta.occupants) => os.reduce((n, o) => n + o.count, 0);
  assert.equal(sum(on(8, 12)), 40);
  assert.ok(on(8, 12).some((o) => o.flags.includes("mobility")));
  assert.ok(sum(on(7, 7)) > 0, "fire floor occupied");
  assert.equal(meta.occupants.find((o) => o.room === "7-break")?.count, 3);
  assert.deepEqual(meta.occupants.find((o) => o.room === "10-east")?.flags, ["mobility"]);
  for (let f = 1; f <= 12; f++) assert.ok(sum(on(f, f)) > 0, `floor ${f} has someone (exits need it)`);
  assert.ok(sum(meta.occupants) < 120, "evening: lighter than a workday");
});

test("inspections explain the demo failures", () => {
  const { meta } = generate();
  const find = (system: string, location: string) => meta.inspections.filter((r) => r.system === system && r.location === location);
  assert.ok(meta.inspections.length >= 20 && meta.inspections.length <= 40);
  assert.ok(find("sprinkler", "7-break").some((r) => r.status !== "ok"));
  assert.ok(find("fire-door", "7-stair-b").some((r) => r.status === "failed"));
  assert.ok(find("stair-pressurization", "stair-a").every((r) => r.status === "ok"));
  assert.ok(meta.inspections.filter((r) => r.status === "ok").length > meta.inspections.length / 2, "most systems ok");
});

test("validator catches bad inspection records", () => {
  const bad = (mut: (g: ReturnType<typeof generate>) => void, re: RegExp) => {
    const g = generate();
    mut(g);
    assert.ok(validate(g.building, g.meta).some((e) => re.test(e)), String(re));
  };
  bad((g) => (g.meta.inspections[0].location = "13-hall"), /unknown location/);
  bad((g) => (g.meta.inspections[0].lastInspected = "2026-02-30"), /invalid date/);
  bad((g) => (g.meta.inspections[0].lastInspected = "2026-11-08"), /after 2026-11-07/);
  bad((g) => (g.meta.inspections = g.meta.inspections.filter((r) => r.location !== "7-break")), /impaired sprinkler without/);
  bad((g) => (g.meta.sprinklers["3-east"] = "impaired"), /impaired sprinkler without.*3-east/);
  bad((g) => (g.meta.inspections = g.meta.inspections.filter((r) => r.location !== "7-stair-b")), /rated door open without/);
  bad((g) => (g.meta.inspections[1].id = g.meta.inspections[0].id), /duplicate inspection id/);
});
