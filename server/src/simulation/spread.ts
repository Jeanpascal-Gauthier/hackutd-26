// Illustrative fire/smoke spread estimate over the building graph.
// Pure and deterministic: minute N is computed only from the minute N-1 snapshot,
// so room iteration order never changes the result.
import type { Building, Link, RoomState } from "@firewatch/shared/types";
import { COEFFICIENTS as C } from "./coefficients.ts";

export interface SpreadSnapshot {
  minute: number;
  rooms: RoomState[]; // same order as building.rooms
}

export interface SpreadOptions {
  /** Room ids with working sprinklers. (Not in the shared schema yet.) */
  sprinklerRooms?: readonly string[];
  /** Which rooms the stairs/elevators open into. Default: rooms whose id ends in "-hall". */
  isVerticalAccess?: (roomId: string) => boolean;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

function smokeRate(l: Link): number {
  if (l.kind === "wall") return C.smoke.wall;
  if (!l.closed) return C.smoke.openDoor;
  return l.fireRated ? C.smoke.closedFireRatedDoor : C.smoke.closedDoor;
}

interface Edge {
  from: string;
  to: string;
  smoke: number;
  fire: number;
}

/** Directed edges; each link and vertical shaft yields edges in both directions. */
function buildEdges(b: Building, opts: SpreadOptions): Edge[] {
  const edges: Edge[] = [];
  const known = new Set(b.rooms.map((r) => r.id));
  for (const l of b.links) {
    if (!known.has(l.a) || !known.has(l.b)) continue;
    const s = smokeRate(l);
    const f = s * C.fireRateRatio;
    edges.push({ from: l.a, to: l.b, smoke: s, fire: f }, { from: l.b, to: l.a, smoke: s, fire: f });
  }
  const access = opts.isVerticalAccess ?? ((id: string) => id.endsWith("-hall"));
  for (const v of b.verticals) {
    const base = v.doorsClosed ? C.verticalBaseline.closed : C.verticalBaseline.open;
    for (let f = v.floors[0]; f < v.floors[1]; f++) {
      const lows = b.rooms.filter((r) => r.floor === f && access(r.id));
      const highs = b.rooms.filter((r) => r.floor === f + 1 && access(r.id));
      for (const lo of lows)
        for (const hi of highs) {
          edges.push({ from: lo.id, to: hi.id, smoke: base * C.verticalUpMultiplier, fire: 0 });
          edges.push({ from: hi.id, to: lo.id, smoke: base * C.verticalDownMultiplier, fire: 0 });
        }
    }
  }
  return edges;
}

function step(prev: Map<string, RoomState>, edges: Edge[], sprinklers: Set<string>): Map<string, RoomState> {
  const inFire = new Map<string, number>();
  const inSmoke = new Map<string, number>();
  const outSmoke = new Map<string, number>();
  for (const e of edges) {
    const p = prev.get(e.from)!;
    const q = prev.get(e.to)!;
    // Smoke diffuses down the gradient; fire only spreads from a burning room.
    const ds = e.smoke * Math.max(0, p.smoke - q.smoke);
    inSmoke.set(e.to, (inSmoke.get(e.to) ?? 0) + ds);
    outSmoke.set(e.from, (outSmoke.get(e.from) ?? 0) + ds);
    inFire.set(e.to, (inFire.get(e.to) ?? 0) + e.fire * p.fire);
  }

  const next = new Map<string, RoomState>();
  for (const [id, r] of prev) {
    const sprinkled = sprinklers.has(id);
    let fire = r.fire;
    const burning = r.fire >= C.ignitionThreshold;
    const growth = (burning ? C.fireGrowth : 0) + (inFire.get(id) ?? 0);
    if (sprinkled) {
      fire += growth * C.sprinkler.growthMultiplier * (1 - fire) - (burning ? C.sprinkler.decay : 0);
      fire = Math.min(fire, C.sprinkler.fireCap);
    } else {
      fire += growth * (1 - fire);
    }
    // Smoke source: this room's fire, plus net inflow from neighbours.
    const produced = C.smokeProduction * r.fire * (1 - r.smoke);
    const smoke = r.smoke + produced + (inSmoke.get(id) ?? 0) - (outSmoke.get(id) ?? 0);
    next.set(id, { roomId: id, fire: clamp01(fire), smoke: clamp01(smoke) });
  }
  return next;
}

/**
 * Illustrative estimate (not a validated fire model) of fire and smoke per room.
 * Returns duration+1 snapshots: minutes 0..duration inclusive (default 30).
 */
export function simulateSpread(
  building: Building,
  originRoomId: string,
  durationMinutes = 30,
  options: SpreadOptions = {},
): SpreadSnapshot[] {
  if (!building.rooms.some((r) => r.id === originRoomId)) {
    throw new Error(`Unknown origin room: ${originRoomId}`);
  }
  const edges = buildEdges(building, options);
  const sprinklers = new Set(options.sprinklerRooms ?? []);
  let cur = new Map<string, RoomState>(
    building.rooms.map((r) => [
      r.id,
      { roomId: r.id, fire: r.id === originRoomId ? C.originInitialFire : 0, smoke: 0 },
    ]),
  );
  const snap = (minute: number): SpreadSnapshot => ({
    minute,
    rooms: building.rooms.map((r) => ({ ...cur.get(r.id)! })),
  });
  const out = [snap(0)];
  for (let m = 1; m <= durationMinutes; m++) {
    cur = step(cur, edges, sprinklers);
    out.push(snap(m));
  }
  return out;
}
