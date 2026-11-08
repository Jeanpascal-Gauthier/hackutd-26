// Small plane-geometry helpers for turning public footprints into generated floor plans.
// Pure functions on [x, z] points in metres. Rings are open (no repeated closing point).
import type { AreaGeometry, Coordinates, Position } from "./types.ts";

export type Pt = [number, number];
/** Outer ring first, then holes. */
export type Shape = Pt[][];
export interface Rect { x0: number; z0: number; x1: number; z1: number }

/** Metres per degree of latitude (WGS84 equatorial radius; good to well under 1% at building scale). */
export const METRES_PER_DEGREE = (Math.PI / 180) * 6378137;

/** Rounds to centimetres, without producing -0. */
export const r2 = (v: number): number => Math.round(v * 100) / 100 || 0;

/** Equirectangular projection around `origin`: x = metres east, z = metres south. */
export function projector(origin: Coordinates): (p: Position) => Pt {
  const kx = Math.cos((origin.lat * Math.PI) / 180) * METRES_PER_DEGREE;
  return ([lon, lat]) => [(lon - origin.lon) * kx, -(lat - origin.lat) * METRES_PER_DEGREE];
}

/** Polygons of an area geometry, each as [outer, ...holes] in [lon, lat]. */
export const polygonsOf = (area: AreaGeometry): Position[][][] => (area.type === "Polygon" ? [area.coordinates] : area.coordinates);

/** Drops the closing point and consecutive duplicates. */
export function openRing<T extends Pt | Position>(ring: T[]): T[] {
  const out: T[] = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last[0] - p[0]) > 1e-12 || Math.abs(last[1] - p[1]) > 1e-12) out.push(p);
  }
  while (out.length > 1 && Math.abs(out[0][0] - out[out.length - 1][0]) <= 1e-12 && Math.abs(out[0][1] - out[out.length - 1][1]) <= 1e-12) out.pop();
  return out;
}

/** Signed shoelace area of an open ring. */
export function ringArea(ring: readonly (Pt | Position)[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return a / 2;
}

export function shapeArea(shape: Shape): number {
  const [outer, ...holes] = shape;
  return Math.abs(ringArea(outer)) - holes.reduce((n, h) => n + Math.abs(ringArea(h)), 0);
}

/** The polygon (of a Polygon or MultiPolygon) whose outer ring encloses the most area. */
export function largestPolygon(area: AreaGeometry): Position[][] {
  const polys = polygonsOf(area);
  let best = polys[0];
  for (const p of polys) if (Math.abs(ringArea(openRing(p[0]))) > Math.abs(ringArea(openRing(best[0])))) best = p;
  return best;
}

export function bbox(points: readonly Pt[]): { minX: number; maxX: number; minZ: number; maxZ: number } {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minZ, maxZ };
}

/** Even-odd ray cast. Points exactly on the boundary may fall either way. */
export function pointInRing(p: Pt, ring: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

export function pointInShape(p: Pt, shape: Shape): boolean {
  const [outer, ...holes] = shape;
  return pointInRing(p, outer) && !holes.some((h) => pointInRing(p, h));
}

const orient = (a: Pt, b: Pt, c: Pt) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
/** True when segments ab and cd cross at a single interior point of both. */
function properCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

/**
 * True when the rectangle, shrunk by `eps` on every side, lies inside the shape: its corners are
 * inside, no ring vertex is inside it, and no ring edge crosses its edges.
 */
export function rectInside(r: Rect, shape: Shape, eps = 0.02): boolean {
  const x0 = r.x0 + eps, x1 = r.x1 - eps, z0 = r.z0 + eps, z1 = r.z1 - eps;
  if (!(x1 > x0 && z1 > z0)) return false;
  const corners: Pt[] = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
  if (!corners.every((c) => pointInShape(c, shape))) return false;
  for (const ring of shape) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const v = ring[i];
      if (v[0] > x0 && v[0] < x1 && v[1] > z0 && v[1] < z1) return false;
      const u = ring[j];
      // Cheap reject: edge's bounding box misses the rectangle.
      if (Math.max(u[0], v[0]) < x0 || Math.min(u[0], v[0]) > x1 || Math.max(u[1], v[1]) < z0 || Math.min(u[1], v[1]) > z1) continue;
      for (let k = 0; k < 4; k++) if (properCross(u, v, corners[k], corners[(k + 1) % 4])) return false;
    }
  }
  return true;
}

/** Andrew's monotone chain; counter-clockwise in (x, z), no repeated point. */
export function convexHull(points: readonly Pt[]): Pt[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const lower: Pt[] = [], upper: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && orient(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && orient(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Rotates a point by -angle (so a direction at `angle` ends up along +x). */
export const rotate = ([x, z]: Pt, angle: number): Pt => {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [x * c + z * s, -x * s + z * c];
};

/**
 * Direction (radians, in (-pi/2, pi/2]) of the long side of the minimum-area bounding rectangle.
 * Rotating every point by -angle lays that long side along x.
 */
export function longAxisAngle(points: readonly Pt[]): number {
  const hull = convexHull(points);
  if (hull.length < 3) return 0;
  const norm = (a: number) => {
    while (a > Math.PI / 2 + 1e-12) a -= Math.PI;
    while (a <= -Math.PI / 2 + 1e-12) a += Math.PI;
    return a;
  };
  let best = { area: Infinity, angle: 0, w: 0, d: 0 };
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const angle = norm(Math.atan2(b[1] - a[1], b[0] - a[0]));
    const box = bbox(hull.map((p) => rotate(p, angle)));
    const w = box.maxX - box.minX, d = box.maxZ - box.minZ, area = w * d;
    const better = area < best.area * (1 - 1e-9) || (Math.abs(area - best.area) <= best.area * 1e-9 && Math.abs(angle) < Math.abs(best.angle));
    if (better) best = { area, angle, w, d };
  }
  return best.d > best.w * (1 + 1e-9) ? norm(best.angle + Math.PI / 2) : best.angle;
}

/**
 * Visvalingam–Whyatt: drops the vertex that adds the least area until at most `max` remain,
 * and drops near-collinear vertices (< 0.01 m²) regardless.
 */
export function simplifyRing(ring: readonly Pt[], max: number): Pt[] {
  const pts = [...ring];
  const tri = (i: number) => {
    const n = pts.length;
    return Math.abs(orient(pts[(i - 1 + n) % n], pts[i], pts[(i + 1) % n])) / 2;
  };
  while (pts.length > 3) {
    let at = 0, min = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const a = tri(i);
      if (a < min) { min = a; at = i; }
    }
    if (pts.length <= max && min >= 0.01) break;
    pts.splice(at, 1);
  }
  return pts;
}

export function distanceToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dz));
}

export function distanceToRing(p: Pt, ring: readonly Pt[]): number {
  let d = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) d = Math.min(d, distanceToSegment(p, ring[j], ring[i]));
  return d;
}

/** Largest axis-aligned rectangle made of grid cells that lie inside the shape (maximal-histogram method). */
export function largestInscribedRect(shape: Shape): Rect | null {
  const box = bbox(shape[0]);
  const W = box.maxX - box.minX, D = box.maxZ - box.minZ;
  const cell = Math.max(0.25, Math.max(W, D) / 120);
  const nx = Math.max(1, Math.floor(W / cell)), nz = Math.max(1, Math.floor(D / cell));
  const heights = new Array<number>(nx).fill(0);
  let best: Rect | null = null, bestArea = 0;
  for (let j = 0; j < nz; j++) {
    const z0 = box.minZ + j * cell;
    for (let i = 0; i < nx; i++) {
      const x0 = box.minX + i * cell;
      heights[i] = rectInside({ x0, z0, x1: x0 + cell, z1: z0 + cell }, shape, 0.001) ? heights[i] + 1 : 0;
    }
    // Largest rectangle in the histogram ending at row j.
    const stack: number[] = [];
    for (let i = 0; i <= nx; i++) {
      const h = i < nx ? heights[i] : 0;
      while (stack.length && heights[stack[stack.length - 1]] >= h) {
        const top = stack.pop()!;
        const height = heights[top];
        const left = stack.length ? stack[stack.length - 1] + 1 : 0;
        const area = height * (i - left);
        if (height > 0 && area > bestArea) {
          bestArea = area;
          best = { x0: box.minX + left * cell, x1: box.minX + i * cell, z0: box.minZ + (j - height + 1) * cell, z1: box.minZ + (j + 1) * cell };
        }
      }
      stack.push(i);
    }
  }
  return best;
}
