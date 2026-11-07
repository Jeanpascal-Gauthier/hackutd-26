// Small two-floor fixture using the agreed Building schema (stand-in for shared/building.json).
import type { Building } from "@firewatch/shared/types";

const room = (id: string, floor: number) => ({ id, floor, name: id, x: 0, z: 0, w: 5, d: 5 });

export const fixtureBuilding: Building = {
  rooms: [
    room("7-hall", 7), room("7-break", 7), room("7-office", 7), room("7-island", 7),
    room("8-hall", 8), room("8-conf", 8),
  ],
  links: [
    { a: "7-break", b: "7-hall", kind: "door", fireRated: false, closed: false },
    { a: "7-hall", b: "7-office", kind: "door", fireRated: true, closed: true },
    { a: "8-hall", b: "8-conf", kind: "door", fireRated: false, closed: false },
  ],
  verticals: [{ id: "stair-a", kind: "stair", floors: [7, 8], doorsClosed: false }],
};
