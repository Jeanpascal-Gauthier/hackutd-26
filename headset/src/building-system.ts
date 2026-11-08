/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  Box3,
  Color,
  Group,
  TwoHandsGrabbable,
  Vector3,
  createSystem,
  MeshStandardMaterial,
} from '@iwsdk/core';
import { BuildingModel } from './components.js';
import { fetchBuilding, IncidentSocket } from './incident-client.js';
import { createIncidentBuilding } from './scene-assets/incident-building.scene-asset.js';
import type { Building, IncidentState } from './incident-types.js';

export class BuildingSystem extends createSystem({}) {
  private roomMaterials = new Map<string, MeshStandardMaterial>();
  private baseColor = new Color('#bfe8f2');
  private smokeColor = new Color('#555555');
  private fireColor = new Color('#ff5a1f');
  private routeColor = new Color('#3ddc5a');
  private mixColor = new Color();
  private socket: IncidentSocket | null = null;

  async init(): Promise<void> {
    let building: Building;
    try {
      building = (await fetchBuilding()).building;
    } catch (error) {
      console.error('[BuildingSystem] failed to load /fs-api/building', error);
      return;
    }
    const model = createIncidentBuilding(building);
    // Rotate/scale about the building centre rather than its floor-plan corner.
    const center = new Box3().setFromObject(model.root).getCenter(new Vector3());
    model.root.position.copy(center).multiplyScalar(-1);
    const handle = new Group();
    handle.name = 'Incident Building';
    handle.add(model.root);
    handle.position.set(-0.5, 1.05, -0.55);
    const entity = this.world.createTransformEntity(handle);
    entity.addComponent(BuildingModel);
    entity.addComponent(TwoHandsGrabbable, {
      translate: true,
      rotate: true,
      scale: true,
      scaleMin: [0.5, 0.5, 0.5],
      scaleMax: [3, 3, 3],
    });
    this.roomMaterials = model.roomMaterials;

    this.socket = new IncidentSocket((state) => this.onState(state));
    this.socket.connect();
  }

  stop(): void {
    this.socket?.close();
  }

  private onState(state: IncidentState): void {
    // "accepted" is when the route should light green (server/API.md); the
    // route is only meaningful as a safe path, so a room on fire or smoky
    // still shows danger color instead of a misleading green.
    const routeRooms =
      state.accepted != null
        ? new Set((state.exits ?? []).flatMap((exit) => exit.route ?? []))
        : null;

    for (const roomState of state.rooms) {
      const material = this.roomMaterials.get(roomState.roomId);
      if (material == null) {
        continue;
      }
      material.opacity = 0.16 + Math.max(roomState.fire, roomState.smoke) * 0.6;
      const clear = roomState.fire < 0.15 && roomState.smoke < 0.15;
      if (routeRooms?.has(roomState.roomId) && clear) {
        material.emissive.copy(this.routeColor);
        material.emissiveIntensity = 0.9;
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
