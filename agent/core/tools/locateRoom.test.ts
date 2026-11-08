// No network: checks the deterministic room lookup behind the locate_room tool.
//   npm test -w agent
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Building } from "@firewatch/shared/types";
import sharedBuilding from "@firewatch/shared/building.json" with { type: "json" };
import { syntheticBuilding } from "../../fixtures/synthetic.ts";
import { CONFIDENT, locateRoom, mentionsFloor } from "./locateRoom.ts";

const building = sharedBuilding as Building;

test("floor + clear place -> that room, confident", () => {
  const r = locateRoom({ floor: 7, place: "break room near the microwaves" }, building);
  assert.equal(r.roomId, "7-break");
  assert.ok(r.confidence >= CONFIDENT);
  assert.equal(r.followUp, undefined);
});

test("synonyms map to the right room kind", () => {
  const cases: [string, string][] = [
    ["kitchen", "4-break"],
    ["meeting room", "4-conf"],
    ["cubicles", "4-office"],
    ["east side", "4-east"],
    ["west office", "4-west"],
    ["east stairwell", "4-stair-b"],
    ["stairwell A", "4-stair-a"],
    ["stairs b", "4-stair-b"],
    ["elevator", "4-elev-1"],
    ["hallway", "4-hall"],
  ];
  for (const [place, id] of cases) assert.equal(locateRoom({ floor: 4, place }, building).roomId, id, place);
});

test("ambiguous place -> candidates and a follow-up", () => {
  const r = locateRoom({ floor: 9, place: "the stairs" }, building);
  assert.deepEqual(r.candidates, ["9-stair-a", "9-stair-b"]);
  assert.ok(r.confidence < CONFIDENT);
  assert.match(r.followUp ?? "", /Stairwell A or Stairwell B/);
});

test("floor only -> that floor's hallway, low confidence, follow-up", () => {
  const r = locateRoom({ floor: 10 }, building);
  assert.equal(r.roomId, "10-hall");
  assert.ok(r.confidence < CONFIDENT);
  assert.ok(r.followUp);
});

test("place only -> asks for the floor", () => {
  const r = locateRoom({ place: "break room" }, building);
  assert.equal(r.roomId, undefined);
  assert.equal(r.confidence, 0);
  assert.equal(r.followUp, "Which floor are you on?");
});

test("rooms that only exist on some floors", () => {
  assert.equal(locateRoom({ floor: 3, place: "conference room" }, building).roomId, "3-hall");
  assert.equal(locateRoom({ floor: 8, place: "supply closet" }, building).roomId, "8-storage");
  assert.equal(locateRoom({ floor: 7, place: "supply closet" }, building).confidence, 0.4);
});

test("out-of-range or junk floor is ignored", () => {
  assert.equal(locateRoom({ floor: 40, place: "break room" }, building).roomId, undefined);
  assert.equal(locateRoom({ floor: 2.5 as number, place: "break room" }, building).roomId, undefined);
});

test("grounding: a floor or place the caller never said is dropped", () => {
  const heard = "fire alarm going off, I can't tell where it's coming from";
  const r = locateRoom({ floor: 3, place: "hallway" }, building, heard);
  assert.equal(r.roomId, undefined);
  assert.equal(r.confidence, 0);
  assert.equal(r.ignored?.length, 2);
});

test("grounding: paraphrases and number words still count", () => {
  const r = locateRoom({ floor: 7, place: "break room" }, building, "smoke near the microwaves on the seventh floor");
  assert.equal(r.roomId, "7-break");
  assert.equal(r.ignored, undefined);
  assert.equal(locateRoom({ floor: 10, place: "east side" }, building, "I'm on ten\neast side").roomId, "10-east");
  assert.equal(locateRoom({ floor: 8 }, building, "8th floor").roomId, "8-hall");
});

test("mentionsFloor does not confuse 1 with 11 or 12", () => {
  assert.equal(mentionsFloor("I'm on 11", 1), false);
  assert.equal(mentionsFloor("floor 12", 2), false);
  assert.equal(mentionsFloor("the 1st floor", 1), true);
});

test("floor known, room unknown: the question lists that floor's rooms and says what didn't match", () => {
  const r = locateRoom({ floor: 7, place: "room 3" }, building, "there's a fire on floor 7, room 3");
  assert.equal(r.roomId, "7-hall");
  assert.ok(r.confidence < CONFIDENT);
  assert.equal(
    r.followUp,
    `I couldn't find "room 3" on floor 7. Which room on floor 7 is the smoke or fire in: Break Room, East Office, West Office, Open Office or Conference?`,
  );
  assert.doesNotMatch(r.followUp ?? "", /Stairwell|Elevator|Hallway/);
  // Floor 8 has a storage room; no place given -> no "couldn't find" prefix.
  assert.match(locateRoom({ floor: 8 }, building, "8th floor").followUp ?? "", /^Which room on floor 8 .*Storage/);
});

// ---- Buildings generated from an address: rooms with `kind`, generic names ----

test("generated building: room names and kinds, its own floor range", () => {
  const b = syntheticBuilding({ floors: 4 });
  assert.equal(locateRoom({ floor: 2, place: "open office" }, b).roomId, "2-open");
  assert.equal(locateRoom({ floor: 2, place: "office 2" }, b).roomId, "2-office-2");
  assert.equal(locateRoom({ floor: 3, place: "stairwell A" }, b).roomId, "3-stair-a");
  assert.equal(locateRoom({ floor: 3, place: "hallway" }, b).roomId, "3-hall");
  const anyOffice = locateRoom({ floor: 2, place: "the office" }, b);
  assert.deepEqual(anyOffice.candidates, ["2-office-1", "2-office-2", "2-open"]);
  assert.match(anyOffice.followUp ?? "", /Office 1, Office 2 or Open Office/);
  assert.equal(locateRoom({ floor: 5, place: "open office" }, b).roomId, undefined); // only 4 floors
});

test("generated building: kinds match when names don't ('apartment' -> the floor's apartments)", () => {
  const b = syntheticBuilding({
    use: "residential",
    rooms: [
      ["apt-1", "Unit 1", "residential", 10, 8],
      ["laundry", "Laundry", "utility", 4, 8],
    ],
  });
  const r = locateRoom({ floor: 2, place: "apartment" }, b, "smoke in my apartment on floor 2");
  assert.equal(r.roomId, "2-apt-1");
  assert.ok(r.confidence >= CONFIDENT);
});

test("follow-up lists at most 6 rooms, never halls, stairs or elevators", () => {
  const rooms = Array.from({ length: 9 }, (_, i) => [`o${i + 1}`, `Office ${i + 1}`, "office", 5, 5] as [string, string, "office", number, number]);
  const r = locateRoom({ floor: 1 }, syntheticBuilding({ rooms }), "1st floor");
  assert.match(r.followUp ?? "", /for example Office 1, Office 2, Office 3, Office 4, Office 5 or Office 6\?$/);
  assert.doesNotMatch(r.followUp ?? "", /Stairwell|Elevator|Hallway/);
});

test("mentionsFloor knows floors past twelve and the ground floor", () => {
  assert.equal(mentionsFloor("on the fifteenth floor", 15), true);
  assert.equal(mentionsFloor("ground floor lobby", 1), true);
});
