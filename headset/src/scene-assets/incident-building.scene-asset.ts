import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from '@iwsdk/core';
import type { Building } from '../incident-types.js';

export const BUILDING_SCALE = 0.0145;
export const FLOOR_HEIGHT = 3.5 * BUILDING_SCALE;

/** Tabletop architectural model derived from the same footprint as the incident. */
export function createIncidentBuilding(building: Building) {
  const root = new Group();
  root.name = 'Incident building';
  const roomMaterials = new Map<string, MeshStandardMaterial>();
  const concrete = new MeshStandardMaterial({ color: '#c3c9cb', roughness: 0.85 });
  const frame = new MeshStandardMaterial({ color: '#42505c', metalness: 0.45, roughness: 0.4 });
  const glass = new MeshStandardMaterial({ color: '#468caa', transparent: true, opacity: 0.1, depthWrite: false, roughness: 0.2 });
  const door = new MeshStandardMaterial({ color: '#19485b', roughness: 0.25 });
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
  box('Foundation plinth', cx, 0.005, cz, width + 0.035, 0.01, depth + 0.035, frame);
  for (let level = 0; level <= floors; level++) {
    box(level === floors ? 'Roof slab' : `Floor plate ${level + 1}`, cx, 0.012 + level * FLOOR_HEIGHT, cz, width + 0.008, 0.004, depth + 0.008, concrete);
  }
  // Continuous glazing and structural mullions unify the individual room cells.
  for (const z of [minZ, maxZ]) {
    box('Curtain wall glazing', cx, 0.012 + height / 2, z, width, height, 0.001, glass);
    for (let bay = 0; bay <= 10; bay++) {
      box('Vertical facade mullion', minX + width * bay / 10, 0.012 + height / 2, z, 0.002, height, 0.003, frame);
    }
  }
  for (const x of [minX, maxX]) {
    box('Side glazing', x, 0.012 + height / 2, cz, 0.001, height, depth, glass);
    for (let bay = 0; bay <= 3; bay++) {
      box('Side mullion', x, 0.012 + height / 2, minZ + depth * bay / 3, 0.003, height, 0.002, frame);
    }
  }
  box('Entrance double doors', cx, 0.031, maxZ + 0.002, 0.045, 0.035, 0.003, door);
  box('Entrance canopy', cx, 0.055, maxZ + 0.014, 0.08, 0.004, 0.03, frame);
  box('Roof mechanical enclosure', cx - width * 0.23, height + 0.026, cz, 0.07, 0.025, 0.045, frame);
  for (const x of [minX, maxX]) box('Roof parapet', x, height + 0.02, cz, 0.004, 0.015, depth, concrete);
  for (const z of [minZ, maxZ]) box('Roof parapet', cx, height + 0.02, z, width, 0.015, 0.004, concrete);
  for (const room of building.rooms) {
    const material = new MeshStandardMaterial({ color: '#a1c9d5', transparent: true, opacity: 0.16, depthWrite: false, roughness: 0.3 });
    box(`Room ${room.id}`, (room.x + room.w / 2) * s,
      0.014 + (room.floor - 0.5) * FLOOR_HEIGHT, (room.z + room.d / 2) * s,
      room.w * s * 0.97, FLOOR_HEIGHT - 0.006, room.d * s * 0.97, material);
    roomMaterials.set(room.id, material);
  }
  return { root, roomMaterials };
}
