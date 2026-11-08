import building from '../../shared/building.json';
import type { Building } from './incident-types.js';
import { createIncidentBuilding } from './scene-assets/incident-building.scene-asset.js';
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { AssetType, defineAssets } from '@iwsdk/core';
import { createCommandDesk, createCommandRoom } from './scene-assets/command-room.scene-asset.js';

const publicAssetUrl = (filePath: string): string =>
  `${import.meta.env.BASE_URL}${filePath.replace(/^\/+/u, '')}`;

const uikitml = (fileName: string, name: string) => ({
  url: publicAssetUrl(`ui/${fileName}`),
  type: AssetType.UIKitML,
  name,
});

export default defineAssets({
  'incident-building-preview': createIncidentBuilding(building as Building).root,
  'command-desk': createCommandDesk(),
  'command-room': createCommandRoom(),
  'welcome-panel': uikitml('welcome.uikitml', 'Welcome Panel'),
  'voice-panel': uikitml('voice-panel.uikitml', 'Voice Panel'),
  'resources-panel': uikitml('resources-panel.uikitml', 'Resources Panel'),
});
