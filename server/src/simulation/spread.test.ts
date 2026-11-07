import { test } from "node:test";
import assert from "node:assert/strict";
import type { Building } from "@firewatch/shared/types";
import { simulateSpread } from "./spread.ts";
import { fixtureBuilding as B } from "./fixture.ts";

const at = (s: ReturnType<typeof simulateSpread>, m: number, id: string) =>
  s[m].rooms.find((r) => r.roomId === id)!;

test("returns minutes 0..30 inclusive", () => {
  const s = simulateSpread(B, "7-break");
  assert.equal(s.length, 31);
  assert.deepEqual(s.map((x) => x.minute), Array.from({ length: 31 }, (_, i) => i));
});

test("values stay within 0..1", () => {
  for (const sprinklerRooms of [[], ["7-break"]])
    for (const snap of simulateSpread(B, "7-break", 30, { sprinklerRooms }))
      for (const r of snap.rooms) {
        assert.ok(r.fire >= 0 && r.fire <= 1 && r.smoke >= 0 && r.smoke <= 1);
      }
});

test("disconnected room stays clean", () => {
  const s = simulateSpread(B, "7-break");
  assert.equal(at(s, 30, "7-island").fire, 0);
  assert.equal(at(s, 30, "7-island").smoke, 0);
});

test("spread follows graph: neighbours before distant rooms", () => {
  const s = simulateSpread(B, "7-break");
  assert.ok(at(s, 2, "7-hall").smoke > 0);
  assert.equal(at(s, 1, "7-office").smoke, 0); // two hops away
});

test("open door transfers faster than closed fire-rated door", () => {
  // Same geometry, only the door state differs.
  const mk = (closed: boolean, fireRated: boolean): Building => ({
    rooms: B.rooms.filter((r) => r.id === "7-break" || r.id === "7-hall"),
    links: [{ a: "7-break", b: "7-hall", kind: "door", fireRated, closed }],
    verticals: [],
  });
  const open = simulateSpread(mk(false, true), "7-break");
  const shut = simulateSpread(mk(true, true), "7-break");
  for (const m of [3, 6, 10]) {
    assert.ok(at(open, m, "7-hall").smoke > at(shut, m, "7-hall").smoke);
    assert.ok(at(open, m, "7-hall").fire >= at(shut, m, "7-hall").fire);
  }
});

test("sprinklers reduce and cap fire growth", () => {
  const dry = simulateSpread(B, "7-break");
  const wet = simulateSpread(B, "7-break", 30, { sprinklerRooms: ["7-break"] });
  assert.ok(at(wet, 10, "7-break").fire < at(dry, 10, "7-break").fire);
  for (const snap of wet) assert.ok(snap.rooms.find((r) => r.roomId === "7-break")!.fire <= 0.35 + 1e-9);
});

test("smoke spreads faster than fire", () => {
  const s = simulateSpread(B, "7-break");
  const hall = (m: number) => at(s, m, "7-hall");
  assert.ok(hall(2).smoke > hall(2).fire);
  assert.ok(hall(5).smoke > hall(5).fire);
});

test("upward smoke is ~3x the same-link downward baseline", () => {
  // Floor 7 hall fire vs floor 8 hall fire, identical otherwise: compare first-minute transfer.
  const hallOnly: Building = {
    rooms: B.rooms.filter((r) => r.id.endsWith("-hall")),
    links: [],
    verticals: B.verticals,
  };
  // Seed smoke by starting a fire in each hall; minute-1 inflow to the other floor is
  // (rate x smoke difference). Smoke at minute 0 is 0, so look at minute 2 inflow instead.
  const up = simulateSpread(hallOnly, "7-hall", 2);
  const down = simulateSpread(hallOnly, "8-hall", 2);
  const upIn = at(up, 2, "8-hall").smoke;
  const downIn = at(down, 2, "7-hall").smoke;
  assert.ok(Math.abs(upIn / downIn - 3) < 0.05, `ratio ${upIn / downIn}`);
});

test("deterministic and independent of room order", () => {
  const a = simulateSpread(B, "7-break");
  assert.deepEqual(a, simulateSpread(B, "7-break"));
  const rev: Building = { ...B, rooms: [...B.rooms].reverse() };
  const b = simulateSpread(rev, "7-break");
  for (let m = 0; m <= 30; m++)
    for (const r of a[m].rooms) assert.deepEqual(at(b, m, r.roomId), r);
});

test("unknown origin throws", () => {
  assert.throws(() => simulateSpread(B, "nope"));
});
