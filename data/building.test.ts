import assert from "node:assert/strict";
import { test } from "node:test";
import { validate } from "./check.ts";
import { INSPECTION_AS_OF, daysFromIso, generate, isoFromDays } from "./model.ts";

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

test("inspections: full coverage, demo deficiencies, a few overdue", () => {
  const { meta } = generate();
  const by = new Map(meta.inspections.map((r) => [r.id, r]));
  const rated = meta.doors.filter((d) => d.ratingMinutes > 0).length;
  const sprinklered = Object.values(meta.sprinklers).filter((s) => s !== "none").length;
  assert.equal(meta.inspections.length, sprinklered + rated + 2 * meta.floors);
  const s = by.get("sprinkler:7-break")!;
  assert.equal(s.status, "deficient");
  assert.match(s.finding!, /obstructed/);
  assert.ok(s.nextDue < INSPECTION_AS_OF, "7-break inspection overdue");
  const d = by.get("fire-door:7-hall|7-stair-b")!;
  assert.equal(d.status, "deficient");
  assert.match(d.finding!, /propped open/);
  assert.equal(by.get("sprinkler:9-office")!.status, "overdue");
  assert.ok(meta.inspections.filter((r) => r.status === "pass").length > meta.inspections.length * 0.9);
});

test("date helpers round-trip", () => {
  assert.equal(daysFromIso("1970-01-01"), 0);
  assert.equal(isoFromDays(daysFromIso("2024-02-29") + 1), "2024-03-01");
  assert.equal(isoFromDays(daysFromIso(INSPECTION_AS_OF) - 365), "2025-11-07");
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
  bad((g) => (g.meta.inspections[0].target = "nope"), /id should be|unknown room/);
  bad((g) => (g.meta.inspections[0].nextDue = g.meta.inspections[0].lastInspected), /not after/);
  bad((g) => (g.meta.inspections[0].lastInspected = "2026-02-30"), /bad lastInspected/);
  bad((g) => (g.meta.inspections = g.meta.inspections.filter((r) => r.id !== "standpipe:floor-3")), /missing inspection record/);
  bad((g) => (g.meta.inspections.find((r) => r.id === "sprinkler:7-break")!.status = "pass"), /impaired sprinkler 7-break/);
  bad((g) => (g.meta.inspections.find((r) => r.id === "fire-door:7-hall|7-stair-b")!.status = "pass"), /propped-open rated door/);
});
