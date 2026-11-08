// Street flooding from a burst main or heavy runoff: water spreads outward from the reported spot,
// and every road section it reaches turns red. Deliberately simple; the assumptions travel with the
// result. There is no elevation data yet, so the water spreads evenly in every direction.
import type { AffectedRoad, FloodForecast, GeoPoint, IncidentSeverity } from "@firewatch/shared/types";
import type { RoadWay } from "./crashModel.ts";
import { FORECAST_MINUTES, HORIZON_MINUTES, geoDistance, localFrame, offset, type Metres } from "./geo.ts";

const START_RADIUS = 25; // metres already under water at minute 0
/** Metres per minute the edge of the water advances. A burst main keeps pushing; runoff slows down. */
const SPREAD_RATE: Record<IncidentSeverity, number> = { minor: 4, serious: 7, critical: 10, unknown: 7 };
const RING_POINTS = 36;
const MAX_ROAD_SECTIONS = 200;

export const floodRadius = (severity: IncidentSeverity, minute: number) => START_RADIUS + SPREAD_RATE[severity] * minute;

/** First forecast step (minute) by which the water reaches `range` metres out, or null beyond the horizon. */
function arrival(severity: IncidentSeverity, range: number): number | null {
  const minute = Math.max(0, (range - START_RADIUS) / SPREAD_RATE[severity]);
  if (minute > HORIZON_MINUTES) return null;
  return FORECAST_MINUTES.find((step) => step >= minute) ?? HORIZON_MINUTES;
}

export interface FloodResult {
  flood: FloodForecast;
  /** Road sections the water covers within the horizon, red from the minute it arrives. */
  roads: AffectedRoad[];
}

/** Water from `origin` over the next 30 minutes, and the roads it cuts. */
export function forecastFlood(origin: GeoPoint, ways: RoadWay[], severity: IncidentSeverity, source?: string): FloodResult {
  const frame = localFrame(origin);
  const steps = FORECAST_MINUTES.map((minute) => {
    const radius = floodRadius(severity, minute);
    const ring: Metres[] = Array.from({ length: RING_POINTS }, (_, i) => offset((i / RING_POINTS) * 2 * Math.PI, radius));
    return { minute, water: ring.map(frame.toPoint) };
  });

  const roads: AffectedRoad[] = [];
  for (const way of ways) {
    let run: GeoPoint[] = [];
    let runMinute: number | null = null;
    const flush = () => {
      if (run.length >= 2 && runMinute !== null) roads.push({ path: run, road: way.name, reason: "flood", fromMinute: runMinute });
      run = [];
      runMinute = null;
    };
    for (let i = 0; i + 1 < way.geometry.length; i++) {
      const a = way.geometry[i]!;
      const b = way.geometry[i + 1]!;
      // The nearest of the section's ends and middle decides when the water gets there.
      const middle = { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
      const minute = arrival(severity, Math.min(geoDistance(origin, a), geoDistance(origin, b), geoDistance(origin, middle)));
      if (minute === null) {
        flush();
        continue;
      }
      if (runMinute !== null && minute !== runMinute) flush();
      if (run.length === 0) run.push(a);
      run.push(b);
      runMinute = minute;
    }
    flush();
  }
  roads.sort((x, y) => x.fromMinute - y.fromMinute);
  roads.length = Math.min(roads.length, MAX_ROAD_SECTIONS);

  const names = [...new Set(roads.map((road) => road.road).filter((name): name is string => !!name))];
  const reach = Math.round(floodRadius(severity, HORIZON_MINUTES));
  const where = source ? ` from ${source}` : "";
  const summary =
    `Water spreads${where} to about ${reach} m in ${HORIZON_MINUTES} min` +
    (names.length ? `, flooding ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""}.` : ".");
  return {
    flood: {
      steps,
      summary,
      assumptions: [
        "Modeled, not observed: water spreads evenly in every direction.",
        `The edge advances about ${SPREAD_RATE[severity]} m per minute, starting from ${START_RADIUS} m.`,
        "Elevation is not used yet, so low ground does not flood first.",
        "A road section turns red when the water edge reaches it.",
      ],
    },
    roads,
  };
}
