/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  Color,
  createSystem,
  Entity,
  Mesh,
  MeshStandardMaterial,
} from '@iwsdk/core';
import { FloorState } from './floor-component.js';

/**
 * Tints each building-floor slab from fire/smoke levels on its FloorState,
 * and lets both decay slowly over time. Another system (ConsoleSystem) writes
 * fireLevel/smokeLevel when a report lands on a floor; this system only
 * reads that state and turns it into color, same as the real spread model
 * would feed a live incident instead of the demo script.
 */
export class BuildingSystem extends createSystem({
  floors: { required: [FloorState] },
}) {
  private materials = new Map<Entity, MeshStandardMaterial>();
  private baseColor = new Color('#bfe8f2');
  private smokeColor = new Color('#555555');
  private fireColor = new Color('#ff5a1f');
  private mixColor = new Color();

  init(): void {
    this.queries.floors.subscribe('qualify', (entity) => {
      const object3D = entity.object3D;
      if (!(object3D instanceof Mesh)) {
        return;
      }
      const source = Array.isArray(object3D.material)
        ? object3D.material[0]
        : object3D.material;
      const clone = (source as MeshStandardMaterial).clone();
      object3D.material = clone;
      this.materials.set(entity, clone);
    });
  }

  update(delta: number): void {
    for (const entity of this.queries.floors.entities) {
      const material = this.materials.get(entity);
      if (material == null) {
        continue;
      }
      const fire = entity.getValue(FloorState, 'fireLevel') ?? 0;
      const smoke = entity.getValue(FloorState, 'smokeLevel') ?? 0;

      this.mixColor.copy(this.baseColor);
      this.mixColor.lerp(this.smokeColor, smoke);
      this.mixColor.lerp(this.fireColor, fire);
      material.emissive.copy(this.mixColor);
      material.emissiveIntensity = Math.max(fire, smoke * 0.6);

      const nextFire = Math.max(0, fire - delta * 0.015);
      const nextSmoke = Math.max(0, smoke - delta * 0.01);
      if (nextFire !== fire) {
        entity.setValue(FloorState, 'fireLevel', nextFire);
      }
      if (nextSmoke !== smoke) {
        entity.setValue(FloorState, 'smokeLevel', nextSmoke);
      }
    }
  }
}
