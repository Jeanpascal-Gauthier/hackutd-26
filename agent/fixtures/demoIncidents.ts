// The three demo calls around Campbell Rd & Coit Rd, Richardson TX, as AgentIncidents for the
// impact tools (fixtures/portfolio.json is the matching CBRE-style portfolio):
//   1. DEMO_FIRE: fire behind the Campbell Coit Plaza strip mall, 15 mph wind from the SW carrying
//      smoke NE toward Lookout Ridge Data Center (smoke at its HVAC intake ~minute 8).
//   2. DEMO_CRASH: all lanes blocked on Coit Rd, the data center's only fuel route. Linked to the fire.
//   3. DEMO_FLOOD: water main burst on Lookout Dr; water reaches the data center's basement
//      electrical room at minute 12.
// Forecasts are hand-built from small closed-form models (below) so the demo is exact and offline.
import type { CongestionSegment, FireExposure, GeoPoint } from "@firewatch/shared/types";
import { angleBetween, bearingDegrees, distanceMeters, downwindOf, offsetPoint } from "../core/impact/geo.ts";
import type { AgentIncident, PortfolioBuilding } from "../core/impact/types.ts";
import portfolioJson from "./portfolio.json" with { type: "json" };

const portfolio = portfolioJson as PortfolioBuilding[];

/** Tue 10 Nov 2026, 2:00 PM Central (UTC-6 after DST ends): weekday daytime occupancy. */
export const DEMO_NOW = Date.UTC(2026, 10, 10, 20, 0, 0);

const MINUTE = 60_000;
const rad = (d: number) => (d * Math.PI) / 180;
const round5 = (p: GeoPoint): GeoPoint => ({ lat: Math.round(p.lat * 1e5) / 1e5, lon: Math.round(p.lon * 1e5) / 1e5 });

/** A closed ring (first point not repeated) of `reach(bearing)` metres around `center`, every 10 degrees. */
function ring(center: GeoPoint, reach: (bearing: number) => number): GeoPoint[] {
  return Array.from({ length: 36 }, (_, i) => round5(offsetPoint(center, reach(i * 10), i * 10)));
}

/** First minute (0.1 resolution, rounded) at which `reach` covers `p`, or null within `maxMinute`. */
function etaMinutes(center: GeoPoint, p: GeoPoint, reach: (bearing: number, minute: number) => number, maxMinute: number): number | null {
  const d = distanceMeters(center, p);
  const b = bearingDegrees(center, p);
  for (let m = 0; m <= maxMinute; m = Math.round((m + 0.1) * 10) / 10) if (reach(b, m) >= d) return Math.round(m);
  return null;
}

// ---- 1. Fire behind the strip mall on Campbell Rd ----

const FIRE_AT: GeoPoint = { lat: 32.97629, lon: -96.77047 };
const FIRE_WIND = { speedMps: 6.7, fromDegrees: 225 }; // 15 mph from the SW
const SMOKE_TOWARD = downwindOf(FIRE_WIND.fromDegrees);

/** Plume: a near-field disc (up to 120 m) plus a lobe growing 52 m/min straight downwind, narrowing as cos^4 off-axis. */
function smokeReach(bearing: number, minute: number): number {
  const near = Math.min(120, 30 + 30 * minute);
  const along = Math.max(0, Math.cos(rad(angleBetween(bearing, SMOKE_TOWARD)))) ** 4;
  return near + 52 * minute * along;
}

/** Fire front: 3 m/min everywhere, up to 8 m/min downwind. */
function fireReach(bearing: number, minute: number): number {
  const along = Math.max(0, Math.cos(rad(angleBetween(bearing, SMOKE_TOWARD))));
  return 10 + minute * (3 + 5 * along);
}

/** Every portfolio building within 1.2 km, as the server's exposure list would have it. */
const fireExposures: FireExposure[] = portfolio
  .filter((b) => distanceMeters(FIRE_AT, b.location) <= 1200)
  .map((b) => {
    const fireEta = etaMinutes(FIRE_AT, b.location, fireReach, 240) ?? 240;
    const smokeEta = etaMinutes(FIRE_AT, b.location, smokeReach, 30);
    const risk: FireExposure["risk"] = fireEta <= 30 || (smokeEta !== null && smokeEta <= 10) ? "high" : smokeEta !== null ? "moderate" : "low";
    return {
      id: `osm-${b.id}`,
      name: b.name,
      location: b.location,
      outline: [],
      distanceMeters: Math.round(distanceMeters(FIRE_AT, b.location)),
      origin: false,
      fireEtaMinutes: fireEta,
      smokeEtaMinutes: smokeEta,
      risk,
      use: b.use === "hospital" ? "hospital" : null,
    };
  })
  .sort((a, b) => a.fireEtaMinutes - b.fireEtaMinutes);

export const DEMO_FIRE: AgentIncident = {
  id: "inc-fire-campbell",
  kind: "fire",
  severity: "critical",
  location: FIRE_AT,
  description: "Fire behind the strip mall on Campbell Rd, dumpsters and the loading dock burning, heavy smoke",
  inBuilding: false,
  wind: FIRE_WIND,
  fire: {
    wind: FIRE_WIND,
    steps: [0, 5, 10, 15, 20, 25, 30].map((minute) => ({
      minute,
      fire: ring(FIRE_AT, (b) => fireReach(b, minute)),
      smoke: ring(FIRE_AT, (b) => smokeReach(b, minute)),
    })),
    exposures: fireExposures,
    summary: "Fire spreading from the loading dock behind Campbell Coit Plaza; smoke plume carried northeast by a 15 mph SW wind.",
    assumptions: [
      "Hand-built demo forecast: plume grows ~52 m/min downwind, fire front 3-8 m/min",
      "Wind steady at 15 mph from 225° for the next 30 minutes",
    ],
  },
  related: ["inc-crash-coit"],
  zoneId: "zone-campbell-coit",
  calls: 3,
  time: DEMO_NOW - 6 * MINUTE,
};

// ---- 2. Crash on Coit Rd, all lanes blocked ----

const CRASH_AT: GeoPoint = { lat: 32.97557, lon: -96.76672 };
/** A straight stretch of Coit Rd (it runs north-south) from `fromM` to `toM` metres south of the crash. */
const coitSouth = (fromM: number, toM: number): GeoPoint[] => [round5(offsetPoint(CRASH_AT, fromM, 180)), round5(offsetPoint(CRASH_AT, toM, 180))];

const crashSegments: CongestionSegment[] = [
  { path: coitSouth(-40, 40), road: "Coit Rd", queueMinute: 0, level: "blocked" },
  { path: coitSouth(40, 340), road: "Coit Rd", queueMinute: 3, level: "heavy" },
  { path: coitSouth(340, 620), road: "Coit Rd", queueMinute: 8, level: "moderate" },
];

export const DEMO_CRASH: AgentIncident = {
  id: "inc-crash-coit",
  kind: "crash",
  severity: "serious",
  location: CRASH_AT,
  description: "Three-car crash on Coit Rd just south of Campbell, all lanes blocked, drivers say they couldn't see through the smoke",
  lanesBlocked: "all",
  crash: {
    road: "Coit Rd",
    segments: crashSegments,
    steps: [
      { minute: 0, queueMeters: 80, roads: ["Coit Rd"] },
      { minute: 5, queueMeters: 340, roads: ["Coit Rd"] },
      { minute: 10, queueMeters: 520, roads: ["Coit Rd"] },
      { minute: 15, queueMeters: 600, roads: ["Coit Rd"] },
    ],
    alternateRoads: ["Campbell Rd", "Glenville Dr"],
    summary: "All lanes of Coit Rd blocked at Campbell; queue growing south to ~600 m.",
    assumptions: ["Hand-built demo forecast", "No reopening modeled: tow and investigation still on scene"],
  },
  affectedRoads: crashSegments
    .filter((s) => s.level !== "moderate")
    .map((s) => ({ path: s.path, road: s.road, reason: "crash" as const, fromMinute: s.queueMinute })),
  related: ["inc-fire-campbell"],
  zoneId: "zone-campbell-coit",
  calls: 2,
  time: DEMO_NOW - 4 * MINUTE,
};

// ---- 3. Water main burst on Lookout Dr ----

const BURST_AT: GeoPoint = { lat: 32.98188, lon: -96.76833 };
/** Water runs downhill to the SE (toward the data center) and back up Lookout Dr to the NW. */
const FLOW_TOWARD = 141;

/** Ellipse drifting 6 m/min downhill, semi-axes 22 m/min along the slope and 9 m/min across it. */
function waterRing(minute: number): GeoPoint[] {
  const center = offsetPoint(BURST_AT, 6 * minute, FLOW_TOWARD);
  const a = 4 + 22 * minute;
  const b = 4 + 9 * minute;
  return Array.from({ length: 36 }, (_, i) => {
    const t = (i * 10 * Math.PI) / 180;
    return round5(offsetPoint(offsetPoint(center, a * Math.cos(t), FLOW_TOWARD), b * Math.sin(t), FLOW_TOWARD + 90));
  });
}

const lookoutDr = (fromM: number, toM: number): GeoPoint[] => [round5(offsetPoint(BURST_AT, fromM, 270)), round5(offsetPoint(BURST_AT, toM, 270))];

export const DEMO_FLOOD: AgentIncident = {
  id: "inc-flood-lookout",
  kind: "flood",
  severity: "serious",
  location: BURST_AT,
  description: "Water main burst on Lookout Dr, water pouring down the street toward Coit Rd",
  source: "water main burst",
  flood: {
    steps: Array.from({ length: 16 }, (_, i) => ({ minute: i * 2, water: waterRing(i * 2) })),
    summary: "Street flooding spreading SE from the Lookout Dr main toward Coit Rd until the valve is shut.",
    assumptions: ["Hand-built demo forecast: ~22 m/min spread downhill", "Valve not shut within 30 minutes"],
  },
  affectedRoads: [
    { path: lookoutDr(-300, 0), road: "Lookout Dr", reason: "flood", fromMinute: 0 },
    { path: lookoutDr(0, 300), road: "Lookout Dr", reason: "flood", fromMinute: 4 },
  ],
  zoneId: "zone-campbell-coit",
  calls: 2,
  time: DEMO_NOW - 2 * MINUTE,
};

export const DEMO_INCIDENTS: AgentIncident[] = [DEMO_FIRE, DEMO_CRASH, DEMO_FLOOD];
