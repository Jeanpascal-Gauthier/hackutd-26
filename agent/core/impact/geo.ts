// Small geometry helpers for the impact tools. Metres and compass degrees (0 = north, 90 = east).
import type { GeoPoint } from "@firewatch/shared/types";

const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Great-circle distance in metres. */
export function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Compass bearing from a to b, 0..360. */
export function bearingDegrees(a: GeoPoint, b: GeoPoint): number {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** Smallest angle between two bearings, 0..180. */
export function angleBetween(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
}

/** The point `meters` from `p` toward `bearing`. Flat-earth; fine below a few km. */
export function offsetPoint(p: GeoPoint, meters: number, bearing: number): GeoPoint {
  const dn = meters * Math.cos(rad(bearing));
  const de = meters * Math.sin(rad(bearing));
  return { lat: p.lat + deg(dn / R), lon: p.lon + deg(de / (R * Math.cos(rad(p.lat)))) };
}

/** Ray-casting point-in-polygon. `ring` is closed without the first point repeated. */
export function insidePolygon(p: GeoPoint, ring: GeoPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a.lat > p.lat !== b.lat > p.lat && p.lon < ((b.lon - a.lon) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lon) inside = !inside;
  }
  return inside;
}

/** Wind "from" degrees -> the direction smoke travels toward. */
export const downwindOf = (fromDegrees: number) => (fromDegrees + 180) % 360;

/**
 * How far a blast zone reaches toward `bearing`: `radiusMeters` upwind/sideways, growing smoothly
 * to `radiusMeters * stretch.factor` straight along `stretch.towardDegrees`.
 */
export function reachMeters(impact: { radiusMeters: number; stretch?: { towardDegrees: number; factor: number } }, bearing: number): number {
  const s = impact.stretch;
  if (!s || s.factor <= 1) return impact.radiusMeters;
  const along = Math.max(0, Math.cos(rad(angleBetween(bearing, s.towardDegrees))));
  return impact.radiusMeters * (1 + (s.factor - 1) * along);
}

/** True when `p` lies inside the (possibly stretched) blast zone. */
export function insideImpact(
  impact: { center: GeoPoint; radiusMeters: number; stretch?: { towardDegrees: number; factor: number } },
  p: GeoPoint,
): boolean {
  return distanceMeters(impact.center, p) <= reachMeters(impact, bearingDegrees(impact.center, p));
}
