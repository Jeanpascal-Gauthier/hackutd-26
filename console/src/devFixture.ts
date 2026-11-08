// DEV ONLY. Local fixtures for checking generated-building rendering without the new server endpoints.
// Load with http://localhost:5173/?fixture=lookup (5-floor L-shaped building + a lookup waiting for
// confirmation) or ?fixture=tower (40 floors x 10 rooms). App only calls this when import.meta.env.DEV,
// and client events are not sent to the server while a fixture is shown.
import type { Building, BuildingCandidateSummary, IncidentState, Link, Occupant, Room, RoomKind } from "@firewatch/shared/types";

type Spec = [suffix: string, label: string, kind: RoomKind, x: number, z: number, w: number, d: number];

function generate(floors: number, plan: (floor: number) => Spec[]): Pick<Building, "rooms" | "links" | "verticals"> {
  const rooms: Room[] = [];
  const links: Link[] = [];
  for (let floor = 1; floor <= floors; floor++) {
    const level = plan(floor).map(([suffix, label, kind, x, z, w, d]): Room => ({ id: `${floor}-${suffix}`, floor, name: `Floor ${floor} ${label}`, kind, x, z, w, d }));
    const touches = (a: Room, b: Room) => {
      const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), overlapZ = Math.min(a.z + a.d, b.z + b.d) - Math.max(a.z, b.z);
      const near = (p: number, q: number) => Math.abs(p - q) < 1e-6;
      return (overlapX > 1 && (near(a.z + a.d, b.z) || near(b.z + b.d, a.z))) || (overlapZ > 1 && (near(a.x + a.w, b.x) || near(b.x + b.w, a.x)));
    };
    const halls = level.filter((room) => room.kind === "hall");
    for (const room of level) {
      const into = room.kind === "hall" ? halls.filter((hall) => hall.id > room.id && touches(room, hall)) : [halls.find((hall) => touches(room, hall)) ?? level.find((other) => other !== room && touches(room, other))].filter(Boolean) as Room[];
      for (const other of into) links.push({ a: room.id, b: other.id, kind: "door", fireRated: room.kind === "stair", closed: room.kind === "stair" });
    }
    rooms.push(...level);
  }
  return { rooms, links, verticals: [
    { id: "stair-a", kind: "stair", floors: [1, floors], doorsClosed: true },
    { id: "stair-b", kind: "stair", floors: [1, floors], doorsClosed: false },
    { id: "elev-1", kind: "elevator", floors: [1, floors], doorsClosed: true },
  ] };
}

const lOutline: [number, number][] = [[0, 0], [36, 0], [36, 14], [14, 14], [14, 34], [0, 34]];
const lPlan = (f: number): Spec[] => [
  ["hall", "Hallway", "hall", 0, 5.5, 36, 3], ["hall-b", "West Hallway", "hall", 5.5, 8.5, 3, 21.5],
  ["stair-a", "Stairwell A", "stair", 0, 0, 4, 5.5], ["elev-1", "Elevator", "elevator", 4, 2.5, 3, 3], ["stair-b", "Stairwell B", "stair", 5.5, 30, 3, 4],
  ...["A", "B", "C", "D"].map((u, i): Spec => [`apt-${f}${u.toLowerCase()}`, `Apartment ${f}${u}`, "residential", 7 + i * 7.25, 0, 7.25, 5.5]),
  ...["E", "F", "G"].map((u, i): Spec => [`apt-${f}${u.toLowerCase()}`, `Apartment ${f}${u}`, "residential", 8.5 + i * (27.5 / 3), 8.5, 27.5 / 3, 5.5]),
  ...["H", "J", "K"].map((u, i): Spec => [`apt-${f}${u.toLowerCase()}`, `Apartment ${f}${u}`, "residential", 0, 8.5 + i * (21.5 / 3), 5.5, 21.5 / 3]),
  ...["L", "M"].map((u, i): Spec => [`apt-${f}${u.toLowerCase()}`, `Apartment ${f}${u}`, "residential", 8.5, 14 + i * 8, 5.5, 8]),
  ["storage", "Storage", "storage", 0, 30, 5.5, 4], ["utility", "Utility Room", "utility", 8.5, 30, 5.5, 4],
];
const towerPlan = (f: number): Spec[] => [
  ["hall", "Hallway", "hall", 4, 7.5, 34, 3], ["stair-a", "Stairwell A", "stair", 0, 7.5, 4, 3], ["stair-b", "Stairwell B", "stair", 38, 7.5, 4, 3],
  ["elev-1", "Elevator", "elevator", 19.5, 4.5, 3, 3],
  ["office-1", `Office ${f}01`, "office", 0, 0, 9.75, 7.5], ["office-2", `Office ${f}02`, "office", 9.75, 0, 9.75, 7.5],
  ["office-3", `Office ${f}03`, "office", 22.5, 0, 9.75, 7.5], ["office-4", `Office ${f}04`, "office", 32.25, 0, 9.75, 7.5],
  ["open", "Open Office", "open-office", 0, 10.5, 28, 7.5], ["conf", "Conference", "conference", 28, 10.5, 14, 7.5],
];

const ring = (cx: number, cz: number, w: number, d: number, angle: number): [number, number][] =>
  [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([x, z]) => [cx + x! * Math.cos(angle) - z! * Math.sin(angle), cz + x! * Math.sin(angle) + z! * Math.cos(angle)]);

const candidates: BuildingCandidateSummary[] = [
  { id: "osm:way:1001", name: "Main Street Lofts", address: "1200 Main St", floors: 5, heightMeters: 17, use: "apartments", distanceMeters: 0, outline: lOutline.map(([x, z]) => [x - 9, z - 7]) },
  { id: "osm:way:1002", name: null, address: "1210 Main St", floors: 2, heightMeters: null, use: "retail", distanceMeters: 18, outline: ring(44, -4, 22, 16, 0.08) },
  { id: "osm:way:1003", name: "Elm Tower", address: null, floors: 24, heightMeters: 92, use: "office", distanceMeters: 46, outline: ring(-34, 52, 26, 18, -0.35) },
];

function fixture(kind: "lookup" | "tower") {
  const tower = kind === "tower";
  const floors = tower ? 40 : 5;
  const geometry = generate(floors, tower ? towerPlan : lPlan);
  const building: Building = {
    ...geometry,
    profile: {
      id: tower ? "osm:way:2001" : "osm:way:1001", name: tower ? "Commerce Tower" : "Main Street Lofts",
      address: tower ? "500 Commerce St, Dallas, TX 75202" : "1200 Main St, Dallas, TX 75202", source: "osm",
      use: tower ? "office" : "residential", floors, location: { lat: 32.7801, lon: -96.8003 }, timezone: "America/Chicago",
      outline: tower ? [[0, 0], [42, 0], [42, 18], [0, 18]] : lOutline, layoutEstimated: true,
      assumptions: ["Floor count from OSM building:levels.", "Rooms, hallway, stairwells and elevator are generated, not mapped.", "Storey height assumed 3.5 m."],
      attribution: "© OpenStreetMap contributors (ODbL)",
    },
  };
  const fireFloor = tower ? 23 : 3;
  const origin = tower ? `${fireFloor}-conf` : `${fireFloor}-apt-3c`;
  const occupants: Occupant[] = geometry.rooms.filter((room) => room.kind === "residential" || room.kind === "office" || room.kind === "open-office")
    .map((room, i) => ({ room: room.id, count: room.kind === "open-office" ? 14 : 1 + (i % 3), flags: i % 7 === 0 ? ["mobility"] : [], estimated: true }));
  const smoky = geometry.rooms.filter((room) => room.floor === fireFloor && room.id !== origin && room.kind !== "elevator").slice(0, 4).map((room) => room.id);
  const state: IncidentState = {
    simMinute: 6,
    rooms: [{ roomId: origin, fire: 0.8, smoke: 0.9 }, ...smoky.map((roomId, i) => ({ roomId, fire: 0, smoke: 0.5 - i * 0.1 })), { roomId: `${fireFloor + 1}-stair-b`, fire: 0, smoke: 0.35 }],
    reports: [{ id: "r1", caller: "+1 214 555 0142", text: "Smoke in the hallway, third floor, near 3C.", roomId: origin, confidence: 0.82, time: Date.now() - 90_000, channel: "voice" }],
    occupants,
    origin: { roomId: origin, confidence: 0.82 },
    exits: Array.from({ length: floors }, (_, i) => i + 1).filter((f) => Math.abs(f - fireFloor) <= 1).map((f) => ({
      floor: f, people: occupants.filter((o) => o.room.startsWith(`${f}-`)).reduce((sum, o) => sum + o.count, 0), flags: f === fireFloor ? ["mobility"] : [],
      stair: "stair-a", blockedAt: { "stair-a": null, "stair-b": 9 }, atRiskAt: f === fireFloor ? 4 : 11, route: [`${f}-hall`, ...Array.from({ length: f }, (_, k) => `${f - k}-stair-a`)],
    })),
    trail: [
      { tool: "find_building", input: { address: "1200 Main St, Dallas" }, output: { match: { formatted: "1200 Main Street, Dallas, TX 75202" }, candidates: candidates.length }, ms: 640 },
      { tool: "estimate_occupancy", input: { buildingId: building.profile!.id }, output: { total: occupants.reduce((sum, o) => sum + o.count, 0), byFloor: { 1: 18, 2: 18 }, basis: ["Residential: 2 people per apartment at 9 pm local time.", "Occupied share 85% (weekday evening).", "Mobility flags: 1 in 7 units (assumption)."] }, ms: 12 },
    ],
    log: [
      { time: Date.now() - 80_000, kind: "building", text: "Address heard on call: 1200 Main St, Dallas" },
      { time: Date.now() - 60_000, kind: "building", text: `${building.profile!.name} confirmed; layout generated (${floors} floors)` },
    ],
    building: { id: building.profile!.id, name: building.profile!.name, version: 1, layoutEstimated: true },
    buildingLookup: tower
      ? { query: "500 Commerce St", caller: "Dispatcher", status: "active", match: { formatted: "500 Commerce Street, Dallas, TX 75202", lat: 32.7801, lon: -96.8003 }, candidates: [], time: Date.now() - 120_000 }
      : { query: "1200 Main St, Dallas", caller: "+1 214 555 0142", status: "needs_confirmation", match: { formatted: "1200 Main Street, Dallas, TX 75202", lat: 32.7801, lon: -96.8003 }, candidates, time: Date.now() - 30_000 },
  };
  return { building, state };
}

/** The fixture named by `?fixture=`, or null. `&view=map` opens surroundings, `&theme=dark` the dark theme. */
export function devFixture(): { building: Building; state: IncidentState; view: "map" | "3d" } | null {
  const params = new URLSearchParams(location.search);
  const name = params.get("fixture");
  if (name !== "lookup" && name !== "tower") return null;
  if (params.get("theme") === "dark" || params.get("theme") === "light") document.documentElement.dataset.theme = params.get("theme")!;
  const result = fixture(name);
  // &lookup=searching|loading|failed shows the other lookup states.
  const status = params.get("lookup");
  if (result.state.buildingLookup && (status === "searching" || status === "loading" || status === "failed")) {
    result.state.buildingLookup = { ...result.state.buildingLookup, status, candidates: status === "failed" ? [] : result.state.buildingLookup.candidates, error: status === "failed" ? "No building outline is mapped at this address." : undefined };
  }
  return { ...result, view: ["map", "plan"].includes(params.get("view") ?? "") ? "map" : "3d" };
}
