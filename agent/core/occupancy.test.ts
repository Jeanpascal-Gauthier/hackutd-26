// No network: the occupancy estimator (room kind x building use x local time).
//   npm test -w agent
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Building } from "@firewatch/shared/types";
import sharedBuilding from "@firewatch/shared/building.json" with { type: "json" };
import { syntheticBuilding } from "../fixtures/synthetic.ts";
import { estimateOccupancy } from "./occupancy.ts";
import { inferKind } from "./rooms.ts";

const demo = sharedBuilding as Building;

// America/Chicago is UTC-6 in November 2026 (after DST ends on Nov 1).
const WED_2PM = Date.parse("2026-11-04T20:00:00Z");
const WED_10AM = Date.parse("2026-11-04T16:00:00Z");
const SAT_10AM = Date.parse("2026-11-07T16:00:00Z");
const SUN_2AM = Date.parse("2026-11-08T08:00:00Z");

const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

test("office: weekday 2 PM is busy, Sunday 2 AM nearly empty, with local time and basis", () => {
  const b = syntheticBuilding({ use: "office", floors: 4 });
  const day = estimateOccupancy(b, WED_2PM);
  const night = estimateOccupancy(b, SUN_2AM);
  assert.equal(day.localTime, "Wed 2:00 PM");
  assert.equal(night.localTime, "Sun 2:00 AM");
  // Per floor: 2 offices of 100 m² (10 each) + 140 m² open office (20) = 40 at full; 80% -> 32.
  assert.equal(day.total, 128);
  assert.deepEqual(day.byFloor, { "1": 32, "2": 32, "3": 32, "4": 32 });
  assert.ok(night.total > 0 && night.total <= 6, `night total ${night.total}`);
  assert.match(day.basis[0]!, /^Office building, Wednesday 2:00 PM local time: offices at about 80% of capacity\.$/);
  assert.match(night.basis[0]!, /^Office building, Sunday 2:00 AM local time: offices at about 3% of capacity\.$/);
  assert.ok(day.basis.length >= 2 && day.basis.length <= 4);
  assert.match(day.basis[1]!, /about 160 people when full .*offices 1 per 10 m²/);
  for (const o of day.occupants) {
    assert.equal(o.estimated, true);
    assert.deepEqual(o.flags, []);
  }
});

test("residential at night: most people home, flagged sleeping; daytime fewer and awake", () => {
  const b = syntheticBuilding({
    use: "apartments",
    floors: 3,
    rooms: [
      ["apt-a", "Apartment A", "residential", 10, 8],
      ["apt-b", "Apartment B", "residential", 10, 8],
      ["lobby", "Lobby", "lobby", 10, 8],
    ],
  });
  const night = estimateOccupancy(b, SUN_2AM);
  const day = estimateOccupancy(b, WED_2PM);
  // 6 apartments x 2.4 x 0.9 = 12.96 -> 13; lobbies are closed at night.
  assert.equal(night.total, 13);
  assert.ok(night.occupants.every((o) => o.flags.includes("sleeping")));
  assert.ok(!night.occupants.some((o) => o.room.endsWith("-lobby")));
  assert.ok(day.total < night.total);
  assert.ok(day.occupants.every((o) => !o.flags.includes("sleeping")));
  assert.match(night.basis[0]!, /^Residential building, Sunday 2:00 AM local time: homes at about 90% of capacity/);
  assert.ok(night.basis.some((l) => /13 flagged sleeping/.test(l)));
});

test("school: classrooms full on a weekday morning (flagged child), empty on Saturday", () => {
  const b = syntheticBuilding({
    use: "school",
    floors: 2,
    rooms: [
      ["class-1", "Classroom 1", "classroom", 8, 7],
      ["class-2", "Classroom 2", "classroom", 8, 7],
    ],
  });
  const weekday = estimateOccupancy(b, WED_10AM);
  // 4 classrooms x 56 m² / 2 = 112 at full; 90% -> 100.8 -> 101.
  assert.equal(weekday.total, 101);
  assert.ok(weekday.occupants.every((o) => o.flags.includes("child")));
  assert.equal(estimateOccupancy(b, SAT_10AM).total, 0);
  assert.deepEqual(estimateOccupancy(b, SAT_10AM).occupants, []);
});

test("university classrooms are not flagged child", () => {
  const b = syntheticBuilding({ use: "university", rooms: [["class-1", "Lecture Hall", "classroom", 10, 10]] });
  const e = estimateOccupancy(b, WED_10AM);
  assert.ok(e.total > 0);
  assert.ok(e.occupants.every((o) => !o.flags.includes("child")));
});

test("hospital: patient rooms occupied around the clock, flagged mobility", () => {
  const b = syntheticBuilding({
    use: "hospital",
    floors: 2,
    rooms: [
      ["pt-1", "Patient Room 1", "patient", 5, 5],
      ["pt-2", "Patient Room 2", "patient", 5, 5],
    ],
  });
  for (const at of [WED_2PM, SUN_2AM]) {
    const e = estimateOccupancy(b, at);
    // 4 rooms x 1.5 x 0.85 = 5.1 -> 5
    assert.equal(e.total, 5);
    assert.ok(e.occupants.every((o) => o.flags.includes("mobility")));
    assert.ok(e.basis.some((l) => /5 in patient rooms flagged mobility/.test(l)));
  }
});

test("demo building: kinds read from ids and names; nobody in halls, stairs, elevators or storage", () => {
  const kinds = Object.fromEntries(demo.rooms.filter((r) => r.floor === 8).map((r) => [r.id, inferKind(r)]));
  assert.deepEqual(kinds, {
    "8-hall": "hall",
    "8-break": "break",
    "8-east": "office",
    "8-west": "office",
    "8-office": "open-office",
    "8-conf": "conference",
    "8-storage": "storage",
    "8-stair-a": "stair",
    "8-stair-b": "stair",
    "8-elev-1": "elevator",
  });
  const e = estimateOccupancy(demo, WED_2PM);
  assert.ok(e.total > 100);
  assert.ok(e.occupants.every((o) => !/-(hall|stair-[ab]|elev-1|storage)$/.test(o.room)), "no circulation or storage rooms");
  assert.ok(e.basis.some((l) => /read from room names/.test(l)));
  // No profile: the server's time zone, said so.
  assert.match(e.basis[0]!, /^Office building, .* server time \(.*; the building's time zone is unknown\)/);
});

test("integers only; zero-count and zero-capacity rooms are left out; totals add up", () => {
  const b = syntheticBuilding({
    rooms: [
      ["office-1", "Office 1", "office", 10, 10],
      ["store", "Storage", "storage", 10, 10],
      ["mech", "Mechanical", "utility", 10, 10],
    ],
  });
  for (const at of [WED_2PM, SUN_2AM]) {
    const e = estimateOccupancy(b, at);
    assert.ok(e.occupants.every((o) => Number.isInteger(o.count) && o.count > 0));
    assert.ok(e.occupants.every((o) => o.room.endsWith("-office-1")));
    assert.equal(e.total, sum(e.occupants.map((o) => o.count)));
    assert.equal(e.total, sum(Object.values(e.byFloor)));
    assert.deepEqual(Object.keys(e.byFloor), ["1", "2", "3", "4"]);
  }
});

test("deterministic: same building and time -> same estimate", () => {
  const b = syntheticBuilding({ use: "mixed" });
  assert.deepEqual(estimateOccupancy(b, WED_2PM), estimateOccupancy(b, WED_2PM));
  assert.deepEqual(estimateOccupancy(demo, SUN_2AM), estimateOccupancy(demo, SUN_2AM));
});

test("a bad time zone falls back to the server's; an unknown use counts as offices", () => {
  const e = estimateOccupancy(syntheticBuilding({ timezone: "Not/AZone", use: "yes" }), WED_2PM);
  assert.match(e.basis[0]!, /^Building of unknown use \("yes", counted as offices\), .* server time/);
  assert.ok(e.total > 0);
});

test("an empty building gives an empty estimate", () => {
  const e = estimateOccupancy({ rooms: [], links: [], verticals: [] }, WED_2PM);
  assert.equal(e.total, 0);
  assert.deepEqual(e.occupants, []);
  assert.ok(e.basis.length >= 2);
});
