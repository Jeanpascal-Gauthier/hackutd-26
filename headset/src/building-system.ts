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
  private baseColor = new Color('#ece8de');
  private smokeColor = new Color('#555555');
  private fireColor = new Color('#ff5a1f');
  private routeColor = new Color('#3ddc5a');
  private mixColor = new Color();
  private socket: IncidentSocket | null = null;

  private stopped = false;
  private loadTimer: ReturnType<typeof setTimeout> | null = null;
  private loadAbort: AbortController | null = null;

  init(): void {
    this.cleanupFuncs.push(() => this.stop());
    void this.loadBuilding();
  }

  private async loadBuilding(): Promise<void> {
    if (this.stopped) return;
    const abort = new AbortController();
    this.loadAbort = abort;
    const timeout = setTimeout(() => abort.abort(), 8000);
    let building: Building;
    try {
      building = (await fetchBuilding(abort.signal)).building;
    } catch (error) {
      if (!this.stopped) {
        console.warn('[BuildingSystem] waiting for building server', error);
        this.loadTimer = setTimeout(() => { void this.loadBuilding(); }, 2000);
      }
      return;
    } finally {
      clearTimeout(timeout);
    }
    if (this.stopped) return;
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
    this.stopped = true;
    if (this.loadTimer != null) clearTimeout(this.loadTimer);
    this.loadAbort?.abort();
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
      material.opacity = 0.06 + Math.max(roomState.fire, roomState.smoke) * 0.7;
      const clear = roomState.fire < 0.15 && roomState.smoke < 0.15;
      if (routeRooms?.has(roomState.roomId) && clear) {
        material.color.copy(this.routeColor);
        material.emissive.copy(this.routeColor);
        material.emissiveIntensity = 0.9;
        continue;
      }
      this.mixColor.copy(this.baseColor);
      this.mixColor.lerp(this.smokeColor, roomState.smoke);
      this.mixColor.lerp(this.fireColor, roomState.fire);
      material.color.copy(this.mixColor);
      material.emissive.copy(this.mixColor);
      material.emissiveIntensity = Math.max(
        roomState.fire,
        roomState.smoke * 0.6,
      );
    }
  }
}
