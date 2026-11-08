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
 * the seated operator. The building model itself is generated at runtime by
 * BuildingSystem from the live server's room data, not authored here.
 */

const consoleDeskMaterial = createSceneMaterial({
  id: 'command-desk-metal',
  model: 'standard',
  baseColor: '#3A4047',
  roughness: 0.55,
  metalness: 0.35,
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
