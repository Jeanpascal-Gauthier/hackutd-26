import { test } from "node:test";
import assert from "node:assert/strict";
import { DEMO } from "./buildingData.ts";
const { building, doors, inspections, sprinklers } = DEMO;
import { filterInspections } from "../transport/http.ts";

test("inspection records load from data/out and cover the building", () => {
  assert.ok(inspections.length > 100, `got ${inspections.length}`);
  const roomIds = new Set(building.rooms.map((r) => r.id));
  const doorIds = new Set(doors.map((d) => `${d.a}|${d.b}`));
  for (const r of inspections) {
    if (r.system === "sprinkler") assert.ok(roomIds.has(r.target) && sprinklers[r.target] !== "none", r.id);
    else if (r.system === "fire-door") assert.ok(doorIds.has(r.target), r.id);
    else assert.match(r.target, /^floor-\d+$/, r.id);
    assert.ok(r.nextDue > r.lastInspected, r.id);
  }
  assert.ok(doors.some((d) => d.a === "7-hall" && d.b === "7-stair-b" && d.ratingMinutes === 60));
});

test("the demo deficiencies are in the records", () => {
  const by = new Map(inspections.map((r) => [r.id, r]));
  const sprinkler = by.get("sprinkler:7-break");
  assert.equal(sprinkler?.status, "deficient");
  assert.match(sprinkler!.finding!, /obstructed/i);
  assert.ok(sprinkler!.nextDue < "2026-11-07", "7-break inspection is overdue");
  const door = by.get("fire-door:7-hall|7-stair-b");
  assert.equal(door?.status, "deficient");
  assert.match(door!.finding!, /propped open/i);
});

test("GET /inspections filter", () => {
  const q = (s: string) => filterInspections(inspections, new URLSearchParams(s));
  const floor7 = q("floor=7");
  assert.ok(floor7.ok && floor7.inspections.length > 0 && floor7.inspections.every((r) => r.floor === 7));
  const bad7 = q("floor=7&status=deficient");
  assert.ok(bad7.ok);
  assert.deepEqual(bad7.inspections.map((r) => r.id).sort(), ["fire-door:7-hall|7-stair-b", "sprinkler:7-break"]);
  const all = q("");
  assert.ok(all.ok && all.inspections.length === inspections.length);
  assert.equal(q("floor=99").ok, false);
  assert.equal(q("status=fine").ok, false);
  assert.equal(q("system=hose").ok, false);
});
