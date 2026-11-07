// Deterministic synthetic building generator (no Math.random, no Date).
// Output 1: `Building` — exactly the agreed shape in shared/types.ts.
// Output 2: `BuildingMeta` — extra data the agreed schema has no field for
//           (sprinklers, door ratings, occupants, demo notes). Lives in data/
//           only; propose moving it into shared/ if other workspaces need it.
import type { Building, Link, Occupant, Room, Vertical } from "@firewatch/shared/types";

export const FLOORS = 12;
export const HALL_W = 30; // metres
export const HALL_D = 3;
export const ROOM_D = 8;
const SEED = 26;

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

export interface BuildingMeta {
  seed: number;
  floors: number;
  doors: DoorMeta[];
  sprinklers: Record<string, SprinklerStatus>; // room id -> status
  occupants: Occupant[]; // shared Occupant type, one entry per occupied room
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

      // Hall door. Break rooms have ordinary doors; everything else is rated.
      // Storage doors are kept shut.
      addLink(hall, id, "door", key === "break" ? 0 : 20, key === "storage");

      const count = key === "storage" ? 0 : Math.floor(rand() * 9) + 2;
      const flags = FLAGS.filter(() => count > 0 && rand() < 0.15);
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
      // All shaft doors are 60-min rated. Closed by default except stair B
      // (see demo notes): there the door is rated but propped open.
      const propped = s === "stair-b";
      addLink(hall, id, "door", 60, !propped);
    }
  }

  // Demo overrides: fixed, readable story on the two demo rooms.
  sprinklers["7-break"] = "impaired";
  const setOcc = (room: string, count: number, flags: string[]) => {
    const o = occupants.find((x) => x.room === room);
    if (o) Object.assign(o, { count, flags });
    else occupants.push({ room, count, flags });
  };
  setOcc("7-break", 3, []);
  setOcc("10-east", 6, ["mobility"]);

  const verticals: Vertical[] = SHAFTS.map((id) => ({
    id,
    kind: id === ELEVATOR ? "elevator" : "stair",
    floors: [1, FLOORS],
    // Stair B: doors propped open => smoke can enter the shaft.
    doorsClosed: id !== "stair-b",
  }));

  occupants.sort((a, b) => a.room.localeCompare(b.room, "en", { numeric: true }));

  const meta: BuildingMeta = {
    seed: SEED,
    floors: FLOORS,
    doors,
    sprinklers,
    occupants,
    demo: {
      origin: "7-break",
      fireStartMinute: 0,
      notes: [
        "Fire starts in 7-break: ordinary (unrated) door, open, sprinkler impaired.",
        "7-hall connects to 7-stair-b through a 60-min rated door that is propped OPEN (link.closed=false) and verticals[stair-b].doorsClosed=false: smoke enters stair B and rises to floors 8-12.",
        "Stair A and the elevator have rated doors that are closed (link.closed=true, doorsClosed=true): they stay smoke-free until a door is opened or a rating (60 min) is exceeded.",
        "10-east holds 6 occupants including a mobility-limited person; it is reached by smoke via 10-stair-b first.",
      ],
    },
  };

  return { building: { rooms, links, verticals }, meta };
}
