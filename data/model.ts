// Deterministic synthetic building generator (no Math.random, no Date).
// Output 1: `Building` — exactly the agreed shape in shared/types.ts.
// Output 2: `BuildingMeta` — extra data the agreed schema has no field for
//           (sprinklers, door ratings, occupants, inspection records, demo notes).
//           Lives in data/ only; propose moving it into shared/ if other workspaces need it.
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

/** Fixed "today" of the scenario: inspection dates are never after it. */
export const RECORDS_AS_OF = "2026-11-07";
export const SYSTEMS = [
  "sprinkler",
  "fire-door",
  "fire-alarm",
  "smoke-damper",
  "stair-pressurization",
  "standpipe",
  "emergency-lighting",
  "elevator-recall",
] as const;
export const INSPECTION_STATUSES = ["ok", "overdue", "failed"] as const;

/**
 * One record from a building system that is normally kept apart from the others
 * (sprinkler contractor, door survey, BMS, alarm panel log...). FireSight joins them.
 */
export interface InspectionRecord {
  id: string;
  system: (typeof SYSTEMS)[number];
  /** Room id (e.g. "7-break", "7-stair-b", "4-hall") or vertical id (e.g. "stair-a"). */
  location: string;
  /** ISO date (YYYY-MM-DD), never after RECORDS_AS_OF. */
  lastInspected: string;
  status: (typeof INSPECTION_STATUSES)[number];
  /** The separate system of record this comes from. */
  source: string;
  note: string;
}

export interface DoorMeta {
  a: string;
  b: string;
  /** Minutes of fire resistance; 0 = ordinary door. Non-zero iff Link.fireRated. */
  ratingMinutes: number;
}

export interface BuildingMeta {
  seed: number;
  floors: number;
  doors: DoorMeta[];
  sprinklers: Record<string, SprinklerStatus>; // room id -> status
  occupants: Occupant[]; // shared Occupant type, one entry per occupied room
  recordsAsOf: string; // ISO date the inspection records were pulled
  inspections: InspectionRecord[];
  demo: {
    origin: string;
    fireStartMinute: number;
    notes: string[];
  };
}

export const roomId = (floor: number, name: string) => `${floor}-${name}`;

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

  const meta: BuildingMeta = {
    seed: SEED,
    floors: FLOORS,
    doors,
    sprinklers,
    occupants,
    recordsAsOf: RECORDS_AS_OF,
    inspections: inspectionRecords(),
    demo: {
      origin: "7-break",
      fireStartMinute: 0,
      notes: [
        "Fire starts in 7-break: ordinary (unrated) door, open, sprinkler impaired.",
        "7-hall connects to 7-stair-b through a 60-min rated door that is propped OPEN (link.closed=false; verticals[stair-b].doorsClosed=false). Smoke enters stair B, rises and pools at the top: stair B is smoke-logged on floors 7-12 by about minute 11-17.",
        "Stair A and the elevator have rated doors that are closed (link.closed=true, doorsClosed=true): they stay smoke-free until a door is opened or a rating (60 min) is exceeded.",
        "Evening, about 7 pm: 9 people on floor 7 and 40 on floors 8-12 (mobility-limited occupants in 8-west and 10-east, a child in 11-west). Floors 1-6 are lightly occupied.",
        "10-east holds 6 occupants including a mobility-limited person; their nearest stair (B) fills with smoke, so they must use stair A.",
        "Inspection records explain the failure chain: 7-break's sprinkler branch valve was closed for a renovation in March 2026 and never reopened (quarterly checks overdue since); stair B's floor-7 door was reported wedged open on 2026-10-21 with no work order; stair B's pressurization fan missed its October 2026 annual test. Stair A's doors, pressurization and standpipe are all current.",
      ],
    },
  };

  return { building: { rooms, links, verticals }, meta };
}

/** Inspection and maintenance records, consistent with the generated building and the demo story. */
function inspectionRecords(): InspectionRecord[] {
  const recs: InspectionRecord[] = [];
  const add = (
    system: InspectionRecord["system"],
    location: string,
    lastInspected: string,
    status: InspectionRecord["status"],
    source: string,
    note: string,
  ) => recs.push({ id: `insp-${String(recs.length + 1).padStart(3, "0")}`, system, location, lastInspected, status, source, note });
  const sprinklerLog = "Sprinkler contractor log";
  const doorSurvey = "Fire door survey";
  const bms = "Building management system";
  const alarmLog = "Fire alarm panel log";
  const workOrders = "Facilities work orders";

  // Quarterly sprinkler checks, one zone per floor (zone control valve at the hallway riser).
  for (let f = 1; f <= FLOORS; f++) {
    if (f === DEMO_FLOOR) {
      add("sprinkler", roomId(f, "hall"), "2026-03-12", "overdue", sprinklerLog,
        "Floor 7 zone: Q2 and Q3 quarterly checks skipped while the break-room renovation was open; due since 2026-06-12.");
    } else {
      add("sprinkler", roomId(f, "hall"), `2026-09-${String(8 + f).padStart(2, "0")}`, "ok", sprinklerLog,
        `Floor ${f} zone: quarterly check passed, control valve open and sealed.`);
    }
  }
  add("sprinkler", "7-break", "2026-03-12", "overdue", sprinklerLog,
    "Branch valve closed for ceiling work (renovation permit 2026-03-12); impairment tag never cleared, room unprotected since. Quarterly check overdue since 2026-06-12.");

  // Fire doors: annual survey of every shaft door, then a later patrol finding on stair B.
  add("fire-door", "stair-a", "2026-08-20", "ok", doorSurvey, "All 12 stair A doors (60 min) self-close and latch.");
  add("fire-door", "stair-b", "2026-08-20", "ok", doorSurvey, "All 12 stair B doors (60 min) self-close and latch at survey time.");
  add("fire-door", roomId(DEMO_FLOOR, "stair-b"), "2026-10-21", "failed", "Security patrol report",
    "Floor 7 stair B door found wedged open, closer arm disconnected. Reported; no work order raised.");
  add("fire-door", "elev-1", "2026-08-20", "ok", doorSurvey, "Elevator lobby doors (60 min) close and latch on all floors.");

  // Stair pressurization keeps smoke out of a stair while its doors are shut.
  add("stair-pressurization", "stair-a", "2026-05-18", "ok", bms, "Annual fan test passed: 50 Pa across closed doors.");
  add("stair-pressurization", "stair-b", "2025-10-02", "overdue", bms,
    "Annual fan test due 2026-10-02 not done; fan left on manual after a controller swap, will not start on alarm.");

  // Alarm, standpipes, lighting, elevator recall, smoke dampers.
  add("fire-alarm", "1-hall", "2026-06-30", "ok", alarmLog, "Annual panel test passed; monitoring link verified.");
  add("fire-alarm", roomId(DEMO_FLOOR, "hall"), "2026-06-30", "ok", alarmLog, "Floor 7 detectors and pull station tested.");
  add("standpipe", "stair-a", "2026-04-09", "ok", sprinklerLog, "Hose valve on every landing tested; crews connect here.");
  add("standpipe", "stair-b", "2026-04-09", "ok", sprinklerLog, "Hose valve on every landing tested.");
  add("emergency-lighting", "stair-a", "2026-10-01", "ok", workOrders, "Monthly 30-second test passed on all landings.");
  add("emergency-lighting", "stair-b", "2026-10-01", "ok", workOrders, "Monthly 30-second test passed on all landings.");
  add("elevator-recall", ELEVATOR, "2026-07-15", "ok", "Elevator contractor log", "Phase I recall to floor 1 on alarm verified.");
  add("smoke-damper", "4-hall", "2025-08-11", "overdue", bms, "Hallway smoke damper missed its annual cycle test (due 2026-08-11).");
  add("smoke-damper", roomId(DEMO_FLOOR, "hall"), "2026-02-03", "ok", bms, "Hallway smoke damper cycled; closes on alarm.");
  add("smoke-damper", "10-hall", "2026-02-03", "ok", bms, "Hallway smoke damper cycled; closes on alarm.");

  return recs;
}
