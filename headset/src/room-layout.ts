import type { Object3D } from '@iwsdk/core';

// Room geometry lives in scene-assets/command-room.scene-asset.ts: a hexagon
// (radius 2.2 m) whose desk wraps the three forward facets at -60°, 0°, +60°.
// The worktop runs from ~1.08 m (inner edge) to ~1.90 m (wall) from the centre.
const DESK_TOP_Y = 0.745;
const LEFT_DESK_ANGLE = -Math.PI / 3;
/** Just past the desk's inner edge, so the model sits within the operator's reach. */
const BUILDING_DESK_DISTANCE = 1.28;
/** Model height at scale 1 (incident-building.scene-asset.ts); handle origin is its centre. */
const BUILDING_HEIGHT = 0.647;
export const BUILDING_HOME_SCALE = 1;

/**
 * Rest the building on the left desk section, centred on it and facing the room centre.
 * A fitted (looked-up) building records its own height in `userData.modelHeight`.
 */
export function placeBuildingOnDesk(object: Object3D, scale = BUILDING_HOME_SCALE): void {
  const height = typeof object.userData.modelHeight === 'number' ? object.userData.modelHeight : BUILDING_HEIGHT;
  object.position.set(
    Math.sin(LEFT_DESK_ANGLE) * BUILDING_DESK_DISTANCE,
    DESK_TOP_Y + (height / 2) * scale,
    -Math.cos(LEFT_DESK_ANGLE) * BUILDING_DESK_DISTANCE,
  );
  object.rotation.set(0, -LEFT_DESK_ANGLE, 0);
  object.scale.setScalar(scale);
  object.updateMatrixWorld(true);
}
