// Turns a public building record (OSM footprint, height, levels, partial interiors) into the
// simulation's Building: rectangular rooms in local metres, door links, two stairwells and an
// elevator per floor, in the same conventions as the demo building (data/model.ts).
//
// Conventions copied from the demo: room ids `${floor}-<slug>` ("3-hall", "3-break", "3-stair-a",
// "3-elev-1"), names "Floor 3 Break Room", verticals "stair-a" / "stair-b" / "elev-1" spanning every
// floor, shaft rooms linked only to their floor's hall by 60-min rated closed doors, rooms linked to
// the hall by doors (break rooms: ordinary and open; others 20-min rated and closed), neighbouring
// rooms joined by closed walls. Frame: the hallway's west end / north edge is (0, 0), x runs along
// the hall, so stair A sits at negative x, like the demo.
import type { Building, BuildingCandidateSummary, BuildingProfile, Link, Room, RoomKind, Vertical } from "@firewatch/shared/types";
import type { DoorRating, InspectionRecord, SprinklerStatus } from "../live/buildingData.ts";
import type { BuildingCandidate, BuildingRecord, Coordinates, Position } from "./types.ts";
import {
  bbox, distanceToRing, largestInscribedRect, largestPolygon, longAxisAngle, openRing, pointInShape, polygonsOf,
  projector, r2, ringArea, rotate, shapeArea, simplifyRing, type Pt, type Rect, type Shape,
} from "./geometry.ts";
import { layoutFloor, type FloorLayout, type LayoutDims, type RoomSlot } from "./layout.ts";

export interface SynthesizeOptions {
  /** Address as the operator confirmed it (shown as the building's address when OSM has none). */
  address?: string;
  /** IANA time zone at the building, when the geocoder returned one. */
  timezone?: string;
}

export interface SynthesizedBuilding {
  /** Rooms, links, verticals, and `profile` (layoutEstimated, outline, assumptions, ...). */
  building: Building;
  /** Sprinkler status per room id. Unknown for public buildings, so the generator states its assumption. */
  sprinklers: Record<string, SprinklerStatus>;
  /** Every door link with its fire rating. */
  doors: DoorRating[];
  /**
   * The assumed stair B door deficiency, one fire-door record per floor (same shape as the demo's
   * "fire-door:7-hall|7-stair-b"). Nothing else is known about a public building's inspections.
   */
  inspections?: InspectionRecord[];
}

const MAX_OUTLINE_POINTS = 64;
const FLOOR_HEIGHT_M = 3.5;
/** Same ids as the demo (data/model.ts STAIRS / ELEVATOR). */
const STAIR_A = "stair-a", STAIR_B = "stair-b", ELEVATOR = "elev-1";
const SPRINKLER_ASSUMPTION = "No sprinkler records for this building; the forecast assumes no working sprinklers.";
/**
 * The two stairwells differ on purpose, as in the demo building: stair B has a door propped open,
 * stair A's doors are shut. Which floor is unknown, so stair B's vertical says doorsClosed=false and
 * every link stays closed; the spread model (simulation/spread.ts) then opens stair B's door on the
 * fire floor, wherever the fire is. Smoke fills stair B from the fire floor up; stair A stays clear.
 */
const PROPPED_STAIR = STAIR_B;
const PROPPED_ASSUMPTION =
  "Stairwell B is assumed to have its 60-minute door propped open on the fire floor (hold-open device not released to the fire alarm, as found in the demo building), so smoke enters Stairwell B there. Stairwell A's doors are assumed closed.";
const PROPPED_FINDING =
  "Assumed, no inspection records for this building: door may be found propped open (hold-open device not released to fire alarm). The forecast treats it as open when this is the fire floor.";

// ---------------------------------------------------------------------------------------------
// Building use

/** Layout style; `use` is what goes in the profile. */
type Style = "office" | "apartments" | "dorm" | "house" | "school" | "university" | "hospital" | "hotel" | "retail" | "mixed" | "industrial" | "worship";
const USE: Record<Style, string> = {
  office: "office", apartments: "residential", dorm: "residential", house: "residential", school: "school", university: "university",
  hospital: "hospital", hotel: "hotel", retail: "retail", mixed: "mixed", industrial: "industrial", worship: "worship",
};
const DEFAULT_FLOORS: Record<Style, number> = {
  office: 4, apartments: 4, dorm: 4, house: 2, school: 2, university: 4, hospital: 5, hotel: 6, retail: 1, mixed: 4, industrial: 1, worship: 1,
};
/** Preferred room width along the hall, metres. */
const TARGET_W: Record<Style, number> = {
  office: 7, apartments: 9, dorm: 4.5, house: 5, school: 9, university: 10, hospital: 5, hotel: 5, retail: 10, mixed: 9, industrial: 15, worship: 12,
};
const ARTICLE: Record<Style, string> = {
  office: "an office building", apartments: "an apartment building", dorm: "a dormitory", house: "a house", school: "a school",
  university: "a university building", hospital: "a hospital", hotel: "a hotel", retail: "a store", mixed: "a mixed-use building",
  industrial: "an industrial building", worship: "a place of worship",
};

const BUILDING_TAG: Record<string, Style> = {
  office: "office", commercial: "office", civic: "office", government: "office", public: "office", bank: "office", fire_station: "office",
  apartments: "apartments", residential: "apartments", flats: "apartments",
  dormitory: "dorm",
  house: "house", detached: "house", semidetached_house: "house", terrace: "house", bungalow: "house", cabin: "house", farm: "house", hut: "house",
  school: "school", kindergarten: "school",
  university: "university", college: "university",
  hospital: "hospital", clinic: "hospital",
  hotel: "hotel", motel: "hotel", hostel: "hotel",
  retail: "retail", supermarket: "retail", shop: "retail", kiosk: "retail", mall: "retail", store: "retail",
  mixed_use: "mixed", mixed: "mixed",
  warehouse: "industrial", industrial: "industrial", factory: "industrial", manufacture: "industrial", storage: "industrial", hangar: "industrial",
  church: "worship", cathedral: "worship", chapel: "worship", mosque: "worship", temple: "worship", synagogue: "worship", shrine: "worship", religious: "worship",
};
const AMENITY_TAG: Record<string, Style> = {
  school: "school", kindergarten: "school", university: "university", college: "university",
  hospital: "hospital", clinic: "hospital", doctors: "hospital",
  place_of_worship: "worship",
  townhall: "office", courthouse: "office", police: "office", fire_station: "office", library: "office", community_centre: "office", bank: "office",
  restaurant: "retail", cafe: "retail", fast_food: "retail", pharmacy: "retail", marketplace: "retail",
};
const TOURISM_TAG: Record<string, Style> = { hotel: "hotel", motel: "hotel", hostel: "hotel", guest_house: "hotel", apartment: "apartments" };

/** Style from OSM tags, or null when the tags don't say. */
function styleFromTags(tags: Record<string, string>): Style | null {
  const value = (k: string) => tags[k]?.trim().toLowerCase();
  const b = value("building:use") ?? value("building");
  let style: Style | null = b ? BUILDING_TAG[b] ?? null : null;
  const amenity = value("amenity"), tourism = value("tourism");
  const other =
    (amenity && AMENITY_TAG[amenity]) || (tourism && TOURISM_TAG[tourism]) ||
    (value("healthcare") === "hospital" ? "hospital" : null) || (value("shop") ? "retail" : null) || (value("office") ? "office" : null) || null;
  // Shops under flats make a mixed-use building.
  if (style === "apartments" && (value("shop") || (amenity && AMENITY_TAG[amenity] === "retail"))) return "mixed";
  if (!style || (style === "office" && b === "commercial" && other)) style = other ?? style;
  return style;
}

// ---------------------------------------------------------------------------------------------
// Room roles

interface Role { slug: string; label: string; kind: RoomKind }

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const area = (r: Rect) => (r.x1 - r.x0) * (r.z1 - r.z0);
const cx = (r: Rect) => (r.x0 + r.x1) / 2;

/** Assigns roles to slots: picks remove a slot from the free list and return its index. */
function picker(slots: RoomSlot[], free: number[]) {
  const take = (i: number) => {
    free.splice(free.indexOf(i), 1);
    return i;
  };
  const by = (score: (i: number) => number) => take(free.reduce((best, i) => (score(i) > score(best) + 1e-9 ? i : best), free[0]));
  return {
    largest: () => by((i) => area(slots[i])),
    smallest: () => by((i) => -area(slots[i]) + i * 1e-6), // ties: the later slot
    nearest: (x: number) => by((i) => -Math.abs(cx(slots[i]) - x)),
    westmost: () => by((i) => -cx(slots[i])),
    eastmost: () => by((i) => cx(slots[i]) + i * 1e-6),
    /** Remaining slots, west to east (north side first, as listed). */
    rest: () => free.splice(0, free.length),
  };
}

/** Roles for the ordinary rooms of one floor (the lobby, if any, is already taken out of `free`). */
function floorRoles(style: Style, floor: number, slots: RoomSlot[], free: number[], hallMid: number): Map<number, Role> {
  const roles = new Map<number, Role>();
  const p = picker(slots, free);
  const set = (i: number, slug: string, label: string, kind: RoomKind) => roles.set(i, { slug, label, kind });
  const num = (k: number) => `${floor}${String(k).padStart(2, "0")}`;
  const n = () => free.length;

  const office = () => {
    if (n() >= 1) set(p.largest(), "office", "Open Office", "open-office");
    if (n() >= 1) set(p.smallest(), "break", "Break Room", "break");
    if (n() >= 1) set(p.largest(), "conf", "Conference", "conference");
    if (n() >= 2) set(p.smallest(), "storage", "Storage", "storage");
    if (n() >= 1) set(p.westmost(), "west", "West Office", "office");
    if (n() >= 1) set(p.eastmost(), "east", "East Office", "office");
    p.rest().forEach((i, k) => set(i, `office-${k + 1}`, `Office ${k + 1}`, "office"));
  };
  const apartments = (label: string, slug: string) =>
    p.rest().forEach((i, k) => set(i, `${slug}-${LETTERS[k].toLowerCase()}`, `${label} ${floor}${LETTERS[k]}`, "residential"));
  const retail = () => {
    if (n() >= 1) set(p.largest(), "sales", "Sales Floor", "retail");
    if (n() >= 2) set(p.smallest(), "stock", "Stock Room", "storage");
    p.rest().forEach((i, k) => set(i, `shop-${k + 1}`, `Shop ${k + 1}`, "retail"));
  };

  switch (style) {
    case "office":
      office();
      break;
    case "apartments":
      apartments("Apartment", "apt");
      break;
    case "dorm":
      apartments("Dorm Room", "room");
      break;
    case "mixed":
      if (floor === 1) retail();
      else apartments("Apartment", "apt");
      break;
    case "retail":
      if (floor === 1) retail();
      else office();
      break;
    case "house":
      if (floor === 1 && n() >= 1) set(p.largest(), "living", "Living Room", "residential");
      if (floor === 1 && n() >= 1) set(p.largest(), "kitchen", "Kitchen", "residential");
      if (n() >= (floor === 1 ? 2 : 3)) set(p.smallest(), "bath", "Bathroom", "utility");
      p.rest().forEach((i, k) => set(i, `bedroom-${k + 1}`, `Bedroom ${k + 1}`, "residential"));
      break;
    case "school":
      if (floor === 1 && n() >= 4) set(p.largest(), "cafeteria", "Cafeteria", "dining");
      if (n() >= 5) set(p.smallest(), "teachers", "Teachers' Room", "office");
      p.rest().forEach((i, k) => set(i, `class-${k + 1}`, `Classroom ${num(k + 1)}`, "classroom"));
      break;
    case "university":
      if (n() >= 3) set(p.largest(), "lecture", "Lecture Hall", "assembly");
      if (n() >= 5) set(p.smallest(), "faculty", "Faculty Offices", "office");
      p.rest().forEach((i, k) =>
        (k + 1) % 3 === 0 ? set(i, `lab-${k + 1}`, `Lab ${num(k + 1)}`, "lab") : set(i, `class-${k + 1}`, `Classroom ${num(k + 1)}`, "classroom"));
      break;
    case "hospital":
      if (n() >= 3) set(p.smallest(), "supply", "Supply Room", "storage");
      if (n() >= 3) set(p.nearest(hallMid), "nurses", "Nurses' Station", "office");
      p.rest().forEach((i, k) => set(i, `patient-${k + 1}`, `Patient Room ${num(k + 1)}`, "patient"));
      break;
    case "hotel":
      if (floor === 1 && n() >= 3) set(p.largest(), "restaurant", "Restaurant", "dining");
      if (n() >= 6) set(p.smallest(), "housekeeping", "Housekeeping", "storage");
      p.rest().forEach((i, k) => set(i, `room-${num(k + 1)}`, `Room ${num(k + 1)}`, "hotel-room"));
      break;
    case "industrial":
      if (n() >= 1) set(p.largest(), "warehouse", "Warehouse Floor", "storage");
      if (n() >= 1) set(p.smallest(), "office", "Office", "office");
      p.rest().forEach((i, k) => set(i, `bay-${k + 1}`, `Storage Bay ${k + 1}`, "storage"));
      break;
    case "worship":
      if (n() >= 1) set(p.largest(), "sanctuary", "Sanctuary", "assembly");
      if (n() >= 2) set(p.largest(), "fellowship", "Fellowship Hall", "assembly");
      if (n() >= 2) set(p.smallest(), "storage", "Storage", "storage");
      p.rest().forEach((i, k) => set(i, `meeting-${k + 1}`, `Meeting Room ${k + 1}`, "conference"));
      break;
  }
  return roles;
}

/** Floor 1 gets a lobby off the middle of the hall, on the entrance (south) side, for most uses. */
const HAS_LOBBY: Record<Style, boolean> = {
  office: true, apartments: true, dorm: true, house: false, school: true, university: true, hospital: true, hotel: true,
  retail: false, mixed: false, industrial: false, worship: false,
};

/** Kinds whose hall door is an ordinary door that stands open (the demo's break room rule). */
const OPEN_DOOR_KINDS = new Set<RoomKind>(["break", "lobby", "dining", "retail", "assembly"]);

/** Room kind from a mapped room's name or purpose (OSM `room=*`). */
function kindFromText(text: string): RoomKind | null {
  const t = text.toLowerCase();
  const rules: [RegExp, RoomKind][] = [
    [/kitchen|break|pantry|coffee|lounge/, "break"],
    [/conference|meeting|board/, "conference"],
    [/class|seminar/, "classroom"],
    [/lab/, "lab"],
    [/stor(age|e)|closet|archive|stock/, "storage"],
    [/toilet|restroom|bath|wc|shower|technical|utility|server|mechanical|electrical/, "utility"],
    [/lobby|reception|entrance|foyer/, "lobby"],
    [/shop|retail|sales/, "retail"],
    [/dining|cafeteria|canteen|restaurant|cafe/, "dining"],
    [/auditorium|lecture|chapel|hall|gym|sanctuary|theat/, "assembly"],
    [/patient|ward|exam|treatment/, "patient"],
    [/bedroom|hotel/, "hotel-room"],
    [/office|study|workroom/, "office"],
  ];
  return rules.find(([re]) => re.test(t))?.[1] ?? null;
}
const titleCase = (s: string) => s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

// ---------------------------------------------------------------------------------------------
// Footprint

interface Footprint {
  /** Layout shape in the rotated frame (outer ring simplified, then holes). */
  shape: Shape;
  /** lon/lat -> rotated frame. */
  toLocal: (p: Position) => Pt;
  notes: string[];
}

function footprintOf(record: BuildingRecord): Footprint {
  const notes: string[] = [];
  if (!record.footprint) {
    notes.push("The map has no outline for this building; the model uses a 30 m × 20 m rectangle centred on the reported location.");
    const project = projector(record.location);
    const shape: Shape = [[[-15, -10], [15, -10], [15, 10], [-15, 10]]];
    return { shape, toLocal: project, notes };
  }
  const polys = polygonsOf(record.footprint);
  if (polys.length > 1) notes.push(`The map shows ${polys.length} separate parts for this building; only the largest is modelled.`);
  const [outerLL, ...holesLL] = largestPolygon(record.footprint);
  const outerOpen = openRing(outerLL);
  // Projection origin: vertex average of the outer ring.
  const origin: Coordinates = {
    lon: outerOpen.reduce((n, p) => n + p[0], 0) / outerOpen.length,
    lat: outerOpen.reduce((n, p) => n + p[1], 0) / outerOpen.length,
  };
  const project = projector(origin);
  const outer = outerOpen.map(project);
  const angle = longAxisAngle(outer);
  const toLocal = (p: Position) => rotate(project(p), angle);
  const ring = simplifyRing(outer.map((p) => rotate(p, angle)), MAX_OUTLINE_POINTS);
  const holes = holesLL.map((h) => simplifyRing(openRing(h).map(toLocal), MAX_OUTLINE_POINTS)).filter((h) => h.length >= 3);
  return { shape: [ring, ...holes], toLocal, notes };
}

function dimsFor(shape: Shape, style: Style): LayoutDims {
  const box = bbox(shape[0]);
  const D = Math.min(box.maxX - box.minX, box.maxZ - box.minZ);
  const tiny = shapeArea(shape) < 150;
  if (tiny)
    return { hallD: 2, stairW: 3, elevW: 2, elevD: 2, minHall: 1.5, minRoomD: 2.5, minRoomW: 2.5, minOverlap: 1, targetW: Math.min(TARGET_W[style], 5), maxRooms: 3 };
  return {
    hallD: D < 12 ? 2 : 3, stairW: 4, elevW: 3, elevD: 3, minHall: 3, minRoomD: 3, minRoomW: 3, minOverlap: 1.2,
    targetW: TARGET_W[style], maxRooms: 10,
  };
}

/** Layout for the footprint, with fallbacks for awkward or very small shapes. */
function planFor(shape: Shape, style: Style, notes: string[]): FloorLayout {
  const direct = layoutFloor(shape, dimsFor(shape, style));
  if (direct) return direct;
  const rect = largestInscribedRect(shape);
  if (rect) {
    const rectShape: Shape = [[[rect.x0, rect.z0], [rect.x1, rect.z0], [rect.x1, rect.z1], [rect.x0, rect.z1]]];
    const inRect = layoutFloor(rectShape, dimsFor(rectShape, style));
    if (inRect) {
      notes.push("The outline is irregular; the generated rooms fill only its largest rectangular part.");
      return inRect;
    }
  }
  // Too small or narrow for any plan: a minimal one centred on the footprint, past its edges.
  const box = bbox(shape[0]);
  const w = Math.max(box.maxX - box.minX, 10), d = Math.max(box.maxZ - box.minZ, 7.5);
  const mx = (box.minX + box.maxX) / 2, mz = (box.minZ + box.maxZ) / 2;
  const forced: Shape = [[[mx - w / 2, mz - d / 2], [mx + w / 2, mz - d / 2], [mx + w / 2, mz + d / 2], [mx - w / 2, mz + d / 2]]];
  notes.push("The outline is too small or narrow for a generated floor plan; the rooms extend past it.");
  const plan = layoutFloor(forced, dimsFor(forced, style));
  if (!plan) throw new Error("synthesizeBuilding: could not lay out even a minimal floor");
  return plan;
}

// ---------------------------------------------------------------------------------------------
// Floors

function floorsFor(record: BuildingRecord, style: Style, notes: string[]): number {
  let floors: number;
  if (record.floorsAboveGround !== null && Number.isFinite(record.floorsAboveGround) && record.floorsAboveGround > 0) floors = record.floorsAboveGround;
  else if (record.heightMeters !== null && Number.isFinite(record.heightMeters) && record.heightMeters > 0) {
    floors = Math.max(1, Math.round(record.heightMeters / FLOOR_HEIGHT_M));
    notes.push(`The map gives a height of ${Math.round(record.heightMeters * 10) / 10} m but no floor count; assumed ${floors} floor${floors === 1 ? "" : "s"} at about ${FLOOR_HEIGHT_M} m each.`);
  } else {
    floors = DEFAULT_FLOORS[style];
    notes.push(`The map gives no floor count or height; assumed ${floors} floor${floors === 1 ? "" : "s"}, typical for ${ARTICLE[style]}.`);
  }
  return Math.max(1, Math.round(floors));
}

/** Floor (1 = ground) for an OSM level value: level 0 is the ground floor. Null for basements/non-numeric. */
function floorOfLevel(level: string | undefined): number | null {
  if (level === undefined || !/^-?\d+$/.test(level.trim())) return null;
  const n = Number(level);
  return n >= 0 ? n + 1 : null;
}

// ---------------------------------------------------------------------------------------------

export function synthesizeBuilding(record: BuildingRecord, options: SynthesizeOptions = {}): SynthesizedBuilding {
  const assumptions: string[] = [
    "Rooms, doors and stairwells are generated, not mapped: a central hallway with rooms on both sides, a stairwell at each end and one elevator. The real floor plan will differ.",
  ];
  const tagStyle = styleFromTags(record.tags ?? {});
  const style: Style = tagStyle ?? "office";
  if (!tagStyle) assumptions.push("The map does not say what the building is used for; it is laid out as an office building.");
  const floors = floorsFor(record, style, assumptions);
  const fp = footprintOf(record);
  assumptions.push(...fp.notes);
  const plan = planFor(fp.shape, style, assumptions);

  // Demo frame: hall's west end / north edge at (0, 0).
  const ox = plan.hall.x0, oz = plan.hall.z0;
  const local = (p: Pt): Pt => [p[0] - ox, p[1] - oz];
  const box = (r: Rect) => {
    const x = r2(r.x0 - ox), z = r2(r.z0 - oz);
    return { x, z, w: r2(r2(r.x1 - ox) - x), d: r2(r2(r.z1 - oz) - z) };
  };
  const outline = fp.shape[0].map((p) => local(p).map(r2) as [number, number]);

  // Lobby slot: the south-side room off the middle of the hall (the 3D model puts the entrance south).
  const hallMid = (plan.hall.x0 + plan.hall.x1) / 2;
  const slots = plan.rooms;
  let lobby: number | null = null;
  if (HAS_LOBBY[style] && slots.length >= 3) {
    const order = slots.map((_, i) => i).sort((a, b) =>
      (slots[a].side === slots[b].side ? 0 : slots[a].side === "south" ? -1 : 1) || Math.abs(cx(slots[a]) - hallMid) - Math.abs(cx(slots[b]) - hallMid) || a - b);
    lobby = order[0];
  }

  // Mapped OSM rooms with a name or purpose, by floor.
  const mapped = new Map<number, { label: string; kind: RoomKind | null; at: Pt | null }[]>();
  for (const r of record.rooms ?? []) {
    if (r.kind !== "room" && r.kind !== "area") continue;
    const label = r.name ?? (r.purpose ? titleCase(r.purpose) : r.number ? `Room ${r.number}` : null);
    const floor = floorOfLevel(r.sourceLevels[0]);
    if (!label || floor === null || floor > floors) continue;
    let at: Pt | null = null;
    const g = r.geometry;
    if (g?.type === "Point") at = fp.toLocal(g.coordinates);
    else if (g?.type === "Polygon" || g?.type === "MultiPolygon") {
      const ring = openRing(largestPolygon(g)[0]).map(fp.toLocal);
      at = [ring.reduce((n, p) => n + p[0], 0) / ring.length, ring.reduce((n, p) => n + p[1], 0) / ring.length];
    }
    const list = mapped.get(floor) ?? [];
    list.push({ label, kind: kindFromText(`${r.purpose ?? ""} ${r.name ?? ""}`), at });
    mapped.set(floor, list);
  }
  let mappedUsed = 0;

  const rooms: Room[] = [];
  const links: Link[] = [];
  const doors: DoorRating[] = [];
  const sprinklers: Record<string, SprinklerStatus> = {};
  const addLink = (a: string, b: string, kind: Link["kind"], ratingMinutes: number, closed: boolean) => {
    links.push({ a, b, kind, fireRated: ratingMinutes > 0, closed });
    if (kind === "door") doors.push({ a, b, ratingMinutes });
  };
  const addRoom = (floor: number, slug: string, label: string, kind: RoomKind, r: Rect) => {
    const id = `${floor}-${slug}`;
    rooms.push({ id, floor, name: `Floor ${floor} ${label}`, ...box(r), kind });
    sprinklers[id] = "none";
    return id;
  };

  for (let f = 1; f <= floors; f++) {
    const hall = addRoom(f, "hall", "Hallway", "hall", plan.hall);
    const free = slots.map((_, i) => i).filter((i) => !(f === 1 && i === lobby));
    const roles = floorRoles(style, f, slots, free, hallMid);
    if (f === 1 && lobby !== null) roles.set(lobby, { slug: "lobby", label: "Lobby", kind: "lobby" });

    // Mapped names replace generated ones on the matching floor (nearest room when positioned).
    const open = slots.map((_, i) => i).filter((i) => roles.get(i)?.kind !== "lobby");
    for (const m of mapped.get(f) ?? []) {
      if (!open.length) break;
      const at = m.at;
      const pick = at
        ? open.reduce((best, i) => (Math.hypot(cx(slots[i]) - at[0], (slots[i].z0 + slots[i].z1) / 2 - at[1]) < Math.hypot(cx(slots[best]) - at[0], (slots[best].z0 + slots[best].z1) / 2 - at[1]) - 1e-9 ? i : best), open[0])
        : open[0];
      open.splice(open.indexOf(pick), 1);
      const role = roles.get(pick)!;
      roles.set(pick, { slug: role.slug, label: m.label, kind: m.kind ?? role.kind });
      mappedUsed++;
    }

    const used = new Set<string>(["hall", STAIR_A, STAIR_B, ELEVATOR]);
    const ids: string[] = [];
    for (let i = 0; i < slots.length; i++) {
      const role = roles.get(i)!;
      let slug = role.slug;
      for (let k = 2; used.has(slug); k++) slug = `${role.slug}-${k}`;
      used.add(slug);
      const id = addRoom(f, slug, role.label, role.kind, slots[i]);
      ids.push(id);
      const open = OPEN_DOOR_KINDS.has(role.kind);
      addLink(hall, id, "door", open ? 0 : 20, !open);
    }
    // Neighbouring rooms on the same side share a (closed) wall.
    for (let i = 0; i + 1 < slots.length; i++) {
      const a = slots[i], b = slots[i + 1];
      if (a.side === b.side && Math.abs(a.x1 - b.x0) < 1e-6) addLink(ids[i], ids[i + 1], "wall", 0, true);
    }
    // Shafts: 60-min rated doors, closed.
    for (const [slug, label, kind, r] of [
      [STAIR_A, "Stairwell A", "stair", plan.stairA],
      [STAIR_B, "Stairwell B", "stair", plan.stairB],
      [ELEVATOR, "Elevator", "elevator", plan.elevator],
    ] as const) {
      const id = addRoom(f, slug, label, kind, r);
      addLink(hall, id, "door", 60, true);
    }
  }

  if (mappedUsed) assumptions.push(`${mappedUsed} room name${mappedUsed === 1 ? " comes" : "s come"} from the map; their sizes and positions are generated.`);
  assumptions.push(SPRINKLER_ASSUMPTION);
  assumptions.push(
    "Door states are assumed: room doors closed and 20-minute rated (break rooms, lobbies, shops and dining rooms open), stairwell and elevator doors 60-minute rated and closed, except as below.",
  );
  assumptions.push(PROPPED_ASSUMPTION);
  if (plan.elevatorInHall) assumptions.push("No room for an elevator beside the hallway; it is placed at the east end of the hall.");

  const verticals: Vertical[] = [STAIR_A, STAIR_B, ELEVATOR].map((id) => ({
    id,
    kind: id === ELEVATOR ? "elevator" : "stair",
    floors: [1, floors],
    // Stair B: a door is propped open (on the fire floor) => smoke can enter the shaft.
    doorsClosed: id !== PROPPED_STAIR,
  }));

  // The demo records the propped door as a deficient fire-door inspection; mirror it per floor.
  // Dated as of the map lookup (no clock read); nextDue the same day: re-inspect now.
  const asOf = /^\d{4}-\d{2}-\d{2}/.exec(record.source.fetchedAt)?.[0];
  const inspections: InspectionRecord[] = asOf
    ? doors
        .filter((d) => d.b === `${Number.parseInt(d.a)}-${PROPPED_STAIR}`)
        .map((d): InspectionRecord => ({
          id: `fire-door:${d.a}|${d.b}`,
          system: "fire-door",
          target: `${d.a}|${d.b}`,
          floor: Number.parseInt(d.a),
          lastInspected: asOf,
          nextDue: asOf,
          status: "deficient",
          finding: PROPPED_FINDING,
        }))
    : [];

  const { lat, lon } = record.location;
  const src = record.source;
  const profile: BuildingProfile = {
    id: record.id,
    name: record.name ?? record.address ?? options.address ?? `Building at ${lat.toFixed(5)}, ${lon.toFixed(5)}`,
    ...((record.address ?? options.address) ? { address: (record.address ?? options.address)! } : {}),
    source: "osm",
    use: USE[style],
    floors,
    location: { lat, lon },
    ...(options.timezone ? { timezone: options.timezone } : {}),
    outline,
    layoutEstimated: true,
    assumptions,
    attribution: src.license ? `${src.attribution} (${src.license.replace(/-[\d.]+$/, "")})` : src.attribution,
  };

  return { building: { rooms, links, verticals, profile }, sprinklers, doors, inspections };
}

/** A candidate outline for the console's mini map, in metres relative to `origin` (x = east, z = south). */
export function summarizeCandidate(candidate: BuildingCandidate, origin: Coordinates): BuildingCandidateSummary {
  const project = projector(origin);
  // Candidates from listOsmBuildingCandidates carry no tags; full records (BuildingRecord) do.
  const tags = (candidate as Partial<BuildingRecord>).tags;
  const use = tags?.building?.trim() || null;
  let outline: [number, number][] = [];
  let distanceMeters: number;
  if (candidate.footprint) {
    const polys = polygonsOf(candidate.footprint).map((poly) => poly.map((ring) => openRing(ring).map(project)));
    const inside = polys.some((shape) => pointInShape([0, 0], shape));
    distanceMeters = inside ? 0 : Math.min(...polys.flat().map((ring) => distanceToRing([0, 0], ring)));
    const largest = polys.reduce((best, p) => (Math.abs(ringArea(p[0])) > Math.abs(ringArea(best[0])) ? p : best));
    outline = simplifyRing(largest[0], MAX_OUTLINE_POINTS).map(([x, z]) => [r2(x), r2(z)]);
  } else {
    const [x, z] = project([candidate.location.lon, candidate.location.lat]);
    distanceMeters = Math.hypot(x, z);
  }
  return {
    id: candidate.id,
    name: candidate.name,
    address: candidate.address,
    floors: candidate.floorsAboveGround,
    heightMeters: candidate.heightMeters,
    use,
    distanceMeters: Math.round(distanceMeters * 10) / 10,
    outline,
  };
}
