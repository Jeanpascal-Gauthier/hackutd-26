// Test helper: a small building like the ones the server generates from an address (rooms with
// `kind`, a profile, the demo's id conventions: "<floor>-hall", "<floor>-stair-a", ...).
import type { Building, BuildingProfile, Link, Room, RoomKind } from "@firewatch/shared/types";

export interface SyntheticOptions {
  name?: string;
  address?: string;
  use?: string;
  floors?: number;
  timezone?: string;
  /** Rooms on every floor: [id suffix, name, kind, width, depth]. */
  rooms?: [string, string, RoomKind, number, number][];
}

const DEFAULT_ROOMS: [string, string, RoomKind, number, number][] = [
  ["office-1", "Office 1", "office", 10, 10],
  ["office-2", "Office 2", "office", 10, 10],
  ["open", "Open Office", "open-office", 14, 10],
];

export function syntheticBuilding(opts: SyntheticOptions = {}): Building {
  const floors = opts.floors ?? 4;
  const kinds = opts.rooms ?? DEFAULT_ROOMS;
  const rooms: Room[] = [];
  const links: Link[] = [];
  for (let f = 1; f <= floors; f++) {
    const fixed: [string, string, RoomKind, number, number, number][] = [
      ["hall", "Hallway", "hall", 0, 34, 3],
      ["stair-a", "Stairwell A", "stair", -4, 4, 3],
      ["stair-b", "Stairwell B", "stair", 34, 4, 3],
      ["elev-1", "Elevator", "elevator", 15, 3, 3],
    ];
    for (const [suffix, name, kind, x, w, d] of fixed) {
      rooms.push({ id: `${f}-${suffix}`, floor: f, name: `Floor ${f} ${name}`, x, z: 0, w, d, kind });
    }
    let x = 0;
    for (const [suffix, name, kind, w, d] of kinds) {
      rooms.push({ id: `${f}-${suffix}`, floor: f, name: `Floor ${f} ${name}`, x, z: 3, w, d, kind });
      links.push({ a: `${f}-hall`, b: `${f}-${suffix}`, kind: "door", fireRated: false, closed: false });
      x += w;
    }
  }
  const profile: BuildingProfile = {
    id: "osm:way:123",
    name: opts.name ?? "Campbell Tower",
    address: opts.address ?? "800 W Campbell Rd, Richardson, TX 75080",
    source: "osm",
    use: opts.use ?? "office",
    floors,
    // Chicago unless the test sets one (or sets it to undefined: no time zone known).
    ...("timezone" in opts ? (opts.timezone ? { timezone: opts.timezone } : {}) : { timezone: "America/Chicago" }),
    layoutEstimated: true,
    assumptions: ["Rooms generated from the outline."],
  };
  return {
    rooms,
    links,
    verticals: [
      { id: "stair-a", kind: "stair", floors: [1, floors], doorsClosed: true },
      { id: "stair-b", kind: "stair", floors: [1, floors], doorsClosed: true },
      { id: "elev-1", kind: "elevator", floors: [1, floors], doorsClosed: true },
    ],
    profile,
  };
}
