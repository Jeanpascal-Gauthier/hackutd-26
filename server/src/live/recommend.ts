// Rule-based recommendation from the exit picture: 1-3 short actions + a reply for callers.
// The fallback when the Nemotron agent isn't plugged in; same job as write_recommendation.
import type { Building, FloorExit, Recommendation } from "@firewatch/shared/types";

const stairName = (id: string | null) =>
  id ? `Stairwell ${id.replace(/^stair-/, "").toUpperCase()}` : "the nearest safe exit";

/** [7,8,9,11] -> "floors 7–9 and 11". */
function floorList(floors: number[]): string {
  const runs: [number, number][] = [];
  for (const f of [...floors].sort((a, b) => a - b)) {
    const last = runs[runs.length - 1];
    if (last && f === last[1] + 1) last[1] = f;
    else runs.push([f, f]);
  }
  const parts = runs.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`));
  const word = floors.length === 1 ? "floor" : "floors";
  return `${word} ${parts.length > 1 ? parts.slice(0, -1).join(", ") + " and " + parts.at(-1) : parts[0]}`;
}

export function recommend(exits: FloorExit[], originRoomId: string, building: Building): Recommendation {
  const origin = building.rooms.find((r) => r.id === originRoomId);
  const originFloor = origin?.floor ?? 0;

  // A floor is at risk if it is the fire floor, its rooms/hall get smoky, or one of its stairs fills.
  const atRisk = exits.filter(
    (e) => e.floor === originFloor || e.atRiskAt !== null || Object.values(e.blockedAt).some((m) => m !== null),
  );

  const actions: string[] = [];
  // 1. Evacuation, grouped by recommended stairwell.
  const byStair = new Map<string | null, FloorExit[]>();
  for (const e of atRisk) byStair.set(e.stair, [...(byStair.get(e.stair) ?? []), e]);
  for (const [stair, group] of byStair) {
    const people = group.reduce((n, e) => n + e.people, 0);
    const blocked = group
      .flatMap((e) => Object.entries(e.blockedAt))
      .filter(([id, m]) => id !== stair && m !== null) as [string, number][];
    const firstBlock = blocked.length ? blocked.reduce((a, b) => (b[1] < a[1] ? b : a)) : undefined;
    const why = firstBlock ? ` (${stairName(firstBlock[0])} fills with smoke from minute ${firstBlock[1]})` : "";
    actions.push(`Evacuate ${floorList(group.map((e) => e.floor))} (${people} people) by ${stairName(stair)}${why}`);
  }

  // 2. First crew to the origin, via the stair that stays clear on that floor.
  const originExit = exits.find((e) => e.floor === originFloor);
  actions.push(
    `Send Engine 3 to floor ${originFloor}${origin ? ` (${origin.name.replace(/^Floor \d+ /, "")})` : ""} via ${stairName(originExit?.stair ?? null)}`,
  );

  // 3. People who need help to get out.
  const mobility = atRisk.filter((e) => e.flags.includes("mobility")).map((e) => e.floor);
  if (mobility.length) actions.push(`Send help for mobility-limited occupants on ${floorList(mobility)}`);

  const mainStair = [...byStair.entries()].sort((a, b) => b[1].length - a[1].length)[0]?.[0] ?? null;
  const avoid = exits.flatMap((e) => Object.entries(e.blockedAt)).find(([id, m]) => m !== null && id !== mainStair)?.[0];
  // Always warn against the elevator, with or without a smoky stairwell to avoid.
  const callerReply =
    `Fire crews are on the way. Leave now by ${stairName(mainStair)}` +
    (avoid ? `; do not use ${stairName(avoid)} or the elevator.` : `. Do not use the elevator.`) +
    ` Stay low if there is smoke.`;

  return { actions: actions.slice(0, 3), callerReply };
}
