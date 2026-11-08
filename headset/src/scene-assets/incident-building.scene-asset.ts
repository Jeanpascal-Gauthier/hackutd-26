import {
  BoxGeometry, BufferGeometry, Color, ConeGeometry, DoubleSide, EdgesGeometry, Float32BufferAttribute, Group, InstancedMesh, LineBasicMaterial,
  LineSegments, Mesh, MeshStandardMaterial,
} from '@iwsdk/core';
import type { Building } from '../incident-types.js';

/** Model units per metre before fitting; the demo building is drawn at exactly this scale. */
export const BUILDING_SCALE = 0.0145;
export const FLOOR_HEIGHT = 3.5 * BUILDING_SCALE;
/** Largest footprint side and height (desk metres) a looked-up building may take on the desk. */
const FIT_MAX_SIDE = 0.56;
const FIT_MAX_HEIGHT = 0.62;
/** Small buildings may be enlarged up to this much so 2-floor sites stay readable. */
const FIT_MAX_ENLARGE = 2;

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

interface StaticBox { x: number; y: number; z: number; w: number; h: number; d: number; color?: Color; }

/** Merge boxes into one geometry; per-box colours become vertex colours when present. */
function mergeStaticBoxes(entries: StaticBox[]): BufferGeometry {
  const position = new Float32Array(entries.length * VERTS_PER_BOX * 3);
  const normal = new Float32Array(entries.length * VERTS_PER_BOX * 3);
  const uv = new Float32Array(entries.length * VERTS_PER_BOX * 2);
  const colored = entries.some(entry => entry.color);
  const color = colored ? new Float32Array(entries.length * VERTS_PER_BOX * 3) : null;
  entries.forEach((entry, i) => {
    const p3 = i * VERTS_PER_BOX * 3;
    for (let v = 0; v < VERTS_PER_BOX; v++) {
      position[p3 + v * 3] = templatePosition[v * 3] * entry.w + entry.x;
      position[p3 + v * 3 + 1] = templatePosition[v * 3 + 1] * entry.h + entry.y;
      position[p3 + v * 3 + 2] = templatePosition[v * 3 + 2] * entry.d + entry.z;
      if (color && entry.color) entry.color.toArray(color, p3 + v * 3);
    }
    normal.set(templateNormal, p3);
    uv.set(templateUv, i * VERTS_PER_BOX * 2);
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(position, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normal, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  if (color) geometry.setAttribute('color', new Float32BufferAttribute(color, 3));
  return geometry;
}

/** Crisp dark edges for a merged structural geometry. */
function structureOutline(sources: Float32Array[], material: LineBasicMaterial, name: string): LineSegments {
  const combinedPosition = new Float32Array(sources.reduce((sum, arr) => sum + arr.length, 0));
  let offset = 0;
  for (const arr of sources) { combinedPosition.set(arr, offset); offset += arr.length; }
  const combined = new BufferGeometry();
  combined.setAttribute('position', new Float32BufferAttribute(combinedPosition, 3));
  const outline = new LineSegments(new EdgesGeometry(combined, 1), material);
  combined.dispose();
  outline.name = name;
  (outline as LineSegments & { pointerEvents: string }).pointerEvents = 'none';
  return outline;
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
  // One Group per floor, holding that floor's slab, partitions and hazard
  // volumes, so BuildingSystem can pull floors apart by offsetting the group
  // and people pins stay standing on their own floor. The facade, columns and
  // plinth stay fixed as a reference.
  const floorGroups = new Map<number, Group>();
  function getFloorGroup(floor: number): Group {
    let group = floorGroups.get(floor);
    if (!group) {
      group = new Group();
      group.name = `Floor ${floor}`;
      root.add(group);
      floorGroups.set(floor, group);
    }
    return group;
  }
  const staticGroups = new Map<MeshStandardMaterial, StaticBox[]>();
  const staticLabel = new Map<MeshStandardMaterial, string>([
    [concrete, 'concrete'], [frame, 'frame'], [plinth, 'plinth'], [glass, 'glazing'], [door, 'entrance'],
  ]);
  // Per-floor structure merges concrete and frame into one vertex-coloured
  // draw call per floor (plus one outline), keeping the draw-call cost of
  // moving floors to two per storey.
  const floorShell = new MeshStandardMaterial({ color: '#ffffff', vertexColors: true, roughness: 0.85 });
  const floorStatic = new Map<number, StaticBox[]>();
  /**
   * Same box as `box()`, but batched into one draw call instead of placed live.
   * With `floor`, the box moves with that floor when the model is pulled apart.
   */
  function addStatic(x: number, y: number, z: number, w: number, h: number, d: number, material: MeshStandardMaterial, floor = 0) {
    if (floor > 0) {
      let list = floorStatic.get(floor);
      if (!list) { list = []; floorStatic.set(floor, list); }
      list.push({ x, y, z, w, h, d, color: material.color });
      return;
    }
    let list = staticGroups.get(material);
    if (!list) { list = []; staticGroups.set(material, list); }
    list.push({ x, y, z, w, h, d });
  }
  const s = BUILDING_SCALE;
  const floors = Math.max(...building.rooms.map(r => r.floor));
  const profile = building.profile;
  // A looked-up building carries its real footprint; the demo file has none.
  const outline = profile?.outline && profile.outline.length >= 3 ? profile.outline : null;
  // Stairwells and the elevator are rooms named `${floor}-${vertical.id}`; they
  // stick out of the main block, so the facade wraps only the main block.
  const verticalRoomIds = new Set(building.rooms
    .filter(room => building.verticals.some(v => room.id === `${room.floor}-${v.id}`))
    .map(room => room.id));
  const mainRooms = building.rooms.filter(room => !verticalRoomIds.has(room.id));
  const blockRooms = mainRooms.length ? mainRooms : building.rooms;
  const minX = Math.min(...blockRooms.map(r => r.x)) * s;
  const maxX = Math.max(...blockRooms.map(r => r.x + r.w)) * s;
  const minZ = Math.min(...blockRooms.map(r => r.z)) * s;
  const maxZ = Math.max(...blockRooms.map(r => r.z + r.d)) * s;
  const width = maxX - minX, depth = maxZ - minZ;
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const height = floors * FLOOR_HEIGHT;
  // The plinth is the site base, so it spans every room including the towers.
  const siteMinX = Math.min(...building.rooms.map(r => r.x), ...(outline ?? []).map(p => p[0])) * s;
  const siteMaxX = Math.max(...building.rooms.map(r => r.x + r.w), ...(outline ?? []).map(p => p[0])) * s;
  const siteMinZ = Math.min(...building.rooms.map(r => r.z), ...(outline ?? []).map(p => p[1])) * s;
  const siteMaxZ = Math.max(...building.rooms.map(r => r.z + r.d), ...(outline ?? []).map(p => p[1])) * s;
  addStatic((siteMinX + siteMaxX) / 2, 0.005, (siteMinZ + siteMaxZ) / 2,
    siteMaxX - siteMinX + 0.055, 0.01, siteMaxZ - siteMinZ + 0.055, plinth);
  // Slabs follow the real room footprints (no empty, unselectable floor plate).
  // Each slab rides with the floor standing on it; the roof rides with the top floor.
  for (const room of building.rooms) {
    const slab = (level: number) => addStatic((room.x + room.w / 2) * s, 0.012 + level * FLOOR_HEIGHT,
      (room.z + room.d / 2) * s, room.w * s, 0.004, room.d * s, concrete, room.floor);
    slab(room.floor - 1);
    if (room.floor === floors) slab(floors);
  }
  // The demo building is a rectangle: draw its glazed elevations, columns and
  // roof parapet. A looked-up building gets its real footprint outline instead
  // (below), since its shape can be anything.
  if (!outline) {
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
    // Entrance sits on the front face beside the elevator tower, not under it.
    const entranceX = minX + width * 0.3;
    addStatic(entranceX, 0.031, minZ - 0.002, 0.045, 0.035, 0.003, door);
    addStatic(entranceX, 0.055, minZ - 0.014, 0.08, 0.004, 0.03, concrete);
    addStatic(cx - width * 0.23, height + 0.026, cz, 0.07, 0.025, 0.045, frame, floors);
    for (const x of [minX, maxX]) addStatic(x, height + 0.02, cz, 0.004, 0.015, depth, concrete, floors);
    for (const z of [minZ, maxZ]) addStatic(cx, height + 0.02, z, width, 0.015, 0.004, concrete, floors);
  }
  for (const room of building.rooms) {
    // Low sectional partitions describe the real room footprint while leaving
    // room-height hazard volumes visible over the top. They are diagrammatic.
    const baseY = 0.016 + (room.floor - 1) * FLOOR_HEIGHT;
    const partitionHeight = FLOOR_HEIGHT * 0.38;
    if (room.x * s > minX + 0.001) {
      addStatic(room.x * s, baseY + partitionHeight / 2,
        (room.z + room.d / 2) * s, 0.0015, partitionHeight, room.d * s, concrete, room.floor);
    }
    addStatic((room.x + room.w / 2) * s, baseY + 0.001,
      room.z * s, room.w * s, 0.002, 0.0015, frame, room.floor);
    const material = new MeshStandardMaterial({ color: '#ece8de', transparent: true, opacity: 0.06, depthWrite: false, roughness: 0.7 });
    const roomMesh = box(`Room ${room.id}`, (room.x + room.w / 2) * s,
      0.014 + (room.floor - 0.5) * FLOOR_HEIGHT, (room.z + room.d / 2) * s,
      room.w * s * 0.97, FLOOR_HEIGHT - 0.006, room.d * s * 0.97, material, getFloorGroup(room.floor));
    roomMesh.userData.roomId = room.id;
    roomMeshes.set(room.id, roomMesh);
    roomMaterials.set(room.id, material);
  }
  const stairTread = new MeshStandardMaterial({ color: '#a9b0b6' });
  for (const vertical of building.verticals) {
    const served = building.rooms.filter(room => room.id === `${room.floor}-${vertical.id}`
      && room.floor >= vertical.floors[0] && room.floor <= vertical.floors[1]);
    if (!served.length) continue;
    const first = served.reduce((a, b) => a.floor < b.floor ? a : b);
    const last = served.reduce((a, b) => a.floor > b.floor ? a : b);
    const material = new MeshStandardMaterial({ color: vertical.kind === 'stair' ? '#434d57' : '#657180', roughness: 0.8 });
    const height = (last.floor - first.floor + 1) * FLOOR_HEIGHT;
    const isStair = vertical.kind === 'stair';
    let mesh: Mesh;
    if (isStair) {
      // Switchback stair on every floor: flight up along one half, landing,
      // flight back along the other half. Treads join the per-floor structure
      // (no extra draw calls); the spine wall between the flights keeps the
      // live route colour (green when on an accepted, clear route).
      const steps = 6;
      const rise = FLOOR_HEIGHT / (steps * 2);
      for (const room of served) {
        const x0 = room.x * s, z0 = room.z * s, w = room.w * s, d = room.d * s;
        const base = 0.014 + (room.floor - 1) * FLOOR_HEIGHT;
        const run = w * 0.72, start = x0 + w * 0.04, tread = run / steps, flightD = d * 0.44;
        for (let i = 0; i < steps; i++) {
          const top1 = base + (i + 1) * rise;
          const h1 = i === 0 ? rise : rise * 2;
          addStatic(start + (i + 0.5) * tread, top1 - h1 / 2, z0 + d * 0.25, tread, h1, flightD, stairTread, room.floor);
          const top2 = base + FLOOR_HEIGHT / 2 + (i + 1) * rise;
          addStatic(start + run - (i + 0.5) * tread, top2 - rise, z0 + d * 0.75, tread, rise * 2, flightD, stairTread, room.floor);
        }
        const landingW = x0 + w * 0.97 - (start + run);
        addStatic(start + run + landingW / 2, base + FLOOR_HEIGHT / 2 - rise, z0 + d / 2, landingW, rise * 2, d * 0.94, stairTread, room.floor);
      }
      mesh = box(`Stair spine ${vertical.id}`,
        (first.x * s + first.w * s * 0.04) + first.w * s * 0.36, 0.014 + (first.floor - 1) * FLOOR_HEIGHT + height / 2,
        (first.z + first.d / 2) * s, first.w * s * 0.72, height, first.d * s * 0.06, material);
    } else {
      mesh = box(`Elevator core ${vertical.id}`,
        (first.x + first.w / 2) * s, 0.014 + (first.floor - 1) * FLOOR_HEIGHT + height / 2,
        (first.z + first.d / 2) * s, first.w * s * 0.34, height, first.d * s * 0.34, material);
    }
    // Grab-only: hands can take hold of it, pointing rays pass through to rooms.
    (mesh as Mesh & { pointerEventsType: { allow: string } }).pointerEventsType = { allow: 'grab' };
    verticalMaterials.set(vertical.id, material);
  }
  if (outline) {
    // Real footprint: ground ring, roof ring and corner posts, one draw call.
    const top = 0.014 + height;
    const points: number[] = [];
    const segment = (a: [number, number], b: [number, number], ya: number, yb: number) =>
      points.push(a[0] * s, ya, a[1] * s, b[0] * s, yb, b[1] * s);
    outline.forEach((point, i) => {
      const next = outline[(i + 1) % outline.length];
      segment(point, next, 0.011, 0.011);
      segment(point, next, top, top);
      segment(point, point, 0.011, top);
    });
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(points, 3));
    const footprint = new LineSegments(geometry, new LineBasicMaterial({ color: '#2b3a44' }));
    footprint.name = 'Building outline';
    (footprint as LineSegments & { pointerEvents: string }).pointerEvents = 'none';
    root.add(footprint);
    // Faint glazing along every outline edge shows the real massing (for example
    // the empty leg of an L, where generated rooms do not reach). Two triangles per edge.
    const walls: number[] = [];
    outline.forEach((a, i) => {
      const b = outline[(i + 1) % outline.length];
      const [ax, az, bx, bz] = [a[0] * s, a[1] * s, b[0] * s, b[1] * s];
      walls.push(ax, 0.011, az, bx, 0.011, bz, bx, top, bz, ax, 0.011, az, bx, top, bz, ax, top, az);
    });
    const wallGeometry = new BufferGeometry();
    wallGeometry.setAttribute('position', new Float32BufferAttribute(walls, 3));
    wallGeometry.computeVertexNormals();
    const shell = new Mesh(wallGeometry, new MeshStandardMaterial({
      color: '#a9bbb9', transparent: true, opacity: 0.1, depthWrite: false, roughness: 0.45, side: DoubleSide,
    }));
    shell.name = 'Building outline glazing';
    (shell as Mesh & { pointerEventsType: { allow: string } }).pointerEventsType = { allow: 'grab' };
    root.add(shell);
  }
  // Batch every static group into one draw call per material — the room
  // hazard volumes above stay unbatched since each needs its own live material.
  // The structural groups (concrete, frame) also feed a single crisp outline
  // pass below; glazing/plinth/entrance stay unlined since they read better soft.
  const outlineMaterial = new LineBasicMaterial({ color: '#4b4f49' });
  const outlineSources: Float32Array[] = [];
  for (const [floor, entries] of floorStatic) {
    const geometry = mergeStaticBoxes(entries);
    const mesh = new Mesh(geometry, floorShell);
    mesh.name = `Floor ${floor} structure`;
    // Grab-only: a hand reaching for a slab or wall can take hold of the model,
    // while pointing rays pass through to the room picking targets.
    (mesh as Mesh & { pointerEventsType: { allow: string } }).pointerEventsType = { allow: 'grab' };
    const group = getFloorGroup(floor);
    group.add(mesh);
    group.add(structureOutline([geometry.attributes.position.array as Float32Array], outlineMaterial, `Floor ${floor} structure outline`));
  }
  for (const [material, entries] of staticGroups) {
    const geometry = mergeStaticBoxes(entries);
    const mesh = new Mesh(geometry, material);
    mesh.name = `Building structure (${staticLabel.get(material) ?? 'static'})`;
    // Static shell must not intercept room selection, especially above a cut,
    // but hands should still be able to grab the model by it.
    (mesh as Mesh & { pointerEventsType: { allow: string } }).pointerEventsType = { allow: 'grab' };
    root.add(mesh);
    if (material === concrete || material === frame) {
      outlineSources.push(geometry.attributes.position.array as Float32Array);
    }
  }
  if (outlineSources.length > 0) {
    root.add(structureOutline(outlineSources, outlineMaterial, 'Building structure outline'));
  }
  // Fit looked-up buildings (2 to 40 floors, any footprint) onto the desk. The
  // demo keeps scale 1 so its look and tested panel clearances never change.
  let fit = 1;
  if (profile && profile.source !== 'demo') {
    const side = Math.max(siteMaxX - siteMinX, siteMaxZ - siteMinZ);
    fit = Math.min(FIT_MAX_ENLARGE, FIT_MAX_SIDE / side, FIT_MAX_HEIGHT / (height + 0.04));
  }
  root.scale.setScalar(fit);
  return { root, roomMaterials, roomMeshes, floorGroups, verticalMaterials, fit };
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
