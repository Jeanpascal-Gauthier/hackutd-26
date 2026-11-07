/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  createSceneMaterial,
  createScenePrimitiveObject,
  Group,
  Object3D,
} from '@iwsdk/core';

/**
 * Procedural pieces for the command-console room: a bare console desk for
 * the seated operator and one glass floor slab, cloned and stacked by the
 * scene to form a miniature building tower.
 */

const consoleDeskMaterial = createSceneMaterial({
  id: 'command-desk-metal',
  model: 'standard',
  baseColor: '#3A4047',
  roughness: 0.55,
  metalness: 0.35,
});

// Pale, slightly translucent glass. Emissive starts dark so a later system
// can recolor per floor (fire/smoke state) by writing emissive/emissiveIntensity
// on a per-clone material instance.
const buildingFloorGlassMaterial = createSceneMaterial({
  id: 'building-floor-glass',
  model: 'standard',
  baseColor: '#BFE8F2',
  opacity: 0.45,
  roughness: 0.15,
  metalness: 0,
  emissive: '#000000',
  emissiveIntensity: 0,
  side: 'double',
});

/** Bare console desk: a slab top on a single pedestal base. Origin at floor contact. */
export function createCommandDesk(): Object3D {
  const deskHeight = 0.75;
  const topThickness = 0.04;
  const pedestalHeight = deskHeight - topThickness;

  const top = createScenePrimitiveObject(
    { geometry: { type: 'box', size: [1.2, topThickness, 0.6] } },
    consoleDeskMaterial,
  );
  top.position.y = deskHeight - topThickness / 2;

  const pedestal = createScenePrimitiveObject(
    { geometry: { type: 'box', size: [0.5, pedestalHeight, 0.3] } },
    consoleDeskMaterial,
  );
  pedestal.position.y = pedestalHeight / 2;

  const desk = new Group();
  desk.add(top, pedestal);
  return desk;
}

/**
 * One floor of a tabletop building model, as a flat glass slab. Origin at
 * its own center so stacking a tower is a simple per-clone y-offset.
 */
export function createBuildingFloorSlab(): Object3D {
  return createScenePrimitiveObject(
    { geometry: { type: 'box', size: [0.4, 0.03, 0.4] } },
    buildingFloorGlassMaterial,
  );
}
