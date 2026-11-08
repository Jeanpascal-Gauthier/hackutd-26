// Occupancy estimate for a building with no occupant records (one generated from an address):
// people per room = capacity (floor area x room kind) x share in use x presence (building use x
// local hour x weekday/weekend). Deterministic and explainable: same building + same time ->
// same numbers, and `basis` says in plain words how they were made. Pure: no I/O.
//
// The server calls estimateOccupancy() in-process when it activates a building (agent trail
// step estimate_occupancy). Figures are planning-style rules of thumb (occupant load factors as
// in building codes, office-utilisation and time-use surveys), not counts: a first guess for
// crews, always marked estimated.
import type { Building, Occupant, Room, RoomKind } from "@firewatch/shared/types";
import { inferKind } from "./rooms.ts";

export interface OccupancyEstimate {
  occupants: Occupant[];
  total: number;
  /** Floor number (as a string) -> people. Every floor that has rooms, 0 included. */
  byFloor: Record<string, number>;
  /** Local time the estimate is for, e.g. "Sun 1:20 AM". */
  localTime: string;
  /** 2-4 plain-language lines explaining the numbers, for the console and the agent trail. */
  basis: string[];
}

// ---- Capacity: people in a room when it is fully in use ----

interface Capacity {
  /** Floor area per person (m²). */
  sqmPerPerson?: number;
  /** Or a fixed number of people per room (homes, hotel rooms, patient rooms). */
  perRoom?: number;
  /** Share of the time the room is in use while the building is (meeting rooms sit empty a lot). */
  inUse?: number;
  /** Plural label for the basis text. */
  label: string;
}

const CAPACITY: Record<RoomKind, Capacity> = {
  office: { sqmPerPerson: 10, label: "offices" }, // private offices
  "open-office": { sqmPerPerson: 7, label: "open offices" }, // desks in open plan
  conference: { sqmPerPerson: 2.5, inUse: 0.4, label: "conference rooms" }, // booked ~40% of the day
  break: { sqmPerPerson: 3, inUse: 0.25, label: "break rooms" },
  classroom: { sqmPerPerson: 2, label: "classrooms" },
  lab: { sqmPerPerson: 5, label: "labs" },
  retail: { sqmPerPerson: 6, label: "shops" },
  dining: { sqmPerPerson: 3, inUse: 0.5, label: "dining rooms" },
  assembly: { sqmPerPerson: 1.5, inUse: 0.3, label: "assembly rooms" }, // events, not all day
  lobby: { sqmPerPerson: 25, label: "lobbies" },
  residential: { perRoom: 2.4, label: "apartments" }, // average household size
  "hotel-room": { perRoom: 1.6, label: "hotel rooms" },
  patient: { perRoom: 1.5, label: "patient rooms" }, // patient plus visitor/staff share
  // Nobody is counted in these.
  hall: { label: "halls" },
  stair: { label: "stairwells" },
  elevator: { label: "elevators" },
  storage: { label: "storage rooms" },
  utility: { label: "utility rooms" },
};

// ---- Presence: share of capacity actually there, by local hour ----

/** [from hour, share] steps: the share holds from that hour until the next step. */
type Steps = [number, number][];

interface Curve {
  /** Plural label for the basis text: "offices at about 3% of capacity". */
  label: string;
  weekday: Steps;
  weekend: Steps;
}

type CurveKey = "office" | "residential" | "school" | "university" | "hospital" | "hotel" | "retail";

const CURVES: Record<CurveKey, Curve> = {
  // Weekday 9-17 about 80% (desk-utilisation studies), evenings low, nights a few cleaners/late workers.
  office: {
    label: "offices",
    weekday: [[0, 0.03], [7, 0.3], [8, 0.6], [9, 0.8], [17, 0.5], [18, 0.25], [19, 0.12], [22, 0.05]],
    weekend: [[0, 0.03], [9, 0.08], [17, 0.05], [21, 0.03]],
  },
  // Most people home at night; on weekdays many are at work or school.
  residential: {
    label: "homes",
    weekday: [[0, 0.9], [7, 0.7], [8, 0.5], [9, 0.4], [17, 0.55], [18, 0.7], [23, 0.9]],
    weekend: [[0, 0.9], [8, 0.75], [10, 0.6], [17, 0.7], [23, 0.9]],
  },
  // Class hours only.
  school: {
    label: "classrooms",
    weekday: [[0, 0], [7, 0.3], [8, 0.9], [15, 0.3], [16, 0.1], [18, 0]],
    weekend: [[0, 0]],
  },
  // Wider hours: evening classes, libraries, labs.
  university: {
    label: "campus rooms",
    weekday: [[0, 0.02], [7, 0.2], [8, 0.7], [18, 0.35], [22, 0.1], [23, 0.02]],
    weekend: [[0, 0.02], [10, 0.2], [18, 0.05], [23, 0.02]],
  },
  // Inpatients and staff around the clock.
  hospital: { label: "hospital rooms", weekday: [[0, 0.85]], weekend: [[0, 0.85]] },
  // Guests sleep in; out during the day.
  hotel: {
    label: "hotel rooms",
    weekday: [[0, 0.8], [7, 0.6], [9, 0.3], [17, 0.45], [19, 0.6], [23, 0.8]],
    weekend: [[0, 0.8], [8, 0.65], [10, 0.35], [17, 0.5], [19, 0.6], [23, 0.8]],
  },
  // Opening hours 10-21; staff an hour either side.
  retail: {
    label: "shops and shared rooms",
    weekday: [[0, 0], [9, 0.15], [10, 0.6], [21, 0.15], [22, 0]],
    weekend: [[0, 0], [9, 0.15], [10, 0.75], [21, 0.15], [22, 0]],
  },
};

const shareAt = (steps: Steps, hour: number) => steps.reduce((v, [from, share]) => (hour >= from ? share : v), 0);

// ---- Building use ----

type UseClass = CurveKey | "mixed";

/** BuildingProfile.use (or an OSM building tag) -> one of the curves. Unknown uses count as offices. */
function useClass(use: string): { cls: UseClass; known: boolean } {
  const u = use.toLowerCase().trim();
  if (/^(office|commercial|government|civic|industrial|warehouse)$/.test(u)) return { cls: "office", known: true };
  if (/^(residential|apartments?|house|detached|terrace|dormitory|condo\w*)$/.test(u)) return { cls: "residential", known: true };
  if (/^(school|kindergarten)$/.test(u)) return { cls: "school", known: true };
  if (/^(university|college)$/.test(u)) return { cls: "university", known: true };
  if (/^(hospital|clinic)$/.test(u)) return { cls: "hospital", known: true };
  if (/^(hotel|motel)$/.test(u)) return { cls: "hotel", known: true };
  if (/^(retail|supermarket|mall|shop)$/.test(u)) return { cls: "retail", known: true };
  if (/^mixed/.test(u)) return { cls: "mixed", known: true };
  return { cls: "office", known: false };
}

const USE_LABEL: Record<UseClass, string> = {
  office: "Office",
  residential: "Residential",
  school: "School",
  university: "University",
  hospital: "Hospital",
  hotel: "Hotel",
  retail: "Retail",
  mixed: "Mixed-use",
};

/** A room whose kind says nothing (no kind, no telling name) gets the building's main room kind. */
const DEFAULT_KIND: Record<UseClass, RoomKind> = {
  office: "office",
  residential: "residential",
  school: "classroom",
  university: "classroom",
  hospital: "patient",
  hotel: "hotel-room",
  retail: "retail",
  mixed: "office",
};

/** Which presence curve a room follows: homes, hotel and patient rooms and shops keep their own hours. */
function curveFor(kind: RoomKind, cls: UseClass): CurveKey {
  if (kind === "residential") return "residential";
  if (kind === "hotel-room") return "hotel";
  if (kind === "patient") return "hospital";
  if (kind === "retail") return "retail";
  if (cls === "mixed") return "office";
  // Lobbies, lounges and dining in homes and hotels are used in the day and evening, not at night.
  if (cls === "residential" || cls === "hotel") return "retail";
  return cls;
}

// ---- Local time ----

interface Clock {
  hour: number; // 0-23
  weekend: boolean;
  weekday: string; // "Sunday"
  /** "Sun 1:20 AM" */
  short: string;
  /** "1:20 AM" */
  time: string;
  timeZone: string;
  /** False when the building's time zone was missing or invalid and the server's was used. */
  buildingZone: boolean;
}

function clockAt(at: number, timeZone?: string): Clock {
  let zone = timeZone;
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long", hour: "numeric", minute: "2-digit", hourCycle: "h23" });
  } catch {
    zone = undefined; // unknown IANA name
    fmt = new Intl.DateTimeFormat("en-US", { weekday: "long", hour: "numeric", minute: "2-digit", hourCycle: "h23" });
  }
  const parts = Object.fromEntries(fmt.formatToParts(new Date(at)).map((p) => [p.type, p.value]));
  const hour = Number(parts.hour) % 24;
  const minute = parts.minute ?? "00";
  const weekday = parts.weekday ?? "Monday";
  const time = `${hour % 12 || 12}:${minute} ${hour < 12 ? "AM" : "PM"}`;
  return {
    hour,
    weekend: weekday === "Saturday" || weekday === "Sunday",
    weekday,
    short: `${weekday.slice(0, 3)} ${time}`,
    time,
    timeZone: fmt.resolvedOptions().timeZone,
    buildingZone: zone !== undefined,
  };
}

/** Residential and hotel rooms count as asleep from 23:00 to 07:00 local. */
const isNight = (hour: number) => hour >= 23 || hour < 7;

// ---- The estimate ----

interface RoomEstimate {
  room: Room;
  kind: RoomKind;
  curve: CurveKey;
  /** People when fully in use (area x density x share in use). */
  capacity: number;
  presence: number;
  expected: number;
  flags: string[];
}

const pct = (share: number) => `${Math.round(share * 100)}%`;
const fmtNum = (n: number) => (Number.isInteger(n) ? `${n}` : n.toFixed(1));

function densityText(kind: RoomKind): string {
  const c = CAPACITY[kind];
  const base = c.perRoom !== undefined ? `${fmtNum(c.perRoom)} people each` : `1 per ${fmtNum(c.sqmPerPerson!)} m²`;
  return `${c.label} ${base}${c.inUse !== undefined ? `, in use ${pct(c.inUse)} of the time` : ""}`;
}

/**
 * Splits `target` people over rooms in proportion to their expected counts (largest remainder,
 * ties to the earlier room), so small rooms don't all round to 0 and the total stays honest.
 */
function apportion(expected: number[], target: number): number[] {
  const counts = expected.map(Math.floor);
  let left = target - counts.reduce((a, b) => a + b, 0);
  const order = expected.map((e, i) => ({ i, frac: e - Math.floor(e) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i, frac } of order) {
    if (left <= 0) break;
    if (frac <= 0) continue;
    counts[i]!++;
    left--;
  }
  return counts;
}

/**
 * Estimated occupants of every room at `at` (epoch ms): room kind (`room.kind`, else read from its
 * id/name) x building use (`profile.use`, default office) x local time (`profile.timezone`, else
 * the server's). Integers; rooms with nobody are left out; every occupant has `estimated: true`.
 * Flags: "mobility" (patient rooms), "child" (school classrooms), "sleeping" (homes and hotel
 * rooms, 23:00-07:00).
 */
export function estimateOccupancy(building: Building, at: number): OccupancyEstimate {
  const profile = building.profile;
  const { cls, known } = useClass(profile?.use ?? "office");
  const clock = clockAt(at, profile?.timezone);
  let inferred = 0;

  const rooms: RoomEstimate[] = building.rooms.map((room) => {
    const read = inferKind(room);
    if (!room.kind) inferred++;
    const kind = read ?? DEFAULT_KIND[cls];
    const cap = CAPACITY[kind];
    const area = Math.max(0, room.w) * Math.max(0, room.d);
    const full = cap.perRoom ?? (cap.sqmPerPerson ? area / cap.sqmPerPerson : 0);
    const capacity = full * (cap.inUse ?? 1);
    const curve = curveFor(kind, cls);
    const c = CURVES[curve];
    const presence = shareAt(clock.weekend ? c.weekend : c.weekday, clock.hour);
    const flags: string[] = [];
    if (kind === "patient") flags.push("mobility");
    if (kind === "classroom" && cls === "school") flags.push("child");
    if ((kind === "residential" || kind === "hotel-room") && isNight(clock.hour)) flags.push("sleeping");
    return { room, kind, curve, capacity, presence, expected: capacity * presence, flags };
  });

  const expectedTotal = rooms.reduce((n, r) => n + r.expected, 0);
  const counts = apportion(rooms.map((r) => r.expected), Math.round(expectedTotal));

  const occupants: Occupant[] = [];
  const byFloor: Record<string, number> = {};
  for (const f of [...new Set(building.rooms.map((r) => r.floor))].sort((a, b) => a - b)) byFloor[String(f)] = 0;
  const flagged = new Map<string, number>();
  rooms.forEach((r, i) => {
    const count = counts[i]!;
    if (count <= 0) return;
    occupants.push({ room: r.room.id, count, flags: r.flags, estimated: true });
    byFloor[String(r.room.floor)] = (byFloor[String(r.room.floor)] ?? 0) + count;
    for (const f of r.flags) flagged.set(f, (flagged.get(f) ?? 0) + count);
  });
  const total = occupants.reduce((n, o) => n + o.count, 0);

  // ---- basis: what was assumed, in words ----
  const basis: string[] = [];
  const useText = known ? `${USE_LABEL[cls]} building` : `Building of unknown use ("${profile?.use}", counted as offices)`;
  const when = clock.buildingZone
    ? `${clock.weekday} ${clock.time} local time`
    : `${clock.weekday} ${clock.time} server time (${clock.timeZone}; the building's time zone is unknown)`;
  const capacityBy = (key: (r: RoomEstimate) => string) => {
    const m = new Map<string, number>();
    for (const r of rooms) if (r.capacity > 0) m.set(key(r), (m.get(key(r)) ?? 0) + r.capacity);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const curves = capacityBy((r) => r.curve).slice(0, 3);
  const presenceOf = (key: CurveKey) => rooms.find((r) => r.curve === key)!.presence;
  basis.push(
    curves.length
      ? `${useText}, ${when}: ${curves.map(([k]) => `${CURVES[k as CurveKey].label} at about ${pct(presenceOf(k as CurveKey))} of capacity`).join("; ")}.`
      : `${useText}, ${when}: no rooms where people would be.`,
  );

  const fullCapacity = Math.round(rooms.reduce((n, r) => n + r.capacity, 0));
  const kinds = capacityBy((r) => r.kind).slice(0, 3);
  if (kinds.length) {
    basis.push(
      `Capacity from floor area and room type: about ${fullCapacity} people when full (${kinds.map(([k]) => densityText(k as RoomKind)).join("; ")}).`,
    );
  }

  const occupiedFloors = Object.values(byFloor).filter((n) => n > 0).length;
  basis.push(
    `Estimate: ${total} ${total === 1 ? "person" : "people"} in ${occupants.length} ${occupants.length === 1 ? "room" : "rooms"} on ` +
      `${occupiedFloors} ${occupiedFloors === 1 ? "floor" : "floors"}; halls, stairs, elevators, storage and utility rooms count as empty.` +
      (inferred ? ` Room types${inferred < building.rooms.length ? " not given were" : " were"} read from room names.` : ""),
  );

  const flagText: string[] = [];
  if (flagged.get("mobility")) flagText.push(`${flagged.get("mobility")} in patient rooms flagged mobility`);
  if (flagged.get("child")) flagText.push(`${flagged.get("child")} in classrooms flagged child`);
  if (flagged.get("sleeping")) flagText.push(`${flagged.get("sleeping")} flagged sleeping (homes and hotel rooms, 11 PM to 7 AM)`);
  if (flagText.length) basis.push(`${flagText.join("; ")}.`.replace(/^./, (c) => c.toUpperCase()));

  return { occupants, total, byFloor, localTime: clock.short, basis };
}
