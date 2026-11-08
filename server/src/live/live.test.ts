import { test } from "node:test";
import assert from "node:assert/strict";
import type { Report } from "@firewatch/shared/types";
import { DEMO } from "./buildingData.ts";
import { locate, parseFloor } from "./locate.ts";
import { isFireReport, mergeFires, mergeReports } from "./merge.ts";
import { IncidentStore } from "../state/store.ts";
import { createIngest } from "../state/ingest.ts";
import { LiveIncident } from "./incident.ts";
import { recommend } from "./recommend.ts";
import { simulateSpread } from "../simulation/spread.ts";
import { findExits } from "../simulation/exits.ts";

const { building, occupants, sprinklerRooms } = DEMO;

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

test("merge: flames get a bounded preference that corroborating smoke can overcome", () => {
  const smoke = [
    report("smoke in the break room", "7-break", 0.8),
    report("smoke in stairwell B", "9-stair-b", 0.8),
  ];
  const flames = report("flames in the conference room", "10-conf", 0.8);
  assert.deepEqual(mergeReports([...smoke, flames], building), { roomId: "10-conf", confidence: 0.4 });
  // A third smoke report brings the lower candidate level with flames; the lower floor wins.
  assert.deepEqual(
    mergeReports([...smoke, flames, report("smoke in the hallway", "10-hall", 0.8)], building),
    { roomId: "7-break", confidence: 0.46 },
  );
  assert.deepEqual(
    mergeReports([...smoke, { ...flames, confidence: 0.2 }], building),
    { roomId: "7-break", confidence: 0.66 },
  );
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
  const route10 = exits.find((x) => x.floor === 10)!.route!;
  assert.deepEqual(route10.slice(0, 2), ["10-hall", "10-stair-a"]);
  assert.equal(route10.at(-1), "1-stair-a");
  assert.equal(route10.length, 11);
  assert.ok(route10.every((id) => !id.includes("stair-b")));

  const rec = recommend(exits, "7-break", building);
  assert.ok(rec.actions.length >= 1 && rec.actions.length <= 3);
  assert.match(rec.actions[0], /Evacuate floors .*12 .* by Stairwell A/);
  assert.ok(rec.actions.some((a) => /Engine 3 to floor 7/.test(a)));
  assert.match(rec.callerReply!, /Leave now by Stairwell A; do not use Stairwell B or the elevator\./);
});

test("caller reply always says not to use the elevator, even with no stairwell to avoid", () => {
  // 10-east: no stairwell fills with smoke, so there is nothing to avoid but the elevator.
  const snaps = simulateSpread(building, "10-east", 30, { sprinklerRooms });
  const exits = findExits(building, snaps, occupants);
  const reply = recommend(exits, "10-east", building).callerReply!;
  assert.match(reply, /Do not use the elevator\./);
  assert.doesNotMatch(reply, /or the elevator/, `reads as advice to take the elevator: ${reply}`);
});

test("isFireReport: a seen fire counts; fire alarms, exits and doors don't", () => {
  for (const t of ["There's a fire on floor four", "I see flames", "the office is burning", "FIRE!"])
    assert.ok(isFireReport(t), t);
  for (const t of ["fire alarm going off, I can't tell where", "smoke near the fire exit", "the fire door is open", "smoke in the hall"])
    assert.ok(!isFireReport(t), t);
});

test("mergeFires: fire reports on different floors are separate fires (the 4th + 7th floor calls)", () => {
  const fires = mergeFires([
    report("There's fire on floor seven, uh, in the center office, the west office.", "7-west", 0.8),
    report("There's a fire on floor four in the east office.", "4-east", 0.8),
    report("There's a fire on floor four in the east office.", "4-east", 0.8), // same caller again
  ], building);
  assert.deepEqual(fires.map((f) => f.roomId), ["4-east", "7-west"]);
  assert.equal(fires[0].confidence, 0.95, "two reports of the same room add up (capped)");
  assert.equal(fires[1].confidence, 0.8);
});

test("mergeFires: smoke-only reports behave exactly like mergeReports", () => {
  const smoke = [report("smoke in the break room", "7-break", 0.8), report("smoke in the hallway", "10-hall", 0.4)];
  assert.deepEqual(mergeFires(smoke, building), [mergeReports(smoke, building)]);
  assert.deepEqual(mergeFires([], building), []);
});

test("mergeFires: one fire per floor, in a real room; smoke above supports it, smoke below is another fire", () => {
  const sameFloor = mergeFires([report("fire in the hallway", "7-hall", 0.9), report("flames in the break room", "7-break", 0.6)], building);
  assert.deepEqual(sameFloor.map((f) => f.roomId), ["7-break"], "one fire, placed in the room rather than the hall");
  assert.ok(sameFloor[0].confidence > 0.6, "the hall report still supports it");

  const above = mergeFires([report("flames in the break room", "7-break", 0.6), report("smoke on 10", "10-hall", 0.8)], building);
  assert.deepEqual(above.map((f) => f.roomId), ["7-break"]);
  assert.equal(above[0].confidence, 0.76, "1 - (1-0.6)(1-0.4)");

  // C's three-report fixture: flames on 10, smoke on 7 and in stair B on 9 (below the flames).
  const three = mergeFires([
    report("smoke in the break room", "7-break", 0.8),
    report("smoke in stairwell B", "9-stair-b", 0.8),
    report("flames in the conference room", "10-conf", 0.8),
  ], building);
  assert.deepEqual(three, [{ roomId: "7-break", confidence: 0.88 }, { roomId: "10-conf", confidence: 0.8 }]);
});

test("recommend: one crew per fire, in one action, never pushed out", () => {
  const snaps = simulateSpread(building, ["7-west", "4-east"], 30, { sprinklerRooms });
  const rec = recommend(findExits(building, snaps, occupants), ["4-east", "7-west"], building);
  assert.ok(rec.actions.length <= 3);
  assert.ok(rec.actions.some((a) => /^Send Engine 3 to floor 4 .*; Engine 5 to floor 7 /.test(a)), rec.actions.join(" | "));
  assert.match(rec.callerReply!, /Do not use|do not use/);
});

test("live incident: every reported fire burns and grows in the timelapse; a new fire never replaces an old one", async () => {
  const store = new IncidentStore();
  const live = new LiveIncident(store);
  live.reset();
  const ingest = createIngest(store, () => live.processor, live);
  const roomAt = (m: number, id: string) => {
    live.goTo(m);
    return store.get().rooms.find((r) => r.roomId === id)!;
  };
  const fireAt = (m: number, id: string) => roomAt(m, id).fire;

  await ingest({ text: "There's fire on floor seven in the west office", caller: "+1", preprocessed: { roomId: "7-west", confidence: 0.8 } });
  assert.ok(fireAt(0, "7-west") > 0);
  assert.equal(fireAt(0, "4-east"), 0);

  await ingest({ text: "There's a fire on floor four in the east office", caller: "+2", preprocessed: { roomId: "4-east", confidence: 0.8 } });
  assert.ok(fireAt(0, "7-west") > 0, "the first fire is still there");
  assert.ok(fireAt(0, "4-east") > 0, "the second fire is added");
  // Both rooms have working sprinklers, so each fire is held small, but both keep burning and fill
  // their floor with smoke over the timelapse.
  for (const [room, hall] of [["7-west", "7-hall"], ["4-east", "4-hall"]]) {
    assert.ok(fireAt(15, room) > 0, `${room} still burning at minute 15`);
    assert.ok(roomAt(15, room).smoke > 0.5 && roomAt(15, hall).smoke > roomAt(0, hall).smoke, `${room} smoke spreads`);
  }
  assert.equal(store.get().log!.filter((l) => l.kind === "origin").at(-1)!.text, "2 fires: 4-east (80%), 7-west (80%)");
  assert.match(store.get().recommendation!.actions.join(" | "), /Engine 3 to floor 4 .*Engine 5 to floor 7/);
});
