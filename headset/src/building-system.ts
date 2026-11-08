/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  Color,
  createSceneMaterial,
  createScenePrimitiveObject,
  createSystem,
  Group,
  Mesh,
  MeshStandardMaterial,
} from '@iwsdk/core';
import { fetchBuilding, IncidentSocket } from './incident-client.js';
import type { Building, IncidentState } from './incident-types.js';

// Real building footprint is ~38m wide x ~14m deep over 12 floors; this scale
// brings that down to a tabletop model a bit over half a meter wide.
const MODEL_SCALE = 0.0145;
const ASSUMED_FLOOR_HEIGHT_M = 3.5; // not in building.json; a display-only assumption
const ROOM_FOOTPRINT_INSET = 0.9; // shrink each room slightly so neighbors show a gap
const FLOOR_GAP_INSET = 0.85; // shrink room height so floors show a gap

/**
 * Builds one box per room from the real shared/building.json (fetched live
 * from the FireSight server, not hand-authored in scene JSON, since this
 * must track whatever data/ actually generates) and tints each from the
 * live IncidentState.rooms stream.
 */
export class BuildingSystem extends createSystem({}) {
  private roomMaterials = new Map<string, MeshStandardMaterial>();
  private baseColor = new Color('#bfe8f2');
  private smokeColor = new Color('#555555');
  private fireColor = new Color('#ff5a1f');
  private mixColor = new Color();
  private socket: IncidentSocket | null = null;

  async init(): Promise<void> {
    const anchor = this.world.createTransformEntity(new Group());
    anchor.object3D!.position.set(-0.75, 0.78, -0.75);

    let building: Building;
    try {
      building = (await fetchBuilding()).building;
    } catch (error) {
      console.error('[BuildingSystem] failed to load /fs-api/building', error);
      return;
    }
    this.buildRoomModel(building, anchor);

    this.socket = new IncidentSocket((state) => this.onState(state));
    this.socket.connect();
  }

  stop(): void {
    this.socket?.close();
  }

  private buildRoomModel(
    building: Building,
    anchor: ReturnType<typeof this.world.createTransformEntity>,
  ): void {
    for (const room of building.rooms) {
      const material = createSceneMaterial({
        id: `room-material-${room.id}`,
        model: 'standard',
        baseColor: '#bfe8f2',
        opacity: 0.45,
        roughness: 0.15,
        metalness: 0,
        emissive: '#000000',
        emissiveIntensity: 0,
        side: 'double',
      }) as unknown as MeshStandardMaterial;

      const mesh = createScenePrimitiveObject(
        { geometry: { type: 'box', size: [1, 1, 1] } },
        material,
      ) as unknown as Mesh;

      const w = room.w * MODEL_SCALE * ROOM_FOOTPRINT_INSET;
      const d = room.d * MODEL_SCALE * ROOM_FOOTPRINT_INSET;
      const h = ASSUMED_FLOOR_HEIGHT_M * MODEL_SCALE * FLOOR_GAP_INSET;
      mesh.scale.set(w, h, d);
      mesh.position.set(
        (room.x + room.w / 2) * MODEL_SCALE,
        (room.floor - 1) * ASSUMED_FLOOR_HEIGHT_M * MODEL_SCALE,
        (room.z + room.d / 2) * MODEL_SCALE,
      );

      this.world.createTransformEntity(mesh, anchor);
      this.roomMaterials.set(room.id, material);
    }
  }

  private onState(state: IncidentState): void {
    for (const roomState of state.rooms) {
      const material = this.roomMaterials.get(roomState.roomId);
      if (material == null) {
        continue;
      }
      this.mixColor.copy(this.baseColor);
      this.mixColor.lerp(this.smokeColor, roomState.smoke);
      this.mixColor.lerp(this.fireColor, roomState.fire);
      material.emissive.copy(this.mixColor);
      material.emissiveIntensity = Math.max(
        roomState.fire,
        roomState.smoke * 0.6,
      );
    }
  }
}
