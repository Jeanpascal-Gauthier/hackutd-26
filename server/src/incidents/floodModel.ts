// Street flood forecast: water spreads from the reported spot (a burst water main, a flooded
// street) over 30 minutes, farther downhill than uphill, and the roads it covers turn red.
// Deliberately simple; the assumptions travel with the result.
import type { GeoPoint, IncidentSeverity } from "@firewatch/shared/types";
import { distanceToSegment, pointInRing } from "../buildings/geometry.ts";
import type { RoadWay } from "./crashModel.ts";
import { HORIZON_MINUTES, compass, distance, localFrame, offset, type Metres } from "./geo.ts";
import type { AffectedRoad, FloodForecast } from "./stepZero.ts";

/** Forecast minutes, 2 to 5 minutes apart. */
export const FLOOD_MINUTES = [2, 5, 10, 15, 20, 25, 30] as const;
/** Metres the water reaches by minute 30 on flat ground. */
export const FLOOD_REACH_METERS: Record<IncidentSeverity, number> = { minor: 150, serious: 300, critical: 450, unknown: 300 };
/** Elevation samples: this many compass bearings, at these distances, plus the spot itself. */
const SAMPLE_BEARINGS = 16;
const SAMPLE_METERS = [100, 250, 450];
const RING_POINTS = 32;
/** Reach factor e^(-GRADE_EFFECT * grade): a 1% downhill grade reaches about 1.5x, 1% uphill about 0.67x. */
const GRADE_EFFECT = 40;
const MIN_FACTOR = 0.35;
const MAX_FACTOR = 2;
const ROAD_STEP = 20; // metres between the road points tested for water
const MAX_FLOODED_ROADS = 120;
const MAX_ROADS_IN_SUMMARY = 4;

const FLOOD_WORDS = /\b(flood(s|ed|ing)?|water ?mains?|burst (water )?(pipe|main)s?|pipe burst|broken (water )?(pipe|main)|street flooding|high water)\b/i;
const WATER_MAIN = /water ?main|pipe|hydrant/i;

/**
 * Whether an `other` report is a flood. The caller's `what` decides when given ("gas leak" stays a
 * gas leak even if the basement is wet); without one, the description does.
 */
export const isFloodReport = (what: string | undefined, description: string) => FLOOD_WORDS.test(what ?? description);

/** Where to ask for ground elevation, in the order `forecastFlood` expects: the spot, then bearing by bearing. */
export function floodSamplePoints(origin: GeoPoint): GeoPoint[] {
  const frame = localFrame(origin);
  const points = [frame.toPoint([0, 0])];
  for (let b = 0; b < SAMPLE_BEARINGS; b++) for (const range of SAMPLE_METERS) points.push(frame.toPoint(offset((b / SAMPLE_BEARINGS) * 2 * Math.PI, range)));
  return points;
}

/** Reach multiplier per sample bearing, from the average grade away from the spot. Null without usable elevation. */
function reachFactors(elevations: readonly number[] | null): number[] | null {
  if (!elevations || elevations.length !== 1 + SAMPLE_BEARINGS * SAMPLE_METERS.length || !elevations.every(Number.isFinite)) return null;
  const base = elevations[0]!;
  const grades = Array.from({ length: SAMPLE_BEARINGS }, (_, b) =>
    SAMPLE_METERS.reduce((sum, range, d) => sum + (elevations[1 + b * SAMPLE_METERS.length + d]! - base) / range, 0) / SAMPLE_METERS.length);
  // Smooth across neighbouring bearings: one noisy sample should not make a spike.
  const smooth = grades.map((g, b) => (grades[(b + SAMPLE_BEARINGS - 1) % SAMPLE_BEARINGS]! + 2 * g + grades[(b + 1) % SAMPLE_BEARINGS]!) / 4);
  const clamp = (f: number) => Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, f));
  const raw = smooth.map((g) => clamp(Math.exp(-GRADE_EFFECT * g)));
  // The same water covers the same area: downhill gains what uphill loses.
  const scale = Math.sqrt(raw.reduce((sum, f) => sum + f * f, 0) / raw.length);
  return raw.map((f) => clamp(f / scale));
}

/** The factor at any bearing (radians), linear between sample bearings. */
function factorAt(factors: number[] | null, bearing: number): number {
  if (!factors) return 1;
  const pos = ((((bearing / (2 * Math.PI)) * SAMPLE_BEARINGS) % SAMPLE_BEARINGS) + SAMPLE_BEARINGS) % SAMPLE_BEARINGS;
  const i = Math.floor(pos);
  const t = pos - i;
  return factors[i]! * (1 - t) + factors[(i + 1) % SAMPLE_BEARINGS]! * t;
}

/** Steady inflow: wet area grows with time, so the radius grows with its square root. */
const radiusAt = (reach: number, minute: number) => reach * Math.sqrt(minute / HORIZON_MINUTES);

function waterRing(reach: number, factors: number[] | null, minute: number): Metres[] {
  const r = radiusAt(reach, minute);
  return Array.from({ length: RING_POINTS }, (_, i) => {
    const bearing = (i / RING_POINTS) * 2 * Math.PI;
    return offset(bearing, r * factorAt(factors, bearing));
  });
}

/** Road points no more than ROAD_STEP apart, in metres. */
function densify(points: Metres[]): Metres[] {
  const out: Metres[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (i > 0) {
      const a = points[i - 1]!;
      const pieces = Math.ceil(distance(a, p) / ROAD_STEP);
      for (let k = 1; k < pieces; k++) out.push([a[0] + ((p[0] - a[0]) * k) / pieces, a[1] + ((p[1] - a[1]) * k) / pieces]);
    }
    out.push(p);
  }
  return out;
}

/**
 * Road sections under water. Each section is a run of road that goes under at the same forecast
 * minute, so the red grows outward with the water. Earliest first, capped.
 */
function floodedRoads(frame: ReturnType<typeof localFrame>, rings: { minute: number; ring: Metres[] }[], roads: RoadWay[]): AffectedRoad[] {
  const last = rings[rings.length - 1]!;
  const outer = Math.max(...last.ring.map((p) => Math.hypot(...p)));
  const out: (AffectedRoad & { length: number })[] = [];
  for (const way of roads) {
    const raw = way.geometry.map(frame.toMetres);
    if (raw.length < 2 || raw.slice(1).every((p, i) => distanceToSegment([0, 0], raw[i]!, p) > outer)) continue;
    const points = densify(raw);
    const wetAt = points.map((p) => (Math.hypot(...p) > outer ? Infinity : rings.find(({ ring }) => pointInRing(p, ring))?.minute ?? Infinity));
    let run: { minute: number; path: Metres[] } | undefined;
    const flush = () => {
      if (run && run.path.length >= 2) {
        const length = run.path.slice(1).reduce((sum, p, i) => sum + distance(run!.path[i]!, p), 0);
        out.push({ path: run.path.map(frame.toPoint), road: way.name, reason: "flood", fromMinute: run.minute, length });
      }
      run = undefined;
    };
    for (let i = 1; i < points.length; i++) {
      const minute = Math.max(wetAt[i - 1]!, wetAt[i]!);
      if (!Number.isFinite(minute)) { flush(); continue; }
      if (run && run.minute === minute) run.path.push(points[i]!);
      else { flush(); run = { minute, path: [points[i - 1]!, points[i]!] }; }
    }
    flush();
  }
  out.sort((a, b) => a.fromMinute - b.fromMinute || b.length - a.length);
  return out.slice(0, MAX_FLOODED_ROADS).map(({ length: _length, ...road }) => road);
}

export interface FloodResult {
  flood: FloodForecast;
  affectedRoads: AffectedRoad[];
}

/**
 * `elevations` lines up with `floodSamplePoints(origin)`; null (or unusable) gives an even circle.
 * `roads` is null when the map data could not be loaded. `text` is what callers said, for the source.
 */
export function forecastFlood(origin: GeoPoint, severity: IncidentSeverity, elevations: readonly number[] | null, roads: RoadWay[] | null, text = ""): FloodResult {
  const frame = localFrame(origin);
  const reach = FLOOD_REACH_METERS[severity];
  const factors = reachFactors(elevations);
  const rings = FLOOD_MINUTES.map((minute) => ({ minute, ring: waterRing(reach, factors, minute) }));
  const affectedRoads = roads ? floodedRoads(frame, rings, roads) : [];

  const source = WATER_MAIN.test(text) ? "the water main break" : "the flooding";
  const far = rings[rings.length - 1]!.ring.reduce((best, p) => (Math.hypot(...p) > Math.hypot(...best) ? p : best));
  const lowSide = factors && Math.max(...factors) - Math.min(...factors) > 0.05 ? `, farthest to the ${compass((Math.atan2(far[0], far[1]) * 180) / Math.PI)} where the ground is lower` : "";
  const names = [...new Set(affectedRoads.flatMap((r) => r.road ?? []))];
  const roadText = !roads ? "" : names.length
    ? ` Water could cover ${names.slice(0, MAX_ROADS_IN_SUMMARY).join(", ")}${names.length > MAX_ROADS_IN_SUMMARY ? ` and ${names.length - MAX_ROADS_IN_SUMMARY} more` : ""}.`
    : affectedRoads.length ? " Water could cover unnamed roads nearby." : " No mapped road is under water within 30 minutes.";
  return {
    flood: {
      steps: rings.map(({ minute, ring }) => ({ minute, water: ring.map(frame.toPoint) })),
      summary: `Water from ${source} could spread about ${Math.round(reach)} m by 30 minutes${lowSide}.${roadText}`,
      assumptions: [
        "Illustrative spread model, not a hydraulic simulation or a measured flood.",
        "Water arrives at a steady rate from the reported spot, so the wet area grows with time. Drains, curbs, buildings and shut-off valves are not modeled.",
        severity === "unknown"
          ? `Severity was not given, so it is treated as serious: about ${reach} m by 30 minutes on flat ground.`
          : `A ${severity} report is assumed to reach about ${reach} m by 30 minutes on flat ground.`,
        factors
          ? "Ground elevation comes from Open-Meteo (about 90 m resolution), sampled up to 450 m around the spot. Water reaches farther downhill and less far uphill."
          : "Ground elevation was unavailable, so water spreads as an even circle.",
        roads ? "Roads come from OpenStreetMap and may be incomplete. A road counts as flooded where the modeled water covers it." : "Roads could not be loaded, so flooded roads are not listed.",
      ],
    },
    affectedRoads,
  };
}
