/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { BuildingSystem } from './building-system.js';
import { BuildingManipulationSystem } from './building-manipulation-system.js';
import { ConsoleSystem } from './console-system.js';
import { PanelSystem } from './panel.js';

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then((world) => {
  // Dev-only handle for scripted on-device checks over adb/CDP; stripped from production builds.
  if (import.meta.env.DEV) (window as unknown as { __world?: unknown }).__world = world;
  world.registerSystem(PanelSystem);
  world.registerSystem(BuildingSystem);
  world.registerSystem(BuildingManipulationSystem, { priority: -2.9 });
  world.registerSystem(ConsoleSystem);
});
