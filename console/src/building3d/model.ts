// Architectural model of the incident building, ported from the headset's
// createIncidentBuilding (headset/src/scene-assets/incident-building.scene-asset.ts)
// so both views share proportions. Materials take colours from the theme.
// Buildings without a mapped outline (the demo) get the original box shell; generated buildings
// with `profile.outline` get the same shell (plinth, slabs, glazing, mullions, parapet, entrance)
// following their real footprint.
import { BoxGeometry, Color, ExtrudeGeometry, Group, Mesh, MeshStandardMaterial, Shape, Vector2, type BufferGeometry } from "three";
import type { Building, Room } from "@firewatch/shared/types";
import type { Theme3D } from "./theme";

export const BUILDING_SCALE = 0.0145;
/** Storey height in model units (3.5 m). Wide, low buildings are drawn taller; see `floorScale`. */
export const FLOOR_HEIGHT = 3.5 * BUILDING_SCALE;

export interface RoomEntry {
  room: Room;
  mesh: Mesh;
  material: MeshStandardMaterial;
  shaft: boolean;
  /** Themed resting colour; the scene tints toward smoke/fire from here. */
  baseColor: Color;
}

export interface BuildingModel {
  /** Model root. Scaled by 1 / BUILDING_SCALE, so world units are metres. */
  root: Group;
  rooms: Map<string, RoomEntry>;
  floors: number;
  /** World-space (metres) footprint and height. */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number; height: number };
  /** Mapped footprint in world metres, already offset to the slab edge; null for box buildings. */
  slabOutline: [number, number][] | null;
  /** Vertical exaggeration of storeys (1 unless the footprint is far wider than the building is tall). */
  floorScale: number;
  /** World-space centre height of a floor's room volumes. */
  floorCenterY(floor: number): number;
  /** World-space slab (centre y, width, thickness, depth) at the base of a floor. */
  slab(floor: number): { y: number; w: number; h: number; d: number };
  applyTheme(theme: Theme3D): void;
  dispose(): void;
}

const isShaft = (room: Room) => room.kind ? room.kind === "stair" || room.kind === "elevator" : /-(stair|elev)(-|$)/.test(room.id);
const mix = (a: string, b: string, t: number) => new Color(a).lerp(new Color(b), t);

type Ring = [number, number][];

/** Twice the signed area (x right, z toward the viewer): > 0 when outward normals are (dz, -dx). */
const signedArea = (ring: Ring) => ring.reduce((sum, [x, z], i) => { const [nx, nz] = ring[(i + 1) % ring.length]!; return sum + x * nz - nx * z; }, 0);

/** Outward unit normal of each edge i -> i+1. */
function edgeNormals(ring: Ring): [number, number][] {
  const sign = signedArea(ring) >= 0 ? 1 : -1;
  return ring.map(([x, z], i) => {
    const [nx, nz] = ring[(i + 1) % ring.length]!;
    const length = Math.hypot(nx - x, nz - z) || 1;
    return [sign * (nz - z) / length, -sign * (nx - x) / length];
  });
}

/** Ring grown outward by `distance` (mitred corners, clamped so sharp corners don't spike). */
export function offsetRing(ring: Ring, distance: number): Ring {
  const normals = edgeNormals(ring);
  return ring.map(([x, z], i) => {
    const a = normals[(i - 1 + ring.length) % ring.length]!, b = normals[i]!;
    let mx = a[0] + b[0], mz = a[1] + b[1];
    const length = Math.hypot(mx, mz);
    if (length < 1e-6) { mx = b[0]; mz = b[1]; } else { mx /= length; mz /= length; }
    const cos = Math.max(0.35, mx * b[0] + mz * b[1]);
    return [x + (mx * distance) / cos, z + (mz * distance) / cos];
  });
}

/** Drops repeated and collinear points so edges are real facade segments. */
function cleanRing(ring: Ring): Ring {
  const out: Ring = [];
  for (const point of ring) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(point[0] - last[0], point[1] - last[1]) > 1e-3) out.push(point);
  }
  if (out.length > 1 && Math.hypot(out[0]![0] - out[out.length - 1]![0], out[0]![1] - out[out.length - 1]![1]) <= 1e-3) out.pop();
  return out.filter((point, i) => {
    const prev = out[(i - 1 + out.length) % out.length]!, next = out[(i + 1) % out.length]!;
    const cross = (point[0] - prev[0]) * (next[1] - point[1]) - (point[1] - prev[1]) * (next[0] - point[0]);
    return Math.abs(cross) > 1e-4 * Math.hypot(next[0] - prev[0], next[1] - prev[1]);
  });
}

export function createBuildingModel(building: Building, theme: Theme3D): BuildingModel {
  const root = new Group();
  root.name = "Incident building";
  const rooms = new Map<string, RoomEntry>();
  const concrete = new MeshStandardMaterial({ roughness: 0.85 });
  const frame = new MeshStandardMaterial({ metalness: 0.3, roughness: 0.5 });
  const glass = new MeshStandardMaterial({ transparent: true, opacity: 0.04, depthWrite: false, roughness: 0.2 });
  const door = new MeshStandardMaterial({ roughness: 0.3 });
  const unitBox = new BoxGeometry(1, 1, 1);
  const geometries: BufferGeometry[] = [unitBox];
  function box(name: string, x: number, y: number, z: number, w: number, h: number, d: number, material: MeshStandardMaterial, angle = 0) {
    const mesh = new Mesh(unitBox, material);
    mesh.name = name;
    mesh.position.set(x, y, z);
    mesh.scale.set(w, h, d);
    mesh.rotation.y = angle;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    root.add(mesh);
    return mesh;
  }
  const s = BUILDING_SCALE;
  const mapped = building.profile?.outline && building.profile.outline.length >= 3 ? cleanRing(building.profile.outline) : null;
  const outline = mapped && mapped.length >= 3 ? mapped : null;
  const xs = [...building.rooms.flatMap((r) => [r.x, r.x + r.w]), ...(outline ?? []).map(([x]) => x)];
  const zs = [...building.rooms.flatMap((r) => [r.z, r.z + r.d]), ...(outline ?? []).map(([, z]) => z)];
  const minX = Math.min(...xs) * s;
  const maxX = Math.max(...xs) * s;
  const minZ = Math.min(...zs) * s;
  const maxZ = Math.max(...zs) * s;
  const floors = Math.max(...building.rooms.map((r) => r.floor));
  const width = maxX - minX, depth = maxZ - minZ;
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  // A 2-storey, 120 m wide building would read as a flat sheet; stretch storeys (up to 2.5x) when the
  // footprint is much wider than the building is tall. The demo (38 m x 12 floors) stays at 1.
  const floorScale = Math.min(2.5, Math.max(1, Math.max(width, depth) / (floors * FLOOR_HEIGHT) / 3));
  const storey = FLOOR_HEIGHT * floorScale;
  const height = floors * storey;

  if (!outline) {
    box("Foundation plinth", cx, 0.005, cz, width + 0.035, 0.01, depth + 0.035, frame);
    for (let level = 0; level <= floors; level++) {
      box(level === floors ? "Roof slab" : `Floor plate ${level + 1}`, cx, 0.012 + level * storey, cz, width + 0.008, 0.004, depth + 0.008, concrete);
    }
    // Continuous glazing and structural mullions unify the individual room cells.
    for (const z of [minZ, maxZ]) {
      box("Curtain wall glazing", cx, 0.012 + height / 2, z, width, height, 0.001, glass);
      for (let bay = 0; bay <= 10; bay++) box("Vertical facade mullion", minX + (width * bay) / 10, 0.012 + height / 2, z, 0.002, height, 0.003, frame);
    }
    for (const x of [minX, maxX]) {
      box("Side glazing", x, 0.012 + height / 2, cz, 0.001, height, depth, glass);
      for (let bay = 0; bay <= 3; bay++) box("Side mullion", x, 0.012 + height / 2, minZ + (depth * bay) / 3, 0.003, height, 0.002, frame);
    }
    box("Entrance double doors", cx, 0.031, maxZ + 0.002, 0.045, 0.035, 0.003, door);
    box("Entrance canopy", cx, 0.055, maxZ + 0.014, 0.08, 0.004, 0.03, frame);
    box("Roof mechanical enclosure", cx - width * 0.23, height + 0.026, cz, 0.07, 0.025, 0.045, frame);
    for (const x of [minX, maxX]) box("Roof parapet", x, height + 0.02, cz, 0.004, 0.015, depth, concrete);
    for (const z of [minZ, maxZ]) box("Roof parapet", cx, height + 0.02, z, width, 0.015, 0.004, concrete);
  } else {
    const ring: Ring = outline.map(([x, z]) => [x * s, z * s]);
    // Extruded footprint slabs: shape (x, -z) extruded along +z, then turned so +z becomes up.
    const slabGeometry = (offset: number, thickness: number) => {
      const shape = new Shape(offsetRing(ring, offset).map(([x, z]) => new Vector2(x, -z)));
      const geometry = new ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
      geometry.rotateX(-Math.PI / 2);
      geometry.translate(0, -thickness / 2, 0);
      geometries.push(geometry);
      return geometry;
    };
    const slab = (name: string, geometry: BufferGeometry, y: number, material: MeshStandardMaterial) => {
      const mesh = new Mesh(geometry, material);
      mesh.name = name;
      mesh.position.set(0, y, 0);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      root.add(mesh);
    };
    slab("Foundation plinth", slabGeometry(0.0175, 0.01), 0.005, frame);
    const plate = slabGeometry(0.004, 0.004);
    for (let level = 0; level <= floors; level++) slab(level === floors ? "Roof slab" : `Floor plate ${level + 1}`, plate, 0.012 + level * storey, concrete);
    const normals = edgeNormals(ring);
    const edges = ring.map(([x, z], i) => {
      const [nx, nz] = ring[(i + 1) % ring.length]!;
      return { x, z, dx: nx - x, dz: nz - z, length: Math.hypot(nx - x, nz - z), normal: normals[i]!, angle: Math.atan2(-(nz - z), nx - x) };
    });
    // Mullions about every 3.8 m like the demo facade, thinned on very long perimeters.
    const perimeter = edges.reduce((sum, edge) => sum + edge.length, 0);
    const spacing = Math.max(3.8 * s, perimeter / 160);
    for (const edge of edges) {
      const mx = edge.x + edge.dx / 2, mz = edge.z + edge.dz / 2;
      box("Curtain wall glazing", mx, 0.012 + height / 2, mz, edge.length, height, 0.001, glass, edge.angle);
      const bays = Math.max(1, Math.round(edge.length / spacing));
      for (let bay = 0; bay < bays; bay++) box("Vertical facade mullion", edge.x + (edge.dx * bay) / bays, 0.012 + height / 2, edge.z + (edge.dz * bay) / bays, 0.002, height, 0.003, frame, edge.angle);
      box("Roof parapet", mx, height + 0.02, mz, edge.length, 0.015, 0.004, concrete, edge.angle);
    }
    // Entrance on the longest edge facing the viewer's side (+z, as on the demo), else the longest edge.
    const entrance = edges.reduce((best, edge) => edge.length * Math.max(0, edge.normal[1]) > best.length * Math.max(0, best.normal[1]) ? edge : best, edges[0]!);
    const front = entrance.normal[1] > 0 ? entrance : edges.reduce((best, edge) => edge.length > best.length ? edge : best, edges[0]!);
    const ex = front.x + front.dx / 2, ez = front.z + front.dz / 2;
    const doorWidth = Math.min(0.045, front.length * 0.6), canopyWidth = Math.min(0.08, front.length * 0.9);
    box("Entrance double doors", ex + front.normal[0] * 0.002, 0.031, ez + front.normal[1] * 0.002, doorWidth, 0.035, 0.003, door, front.angle);
    box("Entrance canopy", ex + front.normal[0] * 0.014, 0.055, ez + front.normal[1] * 0.014, canopyWidth, 0.004, 0.03, frame, front.angle);
    // Roof plant sits on the top floor's largest room, which is always inside the footprint.
    const top = building.rooms.filter((r) => r.floor === floors && !isShaft(r)).sort((a, b) => b.w * b.d - a.w * a.d)[0];
    if (top) box("Roof mechanical enclosure", (top.x + top.w / 2) * s, height + 0.026, (top.z + top.d / 2) * s, Math.min(0.07, top.w * s * 0.7), 0.025, Math.min(0.045, top.d * s * 0.7), frame);
  }

  for (const room of building.rooms) {
    const material = new MeshStandardMaterial({ transparent: true, opacity: 0.16, depthWrite: false, roughness: 0.3 });
    const mesh = box(`Room ${room.id}`, (room.x + room.w / 2) * s, 0.014 + (room.floor - 0.5) * storey, (room.z + room.d / 2) * s,
      room.w * s * 0.97, storey - 0.006, room.d * s * 0.97, material);
    mesh.userData.roomId = room.id;
    rooms.set(room.id, { room, mesh, material, shaft: isShaft(room), baseColor: new Color() });
  }
  root.scale.setScalar(1 / s);

  function applyTheme(theme: Theme3D) {
    concrete.color.copy(mix(theme.surface2, theme.muted, theme.isLight ? 0.2 : 0.1));
    frame.color.copy(mix(theme.line, theme.muted, theme.isLight ? 0.45 : 0.12));
    // Neutral glazing and doors, so green stays reserved for the evacuation route.
    glass.color.set(theme.text);
    door.color.copy(mix(theme.line, theme.muted, 0.35));
    const roomColor = new Color(theme.muted);
    // Stair and elevator shafts read as a quieter, cooler cell.
    const shaftColor = mix(theme.muted, theme.line, 0.55);
    for (const entry of rooms.values()) {
      entry.baseColor.copy(entry.shaft ? shaftColor : roomColor);
      entry.material.color.copy(entry.baseColor);
    }
  }
  applyTheme(theme);

  return {
    root,
    rooms,
    floors,
    bounds: { minX: minX / s, maxX: maxX / s, minZ: minZ / s, maxZ: maxZ / s, height: (0.012 + height) / s },
    slabOutline: outline ? offsetRing(outline, 0.004 / s) : null,
    floorScale,
    floorCenterY: (floor) => (0.014 + (floor - 0.5) * storey) / s,
    slab: (floor) => ({ y: (0.012 + (floor - 1) * storey) / s, w: (width + 0.008) / s, h: 0.004 / s, d: (depth + 0.008) / s }),
    applyTheme,
    dispose() {
      for (const geometry of geometries) geometry.dispose();
      for (const material of [concrete, frame, glass, door]) material.dispose();
      for (const entry of rooms.values()) entry.material.dispose();
    },
  };
}
