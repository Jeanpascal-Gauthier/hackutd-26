// Deterministic synthetic building generator (no Math.random, no Date).
// Output 1: `Building` — exactly the agreed shape in shared/types.ts.
// Output 2: `BuildingMeta` — extra data the agreed schema has no field for
//           (sprinklers, door ratings, occupants, inspection records, demo notes). Lives in data/
//           only; propose moving it into shared/ if other workspaces need it.
import type { Building, Link, Occupant, Room, Vertical } from "@firewatch/shared/types";

export const FLOORS = 12;
export const HALL_W = 30; // metres
export const HALL_D = 3;
export const ROOM_D = 8;
const SEED = 26;
/** Floor of the demo fire (7-break); stair B's door is propped open here. */
const DEMO_FLOOR = 7;
/**
 * Evening (about 7 pm) on the fire floor and above, fixed so the pitch numbers hold:
 * 9 people on floor 7, 40 on floors 8-12. Floors below 7 come from the seeded rng.
 */
const DEMO_OCCUPANTS: [room: string, count: number, flags: string[]][] = [
  ["7-break", 3, []],
  ["7-east", 2, []],
  ["7-office", 4, []],
  ["8-west", 1, ["mobility"]],
  ["8-office", 5, []],
  ["8-conf", 4, []],
  ["9-east", 2, []],
  ["9-office", 3, []],
  ["10-break", 2, []],
  ["10-east", 6, ["mobility"]],
  ["10-conf", 3, []],
  ["11-west", 2, ["child"]],
  ["11-office", 6, []],
  ["12-east", 3, []],
  ["12-office", 3, []],
];

/** Room name slots in priority order. Every floor has the first 4..6. */
const ROOM_SLOTS: [string, string][] = [
  ["break", "Break Room"],
  ["east", "East Office"],
  ["west", "West Office"],
  ["office", "Open Office"],
  ["conf", "Conference"],
  ["storage", "Storage"],
];

/** Stairwell/elevator "rooms" are real Rooms so links can reference them. */
export const STAIRS = ["stair-a", "stair-b"] as const;
export const ELEVATOR = "elev-1";
export const SHAFTS = [...STAIRS, ELEVATOR];

export type SprinklerStatus = "active" | "impaired" | "none";
export const FLAGS = ["mobility", "child"] as const;

export interface DoorMeta {
  a: string;
  b: string;
  /** Minutes of fire resistance; 0 = ordinary door. Non-zero iff Link.fireRated. */
  ratingMinutes: number;
}

export const INSPECTION_SYSTEMS = ["sprinkler", "fire-door", "fire-alarm", "standpipe"] as const;
export type InspectionSystem = (typeof INSPECTION_SYSTEMS)[number];
export const INSPECTION_STATUSES = ["pass", "overdue", "deficient"] as const;
export type InspectionStatus = (typeof INSPECTION_STATUSES)[number];
/** Records are "as of" this fixed date (no clock reads, so output stays deterministic). */
export const INSPECTION_AS_OF = "2026-11-07";
/** Every system here is on an annual inspection cycle (NFPA 25 / 80 / 72). */
export const INSPECTION_INTERVAL_DAYS = 365;

export interface InspectionRecord {
  /** `${system}:${target}`, unique. */
  id: string;
  system: InspectionSystem;
  /** Room id (sprinkler), "a|b" door id as in `doors` (fire-door), or "floor-N" (fire-alarm, standpipe). */
  target: string;
  floor: number;
  lastInspected: string; // ISO date, YYYY-MM-DD
  nextDue: string; // ISO date, lastInspected + INSPECTION_INTERVAL_DAYS
  /** pass: in date, no finding. overdue: nextDue before INSPECTION_AS_OF. deficient: open finding. */
  status: InspectionStatus;
  finding?: string;
}

export interface BuildingMeta {
  seed: number;
  floors: number;
  doors: DoorMeta[];
  sprinklers: Record<string, SprinklerStatus>; // room id -> status
  occupants: Occupant[]; // shared Occupant type, one entry per occupied room
  /** Sprinklers (rooms that have one), fire-rated doors, one fire alarm + one standpipe per floor. */
  inspections: InspectionRecord[];
  demo: {
    origin: string;
    fireStartMinute: number;
    notes: string[];
  };
}

export const roomId = (floor: number, name: string) => `${floor}-${name}`;
export const doorId = (d: { a: string; b: string }) => `${d.a}|${d.b}`;

// Pure civil-date arithmetic (days since 1970-01-01), so no Date object is involved.
export function daysFromIso(iso: string): number {
  let [y, m, d] = iso.split("-").map(Number);
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  return era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468;
}
export function isoFromDays(days: number): string {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function rng(seed: number) {
  // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generate(): { building: Building; meta: BuildingMeta } {
  const rand = rng(SEED);
  const rooms: Room[] = [];
  const links: Link[] = [];
  const doors: DoorMeta[] = [];
  const sprinklers: Record<string, SprinklerStatus> = {};
  const occupants: Occupant[] = [];

  const addLink = (a: string, b: string, kind: Link["kind"], ratingMinutes: number, closed: boolean) => {
    links.push({ a, b, kind, fireRated: ratingMinutes > 0, closed });
    if (kind === "door") doors.push({ a, b, ratingMinutes });
  };

  for (let f = 1; f <= FLOORS; f++) {
    const hall = roomId(f, "hall");
    rooms.push({ id: hall, floor: f, name: `Floor ${f} Hallway`, x: 0, z: 0, w: HALL_W, d: HALL_D });
    sprinklers[hall] = "active";

    // Rooms: 4, 5, 6, 4, ... per floor, evenly sharing the hallway length.
    const n = 4 + (f % 3);
    const w = HALL_W / n;
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const [key, label] = ROOM_SLOTS[i];
      const id = roomId(f, key);
      ids.push(id);
      rooms.push({ id, floor: f, name: `Floor ${f} ${label}`, x: i * w, z: HALL_D, w, d: ROOM_D });
      sprinklers[id] = "active";

      // Hall door. Break rooms have an ordinary door that stands open; every other
      // room has a rated door that is kept shut (as fire code expects).
      addLink(hall, id, "door", key === "break" ? 0 : 20, key !== "break");

      // Evening: most rooms are empty, the rest hold 1-4 people.
      const count = key === "storage" || rand() < 0.6 ? 0 : Math.floor(rand() * 4) + 1;
      const flags = FLAGS.filter(() => count > 0 && rand() < 0.05);
      if (count > 0) occupants.push({ room: id, count, flags: [...flags] });
    }
    // Neighbouring rooms share a (closed) wall.
    for (let i = 0; i + 1 < n; i++) addLink(ids[i], ids[i + 1], "wall", 0, true);

    // Shafts: stair A west end, stair B east end, elevator north of the hall.
    const shaftBox: Record<string, [number, number, number, number]> = {
      "stair-a": [-4, 0, 4, HALL_D],
      "stair-b": [HALL_W, 0, 4, HALL_D],
      [ELEVATOR]: [HALL_W / 2 - 1.5, -3, 3, 3],
    };
    for (const s of SHAFTS) {
      const [x, z, sw, sd] = shaftBox[s];
      const id = roomId(f, s);
      const label = s === ELEVATOR ? "Elevator" : `Stairwell ${s.slice(-1).toUpperCase()}`;
      rooms.push({ id, floor: f, name: `Floor ${f} ${label}`, x, z, w: sw, d: sd });
      sprinklers[id] = "none";
      // All shaft doors are 60-min rated and closed, except stair B on the demo
      // fire floor (see demo notes): rated, but propped open.
      const propped = s === "stair-b" && f === DEMO_FLOOR;
      addLink(hall, id, "door", 60, !propped);
    }
  }

  // Demo overrides: fixed, readable story from the fire floor up.
  sprinklers["7-break"] = "impaired";
  const below = occupants.filter((o) => Number.parseInt(o.room) < DEMO_FLOOR);
  occupants.length = 0;
  occupants.push(...below, ...DEMO_OCCUPANTS.map(([room, count, flags]) => ({ room, count, flags: [...flags] })));

  const verticals: Vertical[] = SHAFTS.map((id) => ({
    id,
    kind: id === ELEVATOR ? "elevator" : "stair",
    floors: [1, FLOORS],
    // Stair B: a door is propped open (floor 7) => smoke can enter the shaft.
    doorsClosed: id !== "stair-b",
  }));

  occupants.sort((a, b) => a.room.localeCompare(b.room, "en", { numeric: true }));

  const inspections = inspectionRecords(rooms, doors, sprinklers);

  const meta: BuildingMeta = {
    seed: SEED,
    floors: FLOORS,
    doors,
    sprinklers,
    occupants,
    inspections,
    demo: {
      origin: "7-break",
      fireStartMinute: 0,
      notes: [
        "Fire starts in 7-break: ordinary (unrated) door, open, sprinkler impaired.",
        "7-hall connects to 7-stair-b through a 60-min rated door that is propped OPEN (link.closed=false; verticals[stair-b].doorsClosed=false). Smoke enters stair B, rises and pools at the top: stair B is smoke-logged on floors 7-12 by about minute 11-17.",
        "Stair A and the elevator have rated doors that are closed (link.closed=true, doorsClosed=true): they stay smoke-free until a door is opened or a rating (60 min) is exceeded.",
        "10-east holds 6 occupants including a mobility-limited person; their nearest stair (B) fills with smoke, so they must use stair A.",
        "Evening, about 7 pm: 9 people on floor 7 and 40 on floors 8-12 (mobility-limited occupants in 8-west and 10-east, a child in 11-west). Floors 1-6 are lightly occupied.",
        "Inspection records tell the same story: the 7-break sprinkler is deficient (obstructed head, repair ticket open) and its annual inspection is overdue; the 7-hall|7-stair-b 60-min door is deficient (found propped open).",
      ],
    },
  };

  return { building: { rooms, links, verticals }, meta };
}

/**
 * Fixed findings: the demo story plus a few ordinary overdue/deficient items, keyed by record
 * id. Each pins the status and lastInspected (days before INSPECTION_AS_OF).
 */
const INSPECTION_OVERRIDES: Record<string, { status: InspectionStatus; daysAgo: number; finding?: string }> = {
  // Demo: matches sprinklers["7-break"] = "impaired".
  "sprinkler:7-break": {
    status: "deficient",
    daysAgo: 421,
    finding: "Sprinkler head obstructed; repair ticket open. Annual inspection overdue.",
  },
  // Demo: matches the propped-open 7-hall <-> 7-stair-b link (fireRated, closed=false).
  "fire-door:7-hall|7-stair-b": {
    status: "deficient",
    daysAgo: 17,
    finding: "Door found propped open (hold-open device not released to fire alarm)",
  },
  "sprinkler:9-office": { status: "overdue", daysAgo: 402 },
  "sprinkler:5-storage": {
    status: "deficient",
    daysAgo: 64,
    finding: "Stored boxes within 18 in. of sprinkler deflectors; clearance not restored",
  },
  "fire-door:11-hall|11-conf": { status: "overdue", daysAgo: 389 },
  "fire-alarm:floor-4": { status: "overdue", daysAgo: 377 },
  "standpipe:floor-12": { status: "overdue", daysAgo: 455 },
};

/**
 * Inspection records, floor by floor: sprinklers (rooms that have one), fire-rated doors,
 * then one fire alarm and one standpipe. Dates come from their own rng, so the main
 * generator's draws (occupants) are unaffected.
 */
function inspectionRecords(rooms: Room[], doors: DoorMeta[], sprinklers: Record<string, SprinklerStatus>): InspectionRecord[] {
  const rand = rng(SEED * 7919 + 1);
  const asOf = daysFromIso(INSPECTION_AS_OF);
  const floorOf = new Map(rooms.map((r) => [r.id, r.floor]));
  const out: InspectionRecord[] = [];
  const add = (system: InspectionSystem, target: string, floor: number) => {
    const id = `${system}:${target}`;
    // Always draw, so an override never shifts the dates of later records.
    const drawn = 15 + Math.floor(rand() * 320); // 15..334 days ago: in date
    const o = INSPECTION_OVERRIDES[id];
    const last = asOf - (o ? o.daysAgo : drawn);
    out.push({
      id,
      system,
      target,
      floor,
      lastInspected: isoFromDays(last),
      nextDue: isoFromDays(last + INSPECTION_INTERVAL_DAYS),
      status: o ? o.status : "pass",
      ...(o?.finding ? { finding: o.finding } : {}),
    });
  };
  for (let f = 1; f <= FLOORS; f++) {
    for (const r of rooms) if (r.floor === f && sprinklers[r.id] !== "none") add("sprinkler", r.id, f);
    for (const d of doors) if (d.ratingMinutes > 0 && floorOf.get(d.a) === f) add("fire-door", doorId(d), f);
    add("fire-alarm", `floor-${f}`, f);
    add("standpipe", `floor-${f}`, f);
  }
  return out;
}
