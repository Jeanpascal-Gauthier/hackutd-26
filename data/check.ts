// Pure validation: returns a list of error strings (empty = valid).
import type { Building } from "@firewatch/shared/types";
import {
  ELEVATOR,
  FLAGS,
  FLOORS,
  INSPECTION_AS_OF,
  INSPECTION_STATUSES,
  INSPECTION_SYSTEMS,
  SHAFTS,
  STAIRS,
  daysFromIso,
  doorId,
  isoFromDays,
  roomId,
  type BuildingMeta,
} from "./model.ts";

const isIsoDate = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && isoFromDays(daysFromIso(s)) === s;

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

  // Inspections: known system/status, target exists on the stated floor, valid dates
  const inspections = meta.inspections ?? [];
  if (!Array.isArray(meta.inspections)) err("meta.inspections missing");
  const ratedDoors = new Map(meta.doors.filter((d) => d.ratingMinutes > 0).map((d) => [doorId(d), d]));
  const insp = new Map<string, BuildingMeta["inspections"][number]>();
  for (const r of inspections) {
    const at = `inspection ${r.id}`;
    if (insp.has(r.id)) err(`duplicate inspection id: ${r.id}`);
    insp.set(r.id, r);
    if (r.id !== `${r.system}:${r.target}`) err(`${at}: id should be ${r.system}:${r.target}`);
    if (!(INSPECTION_SYSTEMS as readonly string[]).includes(r.system)) err(`${at}: unknown system ${r.system}`);
    if (!(INSPECTION_STATUSES as readonly string[]).includes(r.status)) err(`${at}: unknown status ${r.status}`);
    let floor: number | undefined;
    if (r.system === "sprinkler") {
      floor = rooms.get(r.target)?.floor;
      if (floor === undefined) err(`${at}: unknown room ${r.target}`);
      else if (meta.sprinklers[r.target] === "none") err(`${at}: room ${r.target} has no sprinkler`);
    } else if (r.system === "fire-door") {
      const d = ratedDoors.get(r.target);
      floor = d && rooms.get(d.a)?.floor;
      if (!d) err(`${at}: no fire-rated door ${r.target}`);
    } else {
      const m = /^floor-(\d+)$/.exec(r.target);
      floor = m ? Number(m[1]) : undefined;
      if (!m || floor! < 1 || floor! > meta.floors) err(`${at}: bad floor target ${r.target}`);
    }
    if (floor !== undefined && r.floor !== floor) err(`${at}: floor ${r.floor}, target is on floor ${floor}`);
    if (!isIsoDate(r.lastInspected)) err(`${at}: bad lastInspected ${r.lastInspected}`);
    if (!isIsoDate(r.nextDue)) err(`${at}: bad nextDue ${r.nextDue}`);
    if (!(r.nextDue > r.lastInspected)) err(`${at}: nextDue ${r.nextDue} not after lastInspected ${r.lastInspected}`);
    if (r.lastInspected > INSPECTION_AS_OF) err(`${at}: lastInspected ${r.lastInspected} is after ${INSPECTION_AS_OF}`);
    if (r.status === "pass" && r.nextDue < INSPECTION_AS_OF) err(`${at}: status pass but due ${r.nextDue}`);
    if (r.status === "overdue" && !(r.nextDue < INSPECTION_AS_OF)) err(`${at}: status overdue but due ${r.nextDue}`);
    if (r.status === "deficient" && !r.finding) err(`${at}: deficient without a finding`);
    if (r.status === "pass" && r.finding) err(`${at}: pass with a finding`);
  }
  // Coverage: every sprinkler, every rated door, a fire alarm + standpipe per floor
  const want = [
    ...Object.entries(meta.sprinklers).filter(([, s]) => s !== "none").map(([id]) => `sprinkler:${id}`),
    ...[...ratedDoors.keys()].map((id) => `fire-door:${id}`),
    ...Array.from({ length: meta.floors }, (_, i) => [`fire-alarm:floor-${i + 1}`, `standpipe:floor-${i + 1}`]).flat(),
  ];
  for (const id of want) if (!insp.has(id)) err(`missing inspection record: ${id}`);
  // Consistency with the simulation inputs: impaired sprinklers and propped-open rated doors
  // must show up as deficient records.
  for (const [id, s] of Object.entries(meta.sprinklers))
    if (s === "impaired" && insp.get(`sprinkler:${id}`)?.status !== "deficient") err(`impaired sprinkler ${id} has no deficient inspection`);
  for (const l of b.links)
    if (l.kind === "door" && l.fireRated && !l.closed) {
      const id = `fire-door:${doorId(l)}`;
      if (insp.get(id)?.status !== "deficient") err(`propped-open rated door ${doorId(l)} has no deficient inspection`);
    }

  // Demo ids
  for (const id of ["7-break", "10-east", meta.demo.origin]) if (!rooms.has(id)) err(`demo room missing: ${id}`);
  const demoSprinkler = insp.get("sprinkler:7-break");
  if (demoSprinkler?.status !== "deficient" || !(demoSprinkler.nextDue < INSPECTION_AS_OF))
    err("demo: sprinkler:7-break should be deficient and overdue");
  if (insp.get("fire-door:7-hall|7-stair-b")?.status !== "deficient") err("demo: fire-door:7-hall|7-stair-b should be deficient");

  return errs;
}
