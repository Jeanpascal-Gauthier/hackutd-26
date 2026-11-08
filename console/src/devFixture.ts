// DEV ONLY. Local fixtures for checking the console without a server.
// Load with http://localhost:5173/?fixture=lookup (5-floor L-shaped building + a lookup waiting for
// confirmation), ?fixture=tower (40 floors x 10 rooms), or ?fixture=map (a fire, a crash and another
// incident). App only calls this when import.meta.env.DEV, and client events are not sent to the
// server while a fixture is shown.
import type { Building, BuildingCandidateSummary, CongestionSegment, GeoPoint, IncidentState, Link, MapIncident, Occupant, Report, Room, RoomKind } from "@firewatch/shared/types";
import type { ForecastScenario, RiskBuilding } from "./map/forecastModel";

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

const circle = (center: GeoPoint, meters: number, stretch = 1): GeoPoint[] => Array.from({ length: 16 }, (_, i) => {
  const angle = (i / 16) * Math.PI * 2;
  return { lat: center.lat + (meters * stretch * Math.cos(angle)) / 111_320, lon: center.lon + (meters * Math.sin(angle)) / 93_500 };
});

/** A linked fire, crash, gas leak and flood, with six buildings and executable mitigations. */
export function mapFixture() {
  const base = fixture("lookup");
  const now = Date.now();
  const firePlace: GeoPoint = { lat: 32.7801, lon: -96.8003 };
  const offset = (north: number, east: number): GeoPoint => ({ lat: firePlace.lat + north / 111_320, lon: firePlace.lon + east / 93_500 });
  const crashPlace = offset(-50, -170);
  const query = "1200 Main St, Dallas";
  const fire: MapIncident = {
    id: "fixture-fire", kind: "fire", label: "Fire", severity: "critical", status: "located", query, location: firePlace,
    formatted: "1200 Main Street, Dallas, TX 75202", inBuilding: true, phase: "dispatched",
    reports: [
      { caller: "+1 214 555 0142", text: "Smoke in the third floor hallway near 3C.", time: now - 420_000, channel: "voice", reply: "Help is on the way. Leave by the nearest stairs if you can." },
      { caller: "Maya R.", text: "Flames visible from a window on the Main Street side.", time: now - 180_000, channel: "sms" },
      { caller: "Building security", text: "Gas smell at the east service entrance. Fire doors are still open.", time: now - 120_000, channel: "voice" },
    ],
    time: now - 420_000, updated: now - 60_000,
    recommendation: { actions: ["Send a second engine to the Main Street entrance.", "Ask callers on floor 3 to stay low and use Stair A."], callerReply: "Crews are on the way. Use Stair A, and do not use the elevator." },
    dispatches: [{ unit: "Engine 3", time: now - 300_000 }],
    notes: [{ text: "Gate on Elm Street is locked after 6 pm.", time: now - 120_000 }],
    forecastStatus: "ready", forecastAt: now - 200_000,
    fire: {
      wind: { speedMps: 5.2, fromDegrees: 200 },
      steps: [5, 10, 15, 20, 30].map((minute) => ({ minute, fire: circle(firePlace, 3 * minute), smoke: circle(offset(minute * 5, minute * 3), 9 * minute, 1.3) })),
      exposures: [],
      summary: "Fire may reach 2 nearby buildings within 30 minutes. Smoke is modeled toward the north-northeast.",
      assumptions: ["All wind, spread, building, and occupancy data in this scenario are illustrative.", "Hazard polygons and road paths are synthetic and are not surveyed boundaries.", "Action effects are fixed demo estimates, not a validated loss model."],
    },
  };
  const segment = (north: number, east: number, length: number, road: string, queueMinute: number, level: CongestionSegment["level"]): CongestionSegment => ({
    path: [{ lat: crashPlace.lat + north / 111_320, lon: crashPlace.lon + east / 93_500 }, { lat: crashPlace.lat + (north + length) / 111_320, lon: crashPlace.lon + east / 93_500 }], road, queueMinute, level,
  });
  const crash: MapIncident = {
    id: "fixture-crash", kind: "crash", label: "Car crash", severity: "serious", status: "located", query: "Griffin Street and Main Street", location: crashPlace,
    formatted: "Griffin Street at Main Street, Dallas, TX", lanesBlocked: "some", phase: "open",
    reports: [{ caller: "Dan W.", text: "Two cars collided, one lane open, nobody trapped.", time: now - 240_000, channel: "voice", reply: "Thank you, I have passed that on. Stay on the line if it is safe." }],
    time: now - 240_000, updated: now - 200_000,
    recommendation: { actions: ["Send one police unit for traffic control.", "Advise crews to approach by Live Oak Street."] },
    forecastStatus: "ready", forecastAt: now - 180_000,
    crash: {
      road: "Griffin Street",
      segments: [segment(0, 0, 80, "Griffin Street", 0, "blocked"), segment(80, 0, 100, "Griffin Street", 5, "heavy"), segment(180, 0, 100, "Griffin Street", 10, "heavy"), segment(280, 0, 100, "Griffin Street", 20, "moderate")],
      steps: [{ minute: 5, queueMeters: 180, roads: ["Griffin Street"] }, { minute: 10, queueMeters: 280, roads: ["Griffin Street"] }, { minute: 20, queueMeters: 380, roads: ["Griffin Street"] }, { minute: 30, queueMeters: 380, roads: ["Griffin Street"] }],
      clearance: { reopenMinute: 20, clearedMinute: 46 },
      alternateRoads: ["Live Oak Street", "Bryan Street"],
      summary: "Griffin Street is partly blocked. Queues reach 280 m by 10 minutes and 380 m by 20 minutes. Crews should approach from the west.",
      assumptions: ["Illustrative queue model, not live traffic.", "Clearance assumes the road reopens at minute 20, a planning assumption.", "Queue lengths shown up to 30 minutes do not shrink after the assumed reopening at minute 20."],
    },
  };
  const other: MapIncident = {
    id: "fixture-other", kind: "other", label: "Gas leak", severity: "critical", status: "located", query: "Main Street east service entrance", formatted: "Main Street east service entrance, Dallas, TX", location: offset(80, 110), phase: "open",
    reports: [{ caller: "Priya S.", text: "Strong smell of gas at the east service entrance on Main Street.", time: now - 90_000, channel: "form" }],
    time: now - 90_000, updated: now - 90_000, forecastStatus: "none",
  };
  const flood: MapIncident = {
    id: "fixture-flood", kind: "other", label: "Flash flood", severity: "serious", status: "located", query: "Commerce Street underpass", formatted: "Commerce Street underpass, Dallas, TX", location: offset(-140, 210), phase: "open",
    reports: [{ caller: "Facilities team", text: "Storm drain backed up. Water is entering the underground parking and approaching the electrical room.", time: now - 150_000, channel: "form" }],
    time: now - 150_000, updated: now - 90_000, forecastStatus: "ready", forecastAt: now - 90_000,
  };
  // All map coordinates, impacts, links, and action effects below are illustrative demo data.
  const specs: [string, string, number, number, number, number, number, string, string][] = [
    ["x-origin", "Main Street Lofts", 0, 0, 180, 95_000, 0, "Isolate gas supply & shut down HVAC", "Evacuate via west stairwell"],
    ["x-1", "Elm Tower", 100, 100, 320, 85_000, 6, "Close smoke dampers & fire doors", "Move occupants to the protected stairwell"],
    ["x-2", "Commerce Retail", -150, 210, 80, 30_000, 12, "Deploy flood barriers at garage entry", "Close garage & evacuate service level"],
    ["x-3", "Parkview Medical Center", 210, 260, 240, 80_000, 8, "Switch air intake to recirculation", "Relocate patients from the east wing"],
    ["x-4", "Travis Learning Center", 300, 20, 260, 55_000, 18, "Close exterior air intakes", "Move classes to the west assembly point"],
    ["x-5", "Oak Care Residence", -250, -80, 160, 35_000, 24, "Activate backup power & sump pumps", "Move residents above the ground floor"],
  ];
  const buildings: RiskBuilding[] = specs.map(([id, name, north, east, people, loss, firstImpactMinute, firstAction, secondAction], index) => {
    const location = offset(north, east);
    const water = index === 2 || index === 5;
    return {
      id, name, location, outline: [[-25, -32], [-25, 32], [25, 32], [25, -32]].map(([n, e]) => offset(north + n!, east + e!)), people, loss, firstImpactMinute,
      actions: [
        { id: `${id}-isolate`, label: firstAction, owner: water ? "Facilities · electrical team" : "Facilities · fire safety", lossReduction: Math.round(loss * 0.6), peopleProtected: 0 },
        { id: `${id}-evacuate`, label: secondAction, owner: water ? "Facilities · site lead" : "Security · floor wardens", lossReduction: Math.round(loss * 0.25), peopleProtected: people },
      ],
      chain: [
        { minute: firstImpactMinute, title: water ? "Water reaches the service level" : "Smoke enters occupied areas", detail: water ? "Runoff exceeds drainage capacity; access begins to flood." : "The forecast plume reaches the building's outside air intake." },
        { minute: Math.min(27, firstImpactMinute + 4), title: water ? "Electrical systems exposed" : "Smoke spreads through ventilation", detail: water ? "Electrical distribution and lift controls are at risk." : "Open dampers carry smoke into corridors and lift lobbies.", preventedBy: `${id}-isolate` },
        { minute: Math.min(30, firstImpactMinute + 9), title: water ? "Ground-floor access lost" : "Safe exit window narrows", detail: `${people.toLocaleString("en-US")} people need a protected route; delayed relocation increases exposure.`, preventedBy: `${id}-evacuate` },
      ],
    };
  });
  fire.fire!.exposures = buildings.map((building, index) => ({
    id: building.id, name: building.name, location: building.location, outline: building.outline,
    distanceMeters: Math.round(Math.hypot(specs[index]![2], specs[index]![3])), origin: index === 0,
    fireEtaMinutes: index === 0 ? 0 : building.firstImpactMinute + 12, smokeEtaMinutes: building.firstImpactMinute, risk: index < 2 ? "high" : "moderate",
  }));
  const mapScenario: ForecastScenario = {
    id: "downtown-cascade-v1", buildings,
    floods: [{ id: "commerce-flood", incidentId: flood.id, steps: [0, 5, 10, 15, 20, 30].map((minute) => ({ minute, water: circle(offset(-140 - minute, 210 - minute * 4), 20 + minute * 7, 0.65) })) }],
    roads: [
      { id: "flooded-commerce", incidentId: flood.id, road: "Commerce Street", reason: "Flooded · impassable", minute: 8, path: [offset(-180, -60), offset(-180, 160), offset(-180, 350)] },
      { id: "closed-main", incidentId: fire.id, road: "Main Street", reason: "Closed · fire perimeter", minute: 0, path: [offset(-45, -100), offset(-45, 80)] },
    ],
    blasts: [{ id: "gas-perimeter", incidentId: other.id, center: other.location!, radiusMeters: 140 }],
    links: [
      { from: fire.id, to: other.id, reason: "Fire threatens gas service · linked escalation" },
      { from: crash.id, to: fire.id, reason: "Crash queue blocks fire crew access" },
      { from: flood.id, to: other.id, reason: "Flood threatens shared utility corridor" },
    ],
  };
  const mapIncidents = [fire, crash, other, flood];
  const reports: Report[] = mapIncidents.flatMap((incident) => incident.reports.map((report, index) => ({ id: `${incident.id}-${index}`, incidentId: incident.id, ...report })));
  base.state.reports = reports;
  base.state.mapIncidents = mapIncidents;
  base.state.buildingLookup = { query, caller: "+1 214 555 0142", status: "active", match: { formatted: fire.formatted!, lat: firePlace.lat, lon: firePlace.lon }, candidates: [], time: now - 400_000 };
  base.state.log = [
    ...(base.state.log ?? []),
    ...mapIncidents.map((incident) => ({ time: incident.time, kind: "report" as const, text: `${incident.label} reported`, incidentId: incident.id })),
  ].sort((a, b) => a.time - b.time);
  return { ...base, mapScenario };
}

/** The fixture named by `?fixture=`, or null. `&view=plan` opens the floor plan, `&theme=dark` the dark theme. */
export function devFixture(): { building: Building; state: IncidentState; view: "plan" | "3d"; mapScenario?: ForecastScenario } | null {
  const params = new URLSearchParams(location.search);
  const name = params.get("fixture");
  if (name !== "lookup" && name !== "tower" && name !== "map") return null;
  if (params.get("theme") === "dark" || params.get("theme") === "light") document.documentElement.dataset.theme = params.get("theme")!;
  const result = name === "map" ? mapFixture() : fixture(name);
  // &lookup=searching|loading|failed shows the other lookup states.
  const status = params.get("lookup");
  if (result.state.buildingLookup && (status === "searching" || status === "loading" || status === "failed")) {
    result.state.buildingLookup = { ...result.state.buildingLookup, status, candidates: status === "failed" ? [] : result.state.buildingLookup.candidates, error: status === "failed" ? "No building outline is mapped at this address." : undefined };
  }
  return { ...result, view: params.get("view") === "plan" ? "plan" : "3d" };
}
