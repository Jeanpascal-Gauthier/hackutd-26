import {
  BoxGeometry, BufferGeometry, ConeGeometry, EdgesGeometry, Float32BufferAttribute, Group, InstancedMesh, LineBasicMaterial,
  LineSegments, Mesh, MeshStandardMaterial,
} from '@iwsdk/core';
import type { Building } from '../incident-types.js';

export const BUILDING_SCALE = 0.0145;
export const FLOOR_HEIGHT = 3.5 * BUILDING_SCALE;

// Static envelope pieces (slabs, columns, mullions, partitions, boundary
// frames) share one of a handful of materials and never change after build
// time, so they are batched by material into one draw call each instead of
// one draw call per box — Quest 2's draw-call budget is the bottleneck here,
// not triangle count. Only the per-room hazard volumes stay as individual
// meshes, since BuildingSystem mutates their material live for fire/smoke/
// route tinting and each room needs its own material instance for that.
const unitBoxTemplate = new BoxGeometry(1, 1, 1).toNonIndexed();
const templatePosition = unitBoxTemplate.attributes.position.array as Float32Array;
const templateNormal = unitBoxTemplate.attributes.normal.array as Float32Array;
const templateUv = unitBoxTemplate.attributes.uv.array as Float32Array;
const VERTS_PER_BOX = templatePosition.length / 3;

interface StaticBox { x: number; y: number; z: number; w: number; h: number; d: number; }

function mergeStaticBoxes(entries: StaticBox[]): BufferGeometry {
  const position = new Float32Array(entries.length * VERTS_PER_BOX * 3);
  const normal = new Float32Array(entries.length * VERTS_PER_BOX * 3);
  const uv = new Float32Array(entries.length * VERTS_PER_BOX * 2);
  entries.forEach((entry, i) => {
    const p3 = i * VERTS_PER_BOX * 3;
    for (let v = 0; v < VERTS_PER_BOX; v++) {
      position[p3 + v * 3] = templatePosition[v * 3] * entry.w + entry.x;
      position[p3 + v * 3 + 1] = templatePosition[v * 3 + 1] * entry.h + entry.y;
      position[p3 + v * 3 + 2] = templatePosition[v * 3 + 2] * entry.d + entry.z;
    }
    normal.set(templateNormal, p3);
    uv.set(templateUv, i * VERTS_PER_BOX * 2);
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(position, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normal, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  return geometry;
}

/** Tabletop architectural model derived from the same footprint as the incident. */
export function createIncidentBuilding(building: Building) {
  const root = new Group();
  root.name = 'Incident building';
  const roomMaterials = new Map<string, MeshStandardMaterial>();
  const roomMeshes = new Map<string, Mesh>();
  const verticalMaterials = new Map<string, MeshStandardMaterial>();
  const concrete = new MeshStandardMaterial({ color: '#edeae1', roughness: 0.9 });
  const frame = new MeshStandardMaterial({ color: '#d2d2c9', roughness: 0.75 });
  const plinth = new MeshStandardMaterial({ color: '#555951', roughness: 0.9 });
  const glass = new MeshStandardMaterial({ color: '#a9bbb9', transparent: true, opacity: 0.08, depthWrite: false, roughness: 0.45 });
  const door = new MeshStandardMaterial({ color: '#8e9c96', roughness: 0.6 });
  const unitBox = new BoxGeometry(1, 1, 1);
  function box(
    name: string, x: number, y: number, z: number, w: number, h: number, d: number,
    material: MeshStandardMaterial, parent: Group = root,
  ) {
    const mesh = new Mesh(unitBox, material);
    mesh.name = name;
    mesh.position.set(x, y, z);
    mesh.scale.set(w, h, d);
    parent.add(mesh);
    return mesh;
  }
  // One Group per floor, holding that floor's hazard volumes, so a caller
  // (FloorExplodeSystem) can pull a floor's hazard layer apart from the rest
  // by offsetting the group — the structural shell stays fixed as a reference.
  const floorGroups = new Map<number, Group>();
  function getFloorGroup(floor: number): Group {
    let group = floorGroups.get(floor);
    if (!group) {
      group = new Group();
      group.name = `Floor ${floor} hazard layer`;
      root.add(group);
      floorGroups.set(floor, group);
    }
    return group;
  }
  const staticGroups = new Map<MeshStandardMaterial, StaticBox[]>();
  const staticLabel = new Map<MeshStandardMaterial, string>([
    [concrete, 'concrete'], [frame, 'frame'], [plinth, 'plinth'], [glass, 'glazing'], [door, 'entrance'],
  ]);
  /** Same box as `box()`, but batched by material into one draw call instead of placed live. */
  function addStatic(x: number, y: number, z: number, w: number, h: number, d: number, material: MeshStandardMaterial) {
    let list = staticGroups.get(material);
    if (!list) { list = []; staticGroups.set(material, list); }
    list.push({ x, y, z, w, h, d });
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
  addStatic(cx, 0.005, cz, width + 0.055, 0.01, depth + 0.055, plinth);
  for (let level = 0; level <= floors; level++) {
    addStatic(cx, 0.012 + level * FLOOR_HEIGHT, cz, width + 0.008, 0.004, depth + 0.008, concrete);
  }
  // Two retained elevations establish the envelope; the near/right sides stay
  // open as an architectural section, exposing incident rooms without glass.
  for (const z of [minZ]) {
    addStatic(cx, 0.012 + height / 2, z, width, height, 0.001, glass);
    for (let bay = 0; bay <= 8; bay++) {
      addStatic(minX + width * bay / 8, 0.012 + height / 2, z, 0.002, height, 0.003, frame);
    }
    // Spandrel bands at each floor line so the glazing reads as N storeys
    // instead of one slab; aligned with the floor plates behind them.
    for (let level = 0; level <= floors; level++) {
      addStatic(cx, 0.012 + level * FLOOR_HEIGHT, z, width, 0.0025, 0.0035, frame);
    }
  }
  for (const x of [minX]) {
    addStatic(x, 0.012 + height / 2, cz, 0.001, height, depth, glass);
    for (let bay = 0; bay <= 3; bay++) {
      addStatic(x, 0.012 + height / 2, minZ + depth * bay / 3, 0.003, height, 0.002, frame);
    }
    for (let level = 0; level <= floors; level++) {
      addStatic(x, 0.012 + level * FLOOR_HEIGHT, cz, 0.0035, 0.0025, depth, frame);
    }
  }
  for (let bay = 0; bay <= 4; bay++) {
    addStatic(minX + width * bay / 4, 0.012 + height / 2, maxZ - 0.004, 0.0035, height, 0.0035, concrete);
  }
  addStatic(cx, 0.031, minZ - 0.002, 0.045, 0.035, 0.003, door);
  addStatic(cx, 0.055, minZ - 0.014, 0.08, 0.004, 0.03, concrete);
  addStatic(cx - width * 0.23, height + 0.026, cz, 0.07, 0.025, 0.045, frame);
  for (const x of [minX, maxX]) addStatic(x, height + 0.02, cz, 0.004, 0.015, depth, concrete);
  for (const z of [minZ, maxZ]) addStatic(cx, height + 0.02, z, width, 0.015, 0.004, concrete);
  for (const room of building.rooms) {
    // Low sectional partitions describe the real room footprint while leaving
    // room-height hazard volumes visible over the top. They are diagrammatic.
    const baseY = 0.016 + (room.floor - 1) * FLOOR_HEIGHT;
    const partitionHeight = FLOOR_HEIGHT * 0.38;
    if (room.x * s > minX + 0.001) {
      addStatic(room.x * s, baseY + partitionHeight / 2,
        (room.z + room.d / 2) * s, 0.0015, partitionHeight, room.d * s, concrete);
    }
    addStatic((room.x + room.w / 2) * s, baseY + 0.001,
      room.z * s, room.w * s, 0.002, 0.0015, frame);
    const material = new MeshStandardMaterial({ color: '#ece8de', transparent: true, opacity: 0.06, depthWrite: false, roughness: 0.7 });
    const roomMesh = box(`Room ${room.id}`, (room.x + room.w / 2) * s,
      0.014 + (room.floor - 0.5) * FLOOR_HEIGHT, (room.z + room.d / 2) * s,
      room.w * s * 0.97, FLOOR_HEIGHT - 0.006, room.d * s * 0.97, material, getFloorGroup(room.floor));
    roomMesh.userData.roomId = room.id;
    roomMeshes.set(room.id, roomMesh);
    roomMaterials.set(room.id, material);
  }
  for (const vertical of building.verticals) {
    const served = building.rooms.filter(room => room.id === `${room.floor}-${vertical.id}`
      && room.floor >= vertical.floors[0] && room.floor <= vertical.floors[1]);
    if (!served.length) continue;
    const first = served.reduce((a, b) => a.floor < b.floor ? a : b);
    const last = served.reduce((a, b) => a.floor > b.floor ? a : b);
    const material = new MeshStandardMaterial({ color: vertical.kind === 'stair' ? '#434d57' : '#657180', roughness: 0.8 });
    const height = (last.floor - first.floor + 1) * FLOOR_HEIGHT;
    const mesh = box(`${vertical.kind === 'stair' ? 'Stair' : 'Elevator'} core ${vertical.id}`,
      (first.x + first.w / 2) * s, 0.014 + (first.floor - 1) * FLOOR_HEIGHT + height / 2,
      (first.z + first.d / 2) * s, first.w * s * 0.34, height, first.d * s * 0.34, material);
    (mesh as Mesh & { pointerEvents: string }).pointerEvents = 'none';
    verticalMaterials.set(vertical.id, material);
  }
  // Batch every static group into one draw call per material — the room
  // hazard volumes above stay unbatched since each needs its own live material.
  // The structural groups (concrete, frame) also feed a single crisp outline
  // pass below; glazing/plinth/entrance stay unlined since they read better soft.
  const outlineSources: Float32Array[] = [];
  for (const [material, entries] of staticGroups) {
    const geometry = mergeStaticBoxes(entries);
    const mesh = new Mesh(geometry, material);
    mesh.name = `Building structure (${staticLabel.get(material) ?? 'static'})`;
    // Static shell must not intercept room selection, especially above a cut.
    (mesh as Mesh & { pointerEvents: string }).pointerEvents = 'none';
    root.add(mesh);
    if (material === concrete || material === frame) {
      outlineSources.push(geometry.attributes.position.array as Float32Array);
    }
  }
  if (outlineSources.length > 0) {
    const totalFloats = outlineSources.reduce((sum, arr) => sum + arr.length, 0);
    const combinedPosition = new Float32Array(totalFloats);
    let offset = 0;
    for (const arr of outlineSources) { combinedPosition.set(arr, offset); offset += arr.length; }
    const combined = new BufferGeometry();
    combined.setAttribute('position', new Float32BufferAttribute(combinedPosition, 3));
    const outline = new LineSegments(
      new EdgesGeometry(combined, 1),
      new LineBasicMaterial({ color: '#4b4f49' }),
    );
    outline.name = 'Building structure outline';
    (outline as LineSegments & { pointerEvents: string }).pointerEvents = 'none';
    root.add(outline);
  }
  return { root, roomMaterials, roomMeshes, floorGroups, verticalMaterials };
}


/** One low-poly pin per person, drawn in one batch for the whole building. */
export function createOccupantPins(capacity: number): InstancedMesh {
  const mesh = new InstancedMesh(new ConeGeometry(0.0024, 0.01, 5),
    new MeshStandardMaterial({ color: '#ffffff', roughness: 0.85 }), capacity);
  mesh.name = 'People markers';
  mesh.frustumCulled = false;
  (mesh as InstancedMesh & { pointerEvents: string }).pointerEvents = 'none';
  return mesh;
}

/** Separate ray-only hit targets keep selection independent of near grabbing. */
export function createRoomPicking(roomMeshes: Map<string, Mesh>) {
  const root = new Group();
  root.name = 'Room picking targets';
  const material = new MeshStandardMaterial({ visible: false });
  const meshes = new Map<string, Mesh>();
  for (const [id, room] of roomMeshes) {
    const mesh = new Mesh(room.geometry, material);
    mesh.name = `Pick room ${id}`;
    mesh.userData.roomId = id;
    mesh.position.copy(room.position);
    mesh.scale.copy(room.scale);
    root.add(mesh);
    meshes.set(id, mesh);
    (room as Mesh & { pointerEventsType: { allow: string } }).pointerEventsType = { allow: 'grab' };
  }
  return { root, meshes, material };
}
