import { test } from "node:test";
import assert from "node:assert/strict";
import type { Report } from "@firewatch/shared/types";
import { building, occupants, sprinklerRooms } from "./buildingData.ts";
import { locate, parseFloor } from "./locate.ts";
import { mergeReports } from "./merge.ts";
import { recommend } from "./recommend.ts";
import { simulateSpread } from "../simulation/spread.ts";
import { findExits } from "../simulation/exits.ts";

test("parseFloor understands digits, words and ordinals", () => {
  const cases: [string, number | undefined][] = [
    ["smoke on the 7th floor", 7],
    ["break room on 7, near the microwaves", 7],
    ["floor ten hallway", 10],
    ["I'm on the first floor", 1],
    ["eighth floor east office", 8],
    ["level 12", 12],
    ["floor 40", undefined],
    ["fire alarm going off", undefined],
  ];
  for (const [text, floor] of cases) assert.equal(parseFloor(text, 12), floor, text);
});

test("locate: floor + room -> room id; floor only -> hallway + follow-up; nothing -> follow-up", () => {
  assert.deepEqual(locate("There's smoke coming from the break room on the 7th floor", building), {
    roomId: "7-break", confidence: 0.8, floor: 7,
  });
  assert.equal(locate("the east stairs smell like smoke on 9", building).roomId, "9-stair-b");
  const vague = locate("lots of smoke here on floor 4", building);
  assert.equal(vague.roomId, "4-hall");
  assert.equal(vague.confidence, 0.4);
  assert.ok(vague.followUp);
  // Floor 4 has 4 rooms: no storage room there, so fall back to the hallway.
  assert.equal(locate("smoke in the storage closet on floor 4", building).roomId, "4-hall");
  const none = locate("fire alarm going off, I can't tell where", building);
  assert.equal(none.roomId, undefined);
  assert.ok(none.followUp);
});

const report = (text: string, roomId: string, confidence: number): Report => ({
  id: text, caller: "test", text, roomId, confidence, time: 0,
});

test("merge: one report sets the origin; smoke from a floor above supports it", () => {
  assert.deepEqual(mergeReports([], building), undefined);
  const one = mergeReports([report("smoke in the break room", "7-break", 0.8)], building)!;
  assert.deepEqual(one, { roomId: "7-break", confidence: 0.8 });
  const two = mergeReports([report("smoke in the break room", "7-break", 0.8), report("smoke in the hallway", "10-hall", 0.4)], building)!;
  assert.equal(two.roomId, "7-break");
  assert.ok(two.confidence >= one.confidence);
});

test("merge: a fire report outweighs an earlier smoke report elsewhere", () => {
  const m = mergeReports([report("smoke here", "3-hall", 0.4), report("flames in the conference room", "5-conf", 0.8)], building)!;
  assert.equal(m.roomId, "5-conf");
  assert.ok(m.confidence < 0.8, "the disagreeing report lowers confidence");
});

test("exits + recommendation for the demo fire in 7-break", () => {
  const snaps = simulateSpread(building, "7-break", 30, { sprinklerRooms });
  const exits = findExits(building, snaps, occupants);
  for (let f = 7; f <= 12; f++) {
    const e = exits.find((x) => x.floor === f)!;
    assert.equal(e.stair, "stair-a", `floor ${f}`);
    assert.ok(e.blockedAt["stair-b"] !== null, `floor ${f} stair B blocked`);
    assert.equal(e.blockedAt["stair-a"], null);
  }
  assert.ok(exits.find((x) => x.floor === 7)!.atRiskAt! <= 5);

  const rec = recommend(exits, "7-break", building);
  assert.ok(rec.actions.length >= 1 && rec.actions.length <= 3);
  assert.match(rec.actions[0], /Evacuate floors .*12 .* by Stairwell A/);
  assert.ok(rec.actions.some((a) => /Engine 3 to floor 7/.test(a)));
  assert.match(rec.callerReply!, /Stairwell A/);
});
