// Small flat-earth helpers. Forecasts cover a few kilometres, where this is accurate enough.
import type { GeoPoint } from "@firewatch/shared/types";
import { METRES_PER_DEGREE } from "../buildings/geometry.ts";

/** Metres from an origin: [east, north]. */
export type Metres = [number, number];

export const FORECAST_MINUTES = [5, 10, 15, 20, 30] as const;
export const HORIZON_MINUTES = 30;

export const roundPoint = ({ lat, lon }: GeoPoint): GeoPoint => ({ lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5 });

export function localFrame(origin: GeoPoint) {
  const cos = Math.cos((origin.lat * Math.PI) / 180);
  return {
    toMetres: (p: GeoPoint): Metres => [(p.lon - origin.lon) * METRES_PER_DEGREE * cos, (p.lat - origin.lat) * METRES_PER_DEGREE],
    toPoint: ([east, north]: Metres): GeoPoint => roundPoint({ lat: origin.lat + north / METRES_PER_DEGREE, lon: origin.lon + east / (METRES_PER_DEGREE * cos) }),
  };
}

export const distance = (a: Metres, b: Metres) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const geoDistance = (a: GeoPoint, b: GeoPoint) => distance(localFrame(a).toMetres(b), [0, 0]);
/** Compass bearing of `m` from the origin, in radians (0 = north, clockwise). */
export const bearingOf = ([east, north]: Metres) => Math.atan2(east, north);
export const radians = (degrees: number) => (degrees * Math.PI) / 180;
/** The offset `range` metres away on a compass bearing. */
export const offset = (bearing: number, range: number): Metres => [Math.sin(bearing) * range, Math.cos(bearing) * range];

const COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
export const compass = (degrees: number) => COMPASS[Math.round((((degrees % 360) + 360) % 360) / 45) % 8]!;
