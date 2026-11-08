// Exit finder: for each occupied floor, which stairwell stays clear over the forecast.
// Pure function of the building, the precomputed spread snapshots and the occupants.
import type { Building, FloorExit, Occupant } from "@firewatch/shared/types";
import { COEFFICIENTS as C } from "./coefficients.ts";
import type { SpreadSnapshot } from "./spread.ts";

export function findExits(
  building: Building,
  snapshots: SpreadSnapshot[],
  occupants: Occupant[],
  threshold: number = C.clearThreshold,
): FloorExit[] {
  // snapshots[m].rooms is in building.rooms order.
  const index = new Map(building.rooms.map((r, i) => [r.id, i]));
  const floorOf = new Map(building.rooms.map((r) => [r.id, r.floor]));
  const smokeAt = (m: number, id: string) => snapshots[m].rooms[index.get(id)!].smoke;

  /** First minute the room's smoke reaches the threshold, or null if it never does. */
  const firstSmoky = (id: string): number | null => {
    if (!index.has(id)) return null;
    for (let m = 0; m < snapshots.length; m++) if (smokeAt(m, id) >= threshold) return m;
    return null;
  };
  const peak = (id: string) => Math.max(...snapshots.map((_, m) => smokeAt(m, id)));

  const byFloor = new Map<number, Occupant[]>();
  for (const o of occupants) {
    const f = floorOf.get(o.room);
    if (f === undefined || o.count <= 0) continue;
    byFloor.set(f, [...(byFloor.get(f) ?? []), o]);
  }

  const stairs = building.verticals.filter((v) => v.kind === "stair");
  const exits: FloorExit[] = [];
  for (const [floor, occ] of [...byFloor].sort((a, b) => a[0] - b[0])) {
    const here = stairs.filter((s) => s.floors[0] <= floor && floor <= s.floors[1] && index.has(`${floor}-${s.id}`));
    const blockedAt: Record<string, number | null> = {};
    for (const s of here) blockedAt[s.id] = firstSmoky(`${floor}-${s.id}`);

    // Prefer a stair that never blocks (least smoke if several); else the one that blocks latest.
    const ranked = [...here].sort((a, b) => {
      const ba = blockedAt[a.id] ?? Infinity;
      const bb = blockedAt[b.id] ?? Infinity;
      if (ba !== bb) return bb - ba;
      return peak(`${floor}-${a.id}`) - peak(`${floor}-${b.id}`);
    });

    // People must cross the hallway to reach a stair, so it counts toward the floor's risk.
    const riskRooms = [...occ.map((o) => o.room), `${floor}-hall`];
    const times = riskRooms.map(firstSmoky).filter((m): m is number => m !== null);

    // Walk out: this floor's hall, then down the chosen stairwell to floor 1.
    const stair = ranked[0]?.id ?? null;
    const route = stair
      ? [`${floor}-hall`, ...Array.from({ length: floor }, (_, i) => `${floor - i}-${stair}`)].filter((id) => index.has(id))
      : [];

    exits.push({
      floor,
      people: occ.reduce((n, o) => n + o.count, 0),
      flags: [...new Set(occ.flatMap((o) => o.flags))].sort(),
      stair,
      blockedAt,
      atRiskAt: times.length ? Math.min(...times) : null,
      route,
    });
  }
  return exits;
}
