// No network: checks the deterministic room lookup behind the locate_room tool.
//   npm test -w agent
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Building } from "@firewatch/shared/types";
import sharedBuilding from "@firewatch/shared/building.json" with { type: "json" };
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
