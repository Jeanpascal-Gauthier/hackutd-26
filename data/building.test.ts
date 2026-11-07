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
