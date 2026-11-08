/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createComponent, Types } from '@iwsdk/core';

export const FloorState = createComponent('FloorState', {
  floorIndex: { type: Types.Int8, default: 0 },
  fireLevel: { type: Types.Float32, default: 0 },
  smokeLevel: { type: Types.Float32, default: 0 },
});
