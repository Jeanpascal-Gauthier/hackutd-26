// Stub: writes a tiny hard-coded 2-floor building to shared/building.json.
// Replace with real floor-plan generation later.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Building } from "@firewatch/shared/types";

const OUT = fileURLToPath(new URL("../shared/building.json", import.meta.url));

const building: Building = {
  rooms: [
    { id: "7-hall", floor: 7, name: "Floor 7 Hallway", x: 0, z: 0, w: 20, d: 3 },
    { id: "7-break", floor: 7, name: "Floor 7 Break Room", x: 0, z: 3, w: 6, d: 5 },
    { id: "7-office", floor: 7, name: "Floor 7 Open Office", x: 6, z: 3, w: 14, d: 8 },
    { id: "8-hall", floor: 8, name: "Floor 8 Hallway", x: 0, z: 0, w: 20, d: 3 },
    { id: "8-conf", floor: 8, name: "Floor 8 Conference", x: 0, z: 3, w: 8, d: 6 },
    { id: "8-office", floor: 8, name: "Floor 8 Open Office", x: 8, z: 3, w: 12, d: 8 },
  ],
  links: [
    { a: "7-hall", b: "7-break", kind: "door", fireRated: false, closed: false },
    { a: "7-hall", b: "7-office", kind: "door", fireRated: true, closed: false },
    { a: "7-break", b: "7-office", kind: "wall", fireRated: false, closed: true },
    { a: "8-hall", b: "8-conf", kind: "door", fireRated: false, closed: false },
    { a: "8-hall", b: "8-office", kind: "door", fireRated: true, closed: false },
    { a: "8-conf", b: "8-office", kind: "wall", fireRated: false, closed: true },
  ],
  verticals: [
    { id: "stair-a", kind: "stair", floors: [7, 8], doorsClosed: true },
    { id: "elev-1", kind: "elevator", floors: [7, 8], doorsClosed: true },
  ],
};

writeFileSync(OUT, JSON.stringify(building, null, 2) + "\n");
console.log(`wrote ${OUT}`);
