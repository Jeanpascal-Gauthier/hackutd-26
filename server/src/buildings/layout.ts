// Floor-plate generator: one hallway along x with a stairwell at each end, an elevator off the
// middle of the hall, and rooms on both sides that each open onto the hall. Every rectangle is
// axis-aligned and tested against the footprint shape. Pure and deterministic.
import { bbox, rectInside, type Rect, type Shape } from "./geometry.ts";

export interface LayoutDims {
  hallD: number; // hallway depth (z)
  stairW: number; // stairwell length along the hall (its depth = hallD)
  elevW: number;
  elevD: number;
  minHall: number; // shortest hallway left between the stairwells
  minRoomD: number;
  minRoomW: number;
  /** A room must share at least this much wall with the hall, for its door. */
  minOverlap: number;
  targetW: number; // preferred room width along the hall
  maxRooms: number; // ordinary rooms per floor
}

export interface RoomSlot extends Rect {
  side: "north" | "south";
}

export interface FloorLayout {
  hall: Rect;
  stairA: Rect;
  stairB: Rect;
  elevator: Rect;
  /** Ordinary rooms: north side west to east, then south side west to east. */
  rooms: RoomSlot[];
  /** True when no spot beside the hall fit the elevator and it took the east end of the hall band. */
  elevatorInHall: boolean;
}

interface Scored { layout: FloorLayout; score: number }

const EPS = 1e-9;

/** Best layout over a sweep of hallway positions, or null when not even a hall and two stairs fit. */
export function layoutFloor(shape: Shape, dims: LayoutDims): FloorLayout | null {
  const box = bbox(shape[0]);
  const W = box.maxX - box.minX, D = box.maxZ - box.minZ;
  // Depth that counts fully toward the score; deeper rooms help less. Keeps the hall central
  // in double-loaded plates instead of pushing it to one side to make a few huge rooms.
  const idealD = Math.max((D - dims.hallD) / 2, dims.minRoomD);
  const centre = (box.minZ + box.maxZ) / 2;
  const step = Math.max(0.25, D / 60);
  const lo = box.minZ + dims.hallD / 2, hi = box.maxZ - dims.hallD / 2;
  const zs: number[] = [];
  if (lo <= hi + EPS) {
    zs.push(Math.min(hi, Math.max(lo, centre)));
    for (let k = 1; centre - k * step >= lo - EPS || centre + k * step <= hi + EPS; k++) {
      if (centre - k * step >= lo - EPS) zs.push(centre - k * step);
      if (centre + k * step <= hi + EPS) zs.push(centre + k * step);
    }
  }
  const cols = Math.max(1, Math.min(160, Math.round(W / 0.5)));
  const s = W / cols;
  let best: Scored | null = null;
  for (const zc of zs) {
    const tried = tryHall(shape, dims, box, s, cols, zc, idealD);
    if (tried && (!best || tried.score > best.score + 1e-6)) best = tried;
  }
  return best?.layout ?? null;
}

function tryHall(
  shape: Shape,
  dims: LayoutDims,
  box: ReturnType<typeof bbox>,
  s: number,
  cols: number,
  zc: number,
  idealD: number,
): Scored | null {
  const hz0 = zc - dims.hallD / 2, hz1 = zc + dims.hallD / 2;
  const colX = (i: number) => box.minX + i * s;

  // Longest run of columns where the hall band fits.
  let runStart = -1, bestA = 0, bestB = 0;
  for (let i = 0; i <= cols; i++) {
    const ok = i < cols && rectInside({ x0: colX(i), x1: colX(i + 1), z0: hz0, z1: hz1 }, shape);
    if (ok && runStart < 0) runStart = i;
    if (!ok && runStart >= 0) {
      if (i - runStart > bestB - bestA) [bestA, bestB] = [runStart, i];
      runStart = -1;
    }
  }
  const i0 = bestA, i1 = bestB;
  const ax = colX(i0), bx = colX(i1);
  const len = bx - ax;
  let stairW = dims.stairW;
  if (len < 2 * stairW + dims.minHall) stairW = (len - dims.minHall) / 2;
  if (stairW < 1.5) return null;
  let hx0 = ax + stairW, hx1 = bx - stairW;

  // Depth available beside the hall, per column, on each side.
  const depthAt = (i: number, side: "north" | "south"): number => {
    const limit = side === "north" ? hz0 - box.minZ : box.maxZ - hz1;
    if (limit < dims.minRoomD) return 0;
    const rect = (d: number): Rect =>
      side === "north" ? { x0: colX(i), x1: colX(i + 1), z0: hz0 - d, z1: hz0 } : { x0: colX(i), x1: colX(i + 1), z0: hz1, z1: hz1 + d };
    let good: number;
    if (rectInside(rect(limit), shape)) good = limit;
    else if (!rectInside(rect(dims.minRoomD), shape)) return 0;
    else {
      let a = dims.minRoomD, b = limit;
      for (let k = 0; k < 12; k++) {
        const m = (a + b) / 2;
        if (rectInside(rect(m), shape)) a = m;
        else b = m;
      }
      good = a;
    }
    return Math.floor(good * 20 + 1e-9) / 20; // 5 cm steps, rounded down so the room stays inside
  };
  const depth = {
    north: Array.from({ length: cols }, (_, i) => (i >= i0 && i < i1 ? depthAt(i, "north") : 0)),
    south: Array.from({ length: cols }, (_, i) => (i >= i0 && i < i1 ? depthAt(i, "south") : 0)),
  };

  // Elevator: off the middle of the hall, north side first, nearest the middle.
  const ec = Math.max(1, Math.ceil(dims.elevW / s - 1e-9));
  const mid = (hx0 + hx1) / 2;
  let elevator: Rect | null = null;
  let elevatorSide: "north" | "south" | null = null;
  let elevCols: [number, number] = [0, 0];
  const starts = Array.from({ length: Math.max(0, i1 - i0 - ec + 1) }, (_, k) => i0 + k)
    .filter((j) => colX(j) >= hx0 - EPS && colX(j + ec) <= hx1 + EPS)
    .sort((a, b) => Math.abs(colX(a) + (ec * s) / 2 - mid) - Math.abs(colX(b) + (ec * s) / 2 - mid) || a - b);
  for (const side of ["north", "south"] as const) {
    for (const j of starts) {
      let ok = true;
      for (let i = j; i < j + ec; i++) if (depth[side][i] < Math.min(dims.elevD, dims.minRoomD)) ok = false;
      if (!ok) continue;
      const ed = Math.min(dims.elevD, ...depth[side].slice(j, j + ec));
      elevator = side === "north" ? { x0: colX(j), x1: colX(j + ec), z0: hz0 - ed, z1: hz0 } : { x0: colX(j), x1: colX(j + ec), z0: hz1, z1: hz1 + ed };
      elevatorSide = side;
      elevCols = [j, j + ec];
      break;
    }
    if (elevator) break;
  }
  let elevatorInHall = false;
  if (!elevator) {
    // Nowhere beside the hall: the elevator takes the east end of the hall band.
    const ew = Math.min(dims.elevW, hx1 - hx0 - dims.minHall);
    if (ew < 1.5) return null;
    elevator = { x0: hx1 - ew, x1: hx1, z0: hz0, z1: hz1 };
    hx1 -= ew;
    elevatorInHall = true;
  }

  // Runs of columns deep enough for rooms, split where the depth changes a lot.
  interface Run { side: "north" | "south"; a: number; b: number }
  const runs: Run[] = [];
  for (const side of ["north", "south"] as const) {
    let cur: Run | null = null, ref = 0;
    for (let i = i0; i <= i1; i++) {
      const blocked = side === elevatorSide && i >= elevCols[0] && i < elevCols[1];
      const d = i < i1 && !blocked ? depth[side][i] : 0;
      const ok = d >= dims.minRoomD;
      if (cur && (!ok || Math.abs(d - ref) > Math.max(1.5, ref * 0.1))) {
        runs.push(cur);
        cur = null;
      }
      if (ok && !cur) {
        cur = { side, a: i, b: i + 1 };
        ref = d;
      } else if (ok && cur) cur.b = i + 1;
    }
  }
  const usable = runs.filter((r) => (r.b - r.a) * s >= dims.minRoomW - EPS);

  // Room count: about targetW wide, at most maxRooms per floor (wider rooms when capped).
  const total = usable.reduce((n, r) => n + (r.b - r.a) * s, 0);
  let tw = Math.max(dims.targetW, total / dims.maxRooms);
  const countFor = (r: Run, w: number) => Math.max(1, Math.min(Math.round(((r.b - r.a) * s) / w), Math.floor(((r.b - r.a) * s) / dims.minRoomW + 1e-9)));
  for (let k = 0; k < 60 && usable.reduce((n, r) => n + countFor(r, tw), 0) > dims.maxRooms; k++) tw *= 1.1;
  // Still too many (many short runs at one room each): keep the longest runs.
  let kept = usable;
  while (kept.reduce((n, r) => n + countFor(r, tw), 0) > dims.maxRooms) {
    const shortest = kept.reduce((m, r) => (r.b - r.a < m.b - m.a ? r : m));
    kept = kept.filter((r) => r !== shortest);
  }

  const rooms: RoomSlot[] = [];
  for (const run of kept) {
    // Deep runs (a wing off the hall) get proportionally wider rooms rather than long slabs.
    const runDepth = Math.min(...depth[run.side].slice(run.a, run.b));
    const k = Math.min(countFor(run, tw), countFor(run, Math.max(tw, runDepth * 0.6)));
    const n = run.b - run.a;
    const pieces: [number, number][] = [];
    for (let j = 0; j < k; j++) pieces.push([run.a + Math.round((n * j) / k), run.a + Math.round((n * (j + 1)) / k)]);
    // Rooms past the hall ends (beside a stairwell) merge into their neighbour so every room has a door.
    const overlap = ([a, b]: [number, number]) => Math.min(colX(b), hx1) - Math.max(colX(a), hx0);
    for (let j = 0; j < pieces.length; j++) {
      if (overlap(pieces[j]) >= dims.minOverlap - EPS || pieces.length === 1) continue;
      const into = j + 1 < pieces.length ? j + 1 : j - 1;
      pieces[into] = [Math.min(pieces[into][0], pieces[j][0]), Math.max(pieces[into][1], pieces[j][1])];
      pieces.splice(j, 1);
      j--;
    }
    for (const [a, b] of pieces) {
      if (b <= a || overlap([a, b]) < dims.minOverlap - EPS) continue;
      const d = Math.min(...depth[run.side].slice(a, b));
      if (d < dims.minRoomD) continue;
      const x0 = colX(a), x1 = colX(b);
      rooms.push(run.side === "north" ? { side: "north", x0, x1, z0: hz0 - d, z1: hz0 } : { side: "south", x0, x1, z0: hz1, z1: hz1 + d });
    }
  }
  if (!rooms.length) return null;
  rooms.sort((a, b) => (a.side === b.side ? a.x0 - b.x0 : a.side === "north" ? -1 : 1));

  const score =
    rooms.reduce((n, r) => n + (r.x1 - r.x0) * Math.min(r.z1 - r.z0, idealD), 0) +
    0.01 * (hx1 - hx0) -
    (elevatorInHall ? 25 : 0);
  return {
    score,
    layout: {
      hall: { x0: hx0, x1: hx1, z0: hz0, z1: hz1 },
      stairA: { x0: ax, x1: ax + stairW, z0: hz0, z1: hz1 },
      stairB: { x0: bx - stairW, x1: bx, z0: hz0, z1: hz1 },
      elevator,
      rooms,
      elevatorInHall,
    },
  };
}
