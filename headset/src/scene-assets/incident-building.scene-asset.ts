import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from '@iwsdk/core';
import type { Building } from '../incident-types.js';

export const BUILDING_SCALE = 0.0145;
export const FLOOR_HEIGHT = 3.5 * BUILDING_SCALE;

/** Tabletop architectural model derived from the same footprint as the incident. */
export function createIncidentBuilding(building: Building) {
  const root = new Group();
  root.name = 'Incident building';
  const roomMaterials = new Map<string, MeshStandardMaterial>();
  const concrete = new MeshStandardMaterial({ color: '#edeae1', roughness: 0.9 });
  const frame = new MeshStandardMaterial({ color: '#d2d2c9', roughness: 0.75 });
  const plinth = new MeshStandardMaterial({ color: '#555951', roughness: 0.9 });
  const glass = new MeshStandardMaterial({ color: '#a9bbb9', transparent: true, opacity: 0.08, depthWrite: false, roughness: 0.45 });
  const door = new MeshStandardMaterial({ color: '#8e9c96', roughness: 0.6 });
  const unitBox = new BoxGeometry(1, 1, 1);
  function box(name: string, x: number, y: number, z: number, w: number, h: number, d: number, material: MeshStandardMaterial) {
    const mesh = new Mesh(unitBox, material);
    mesh.name = name;
    mesh.position.set(x, y, z);
    mesh.scale.set(w, h, d);
    root.add(mesh);
    return mesh;
  }
  const s = BUILDING_SCALE;
  const minX = Math.min(...building.rooms.map(r => r.x)) * s;
  const maxX = Math.max(...building.rooms.map(r => r.x + r.w)) * s;
  const minZ = Math.min(...building.rooms.map(r => r.z)) * s;
  const maxZ = Math.max(...building.rooms.map(r => r.z + r.d)) * s;
  const floors = Math.max(...building.rooms.map(r => r.floor));
  const width = maxX - minX, depth = maxZ - minZ;
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const height = floors * FLOOR_HEIGHT;
  box('Graphite presentation plinth', cx, 0.005, cz, width + 0.055, 0.01, depth + 0.055, plinth);
  for (let level = 0; level <= floors; level++) {
    box(level === floors ? 'Roof slab' : `Floor plate ${level + 1}`, cx, 0.012 + level * FLOOR_HEIGHT, cz, width + 0.008, 0.004, depth + 0.008, concrete);
  }
  // Two retained elevations establish the envelope; the near/right sides stay
  // open as an architectural section, exposing incident rooms without glass.
  for (const z of [minZ]) {
    box('Curtain wall glazing', cx, 0.012 + height / 2, z, width, height, 0.001, glass);
    for (let bay = 0; bay <= 8; bay++) {
      box('Vertical facade mullion', minX + width * bay / 8, 0.012 + height / 2, z, 0.002, height, 0.003, frame);
    }
  }
  for (const x of [minX]) {
    box('Side glazing', x, 0.012 + height / 2, cz, 0.001, height, depth, glass);
    for (let bay = 0; bay <= 3; bay++) {
      box('Side mullion', x, 0.012 + height / 2, minZ + depth * bay / 3, 0.003, height, 0.002, frame);
    }
  }
  for (let bay = 0; bay <= 4; bay++) {
    box('Exposed structural column', minX + width * bay / 4, 0.012 + height / 2, maxZ - 0.004,
      0.0035, height, 0.0035, concrete);
  }
  box('Entrance double doors', cx, 0.031, minZ - 0.002, 0.045, 0.035, 0.003, door);
  box('Entrance canopy', cx, 0.055, minZ - 0.014, 0.08, 0.004, 0.03, concrete);
  box('Roof mechanical enclosure', cx - width * 0.23, height + 0.026, cz, 0.07, 0.025, 0.045, frame);
  for (const x of [minX, maxX]) box('Roof parapet', x, height + 0.02, cz, 0.004, 0.015, depth, concrete);
  for (const z of [minZ, maxZ]) box('Roof parapet', cx, height + 0.02, z, width, 0.015, 0.004, concrete);
  for (const room of building.rooms) {
    // Low sectional partitions describe the real room footprint while leaving
    // room-height hazard volumes visible over the top. They are diagrammatic.
    const baseY = 0.016 + (room.floor - 1) * FLOOR_HEIGHT;
    const partitionHeight = FLOOR_HEIGHT * 0.38;
    if (room.x * s > minX + 0.001) {
      box(`Section partition ${room.id}`, room.x * s, baseY + partitionHeight / 2,
        (room.z + room.d / 2) * s, 0.0015, partitionHeight, room.d * s, concrete);
    }
    box(`Room boundary ${room.id}`, (room.x + room.w / 2) * s, baseY + 0.001,
      room.z * s, room.w * s, 0.002, 0.0015, frame);
    const material = new MeshStandardMaterial({ color: '#ece8de', transparent: true, opacity: 0.06, depthWrite: false, roughness: 0.7 });
    box(`Room ${room.id}`, (room.x + room.w / 2) * s,
      0.014 + (room.floor - 0.5) * FLOOR_HEIGHT, (room.z + room.d / 2) * s,
      room.w * s * 0.97, FLOOR_HEIGHT - 0.006, room.d * s * 0.97, material);
    roomMaterials.set(room.id, material);
  }
  return { root, roomMaterials };
}
