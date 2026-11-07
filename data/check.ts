// Pure validation: returns a list of error strings (empty = valid).
import type { Building } from "@firewatch/shared/types";
import { ELEVATOR, FLAGS, FLOORS, SHAFTS, STAIRS, roomId, type BuildingMeta } from "./model.ts";

export function validate(b: Building, meta: BuildingMeta): string[] {
  const errs: string[] = [];
  const err = (m: string) => errs.push(m);

  // Unique ids
  const rooms = new Map<string, Building["rooms"][number]>();
  for (const r of b.rooms) {
    if (rooms.has(r.id)) err(`duplicate room id: ${r.id}`);
    rooms.set(r.id, r);
  }
  const vids = new Set<string>();
  for (const v of b.verticals) {
    if (vids.has(v.id)) err(`duplicate vertical id: ${v.id}`);
    vids.add(v.id);
  }

  // Rooms: floor range + positive dimensions
  for (const r of b.rooms) {
    if (!Number.isInteger(r.floor) || r.floor < 1 || r.floor > meta.floors) err(`${r.id}: floor ${r.floor} out of range 1..${meta.floors}`);
    for (const k of ["w", "d"] as const) if (!(r[k] > 0)) err(`${r.id}: ${k} must be > 0 (got ${r[k]})`);
    if (![r.x, r.z].every(Number.isFinite)) err(`${r.id}: x/z must be finite`);
  }

  // Links: valid refs, no self/duplicate links, same floor
  const seen = new Set<string>();
  for (const l of b.links) {
    const ra = rooms.get(l.a);
    const rb = rooms.get(l.b);
    if (!ra) err(`link references unknown room: ${l.a}`);
    if (!rb) err(`link references unknown room: ${l.b}`);
    if (l.a === l.b) err(`self link: ${l.a}`);
    const key = [l.a, l.b].sort().join("|");
    if (seen.has(key)) err(`duplicate link: ${key}`);
    seen.add(key);
    if (ra && rb && ra.floor !== rb.floor) err(`horizontal link crosses floors: ${l.a} <-> ${l.b}`);
  }

  // Floors: one hall, 4-6 ordinary rooms, all shafts present
  for (let f = 1; f <= meta.floors; f++) {
    const onFloor = b.rooms.filter((r) => r.floor === f);
    if (!rooms.has(roomId(f, "hall"))) err(`floor ${f}: missing hallway`);
    const ordinary = onFloor.filter((r) => !r.id.endsWith("-hall") && !SHAFTS.some((s) => r.id === roomId(f, s)));
    if (ordinary.length < 4 || ordinary.length > 6) err(`floor ${f}: ${ordinary.length} rooms (expected 4-6)`);
  }

  // Verticals: ranges, and every floor in range has a shaft room linked to the hall
  const adj = new Map<string, string[]>();
  for (const l of b.links) {
    if (!adj.has(l.a)) adj.set(l.a, []);
    if (!adj.has(l.b)) adj.set(l.b, []);
    adj.get(l.a)!.push(l.b);
    adj.get(l.b)!.push(l.a);
  }
  for (const id of SHAFTS) {
    const v = b.verticals.find((x) => x.id === id);
    if (!v) { err(`missing vertical: ${id}`); continue; }
    const [lo, hi] = v.floors;
    if (lo !== 1 || hi !== FLOORS) err(`${id}: expected floors [1, ${FLOORS}], got [${lo}, ${hi}]`);
    const want = id === ELEVATOR ? "elevator" : "stair";
    if (v.kind !== want) err(`${id}: kind should be ${want}`);
    for (let f = lo; f <= hi; f++) {
      const shaft = roomId(f, id);
      if (!rooms.has(shaft)) err(`${id}: no shaft room on floor ${f}`);
      else if (!(adj.get(shaft) ?? []).includes(roomId(f, "hall"))) err(`${id}: ${shaft} not linked to ${roomId(f, "hall")}`);
    }
  }
  for (const v of b.verticals) {
    if (!SHAFTS.includes(v.id)) err(`unexpected vertical: ${v.id}`);
  }
  if (STAIRS.length !== 2) err("expected two stairwells");

  // Whole-building connectivity: floors joined via verticals, ignoring door state
  const reach = new Set<string>();
  const queue = [roomId(1, "hall")];
  while (queue.length) {
    const cur = queue.pop()!;
    if (reach.has(cur)) continue;
    reach.add(cur);
    queue.push(...(adj.get(cur) ?? []));
    const r = rooms.get(cur);
    const v = r && b.verticals.find((x) => cur === roomId(r.floor, x.id));
    if (r && v) for (let f = v.floors[0]; f <= v.floors[1]; f++) queue.push(roomId(f, v.id));
  }
  for (const r of b.rooms) if (!reach.has(r.id)) err(`unreachable room: ${r.id}`);

  // Meta: doors, sprinklers, occupants
  const doorLinks = new Map(b.links.filter((l) => l.kind === "door").map((l) => [[l.a, l.b].sort().join("|"), l]));
  for (const d of meta.doors) {
    const l = doorLinks.get([d.a, d.b].sort().join("|"));
    if (!l) err(`door meta without door link: ${d.a} <-> ${d.b}`);
    else if (l.fireRated !== d.ratingMinutes > 0) err(`door ${d.a} <-> ${d.b}: fireRated=${l.fireRated} but ratingMinutes=${d.ratingMinutes}`);
    if (!(d.ratingMinutes >= 0)) err(`door ${d.a} <-> ${d.b}: bad rating ${d.ratingMinutes}`);
  }
  if (meta.doors.length !== doorLinks.size) err(`door meta count ${meta.doors.length} != door links ${doorLinks.size}`);
  for (const [id, s] of Object.entries(meta.sprinklers)) {
    if (!rooms.has(id)) err(`sprinkler for unknown room: ${id}`);
    if (!["active", "impaired", "none"].includes(s)) err(`${id}: bad sprinkler status ${s}`);
  }
  for (const r of b.rooms) if (!(r.id in meta.sprinklers)) err(`no sprinkler status for ${r.id}`);
  const occSeen = new Set<string>();
  for (const o of meta.occupants) {
    if (!rooms.has(o.room)) err(`occupants for unknown room: ${o.room}`);
    if (occSeen.has(o.room)) err(`duplicate occupant entry: ${o.room}`);
    occSeen.add(o.room);
    if (!Number.isInteger(o.count) || o.count < 0) err(`${o.room}: invalid occupant count ${o.count}`);
    for (const f of o.flags) if (!(FLAGS as readonly string[]).includes(f)) err(`${o.room}: unknown flag ${f}`);
    if (o.flags.length > 0 && o.count === 0) err(`${o.room}: flags set on empty room`);
  }

  // Demo ids
  for (const id of ["7-break", "10-east", meta.demo.origin]) if (!rooms.has(id)) err(`demo room missing: ${id}`);

  return errs;
}
