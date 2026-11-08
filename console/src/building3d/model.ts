// Architectural model of the incident building, ported from the headset's
// createIncidentBuilding (headset/src/scene-assets/incident-building.scene-asset.ts)
// so both views share proportions. Materials take colours from the theme.
import { BoxGeometry, Color, Group, Mesh, MeshStandardMaterial } from "three";
import type { Room } from "@firewatch/shared/types";
import type { Theme3D } from "./theme";

export const BUILDING_SCALE = 0.0145;
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
  /** World-space centre height of a floor's room volumes. */
  floorCenterY(floor: number): number;
  /** World-space slab (centre y, width, thickness, depth) at the base of a floor. */
  slab(floor: number): { y: number; w: number; h: number; d: number };
  applyTheme(theme: Theme3D): void;
  dispose(): void;
}

const isShaft = (room: Room) => /-(stair|elev)-/.test(room.id);
const mix = (a: string, b: string, t: number) => new Color(a).lerp(new Color(b), t);

export function createBuildingModel(building: { rooms: Room[] }, theme: Theme3D): BuildingModel {
  const root = new Group();
  root.name = "Incident building";
  const rooms = new Map<string, RoomEntry>();
  const concrete = new MeshStandardMaterial({ roughness: 0.85 });
  const frame = new MeshStandardMaterial({ metalness: 0.3, roughness: 0.5 });
  const glass = new MeshStandardMaterial({ transparent: true, opacity: 0.04, depthWrite: false, roughness: 0.2 });
  const door = new MeshStandardMaterial({ roughness: 0.3 });
  const unitBox = new BoxGeometry(1, 1, 1);
  function box(name: string, x: number, y: number, z: number, w: number, h: number, d: number, material: MeshStandardMaterial) {
    const mesh = new Mesh(unitBox, material);
    mesh.name = name;
    mesh.position.set(x, y, z);
    mesh.scale.set(w, h, d);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    root.add(mesh);
    return mesh;
  }
  const s = BUILDING_SCALE;
  const minX = Math.min(...building.rooms.map((r) => r.x)) * s;
  const maxX = Math.max(...building.rooms.map((r) => r.x + r.w)) * s;
  const minZ = Math.min(...building.rooms.map((r) => r.z)) * s;
  const maxZ = Math.max(...building.rooms.map((r) => r.z + r.d)) * s;
  const floors = Math.max(...building.rooms.map((r) => r.floor));
  const width = maxX - minX, depth = maxZ - minZ;
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const height = floors * FLOOR_HEIGHT;
  box("Foundation plinth", cx, 0.005, cz, width + 0.035, 0.01, depth + 0.035, frame);
  for (let level = 0; level <= floors; level++) {
    box(level === floors ? "Roof slab" : `Floor plate ${level + 1}`, cx, 0.012 + level * FLOOR_HEIGHT, cz, width + 0.008, 0.004, depth + 0.008, concrete);
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
  for (const room of building.rooms) {
    const material = new MeshStandardMaterial({ transparent: true, opacity: 0.16, depthWrite: false, roughness: 0.3 });
    const mesh = box(`Room ${room.id}`, (room.x + room.w / 2) * s, 0.014 + (room.floor - 0.5) * FLOOR_HEIGHT, (room.z + room.d / 2) * s,
      room.w * s * 0.97, FLOOR_HEIGHT - 0.006, room.d * s * 0.97, material);
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
    floorCenterY: (floor) => (0.014 + (floor - 0.5) * FLOOR_HEIGHT) / s,
    slab: (floor) => ({ y: (0.012 + (floor - 1) * FLOOR_HEIGHT) / s, w: (width + 0.008) / s, h: 0.004 / s, d: (depth + 0.008) / s }),
    applyTheme,
    dispose() {
      unitBox.dispose();
      for (const material of [concrete, frame, glass, door]) material.dispose();
      for (const entry of rooms.values()) entry.material.dispose();
    },
  };
}
