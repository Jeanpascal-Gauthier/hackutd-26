// Map zones: a fixed ~500 m grid, so incidents near each other can be grouped (same kind) or linked
// (different kinds). The grid is metric at a fixed reference latitude (33°N, the Dallas area), so a
// zone id never depends on which incident asked: rows are 500 m of latitude everywhere, columns are
// 500 m of longitude at 33°N (about 470 m at 38°N, 530 m at 28°N).
import type { GeoPoint } from "@firewatch/shared/types";
import { METRES_PER_DEGREE } from "../buildings/geometry.ts";
import { geoDistance } from "./geo.ts";

export const ZONE_METERS = 500;
/** Close by also needs this straight-line distance, so a diagonal neighbour 1.4 km off is not "close". */
export const CLOSE_BY_METERS = 700;
const REFERENCE_LAT = 33;
const ROW_DEGREES = ZONE_METERS / METRES_PER_DEGREE;
const COL_DEGREES = ZONE_METERS / (METRES_PER_DEGREE * Math.cos((REFERENCE_LAT * Math.PI) / 180));

export const zoneCell = ({ lat, lon }: GeoPoint): [row: number, col: number] => [Math.floor(lat / ROW_DEGREES), Math.floor(lon / COL_DEGREES)];

/** "z:<row>:<col>" */
export function zoneId(p: GeoPoint): string {
  const [row, col] = zoneCell(p);
  return `z:${row}:${col}`;
}

/** The 3×3 block of zone ids around `p`, its own first. */
export function neighbourZones(p: GeoPoint): string[] {
  const [row, col] = zoneCell(p);
  const ids = [`z:${row}:${col}`];
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (dr || dc) ids.push(`z:${row + dr}:${col + dc}`);
  return ids;
}

/** Same or adjacent zone, and within CLOSE_BY_METERS. Symmetric. */
export function closeBy(a: GeoPoint, b: GeoPoint): boolean {
  const [ra, ca] = zoneCell(a);
  const [rb, cb] = zoneCell(b);
  return Math.abs(ra - rb) <= 1 && Math.abs(ca - cb) <= 1 && geoDistance(a, b) <= CLOSE_BY_METERS;
}
