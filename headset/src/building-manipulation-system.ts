import { createSystem, Grabbed, Object3D, Quaternion, Vector3 } from '@iwsdk/core';
import { BuildingModel } from './components.js';

function belongsTo(object: Object3D | undefined, building: Object3D): boolean {
  for (let node = object; node; node = node.parent ?? undefined) {
    if (node === building) return true;
  }
  return false;
}

/** Keep a two-hand stretch uniform and anchored, including at the size limits. */
export class BuildingManipulationSystem extends createSystem({
  buildings: { required: [BuildingModel, Grabbed] },
}) {
  private activeBuilding: Object3D | null = null;
  private left = new Vector3();
  private right = new Vector3();
  private midpoint = new Vector3();
  private axis = new Vector3();
  private startAxis = new Vector3();
  private startOffset = new Vector3();
  private startRotation = new Quaternion();
  private rotation = new Quaternion();
  private startDistance = 0;
  private startScale = 1;

  update(): void {
    const leftPointer = this.input.xr.multiPointers.left.getPointer('grab');
    const rightPointer = this.input.xr.multiPointers.right.getPointer('grab');
    const leftCapture = leftPointer.getPointerCapture();
    const rightCapture = rightPointer.getPointerCapture();
    const leftInput = leftPointer.getIntersection();
    const rightInput = rightPointer.getIntersection();
    if (!leftCapture || !rightCapture || !leftInput || !rightInput) {
      this.activeBuilding = null;
      return;
    }

    for (const entity of this.queries.buildings.entities) {
      const object = entity.object3D;
      if (!object || !belongsTo(leftCapture.object, object) || !belongsTo(rightCapture.object, object)) continue;

      // Use tracked pointer origins, not contact points on the growing model.
      // Work in the model parent's space so room recentering is respected.
      this.left.copy(leftInput.pointerPosition);
      this.right.copy(rightInput.pointerPosition);
      object.parent?.worldToLocal(this.left);
      object.parent?.worldToLocal(this.right);
      this.midpoint.copy(this.left).add(this.right).multiplyScalar(0.5);
      this.axis.copy(this.right).sub(this.left);
      const distance = this.axis.length();

      if (this.activeBuilding !== object) {
        // Wait for a usable separation instead of dividing by nearly zero.
        if (distance < 0.03) return;
        this.activeBuilding = object;
        this.startDistance = distance;
        this.startAxis.copy(this.axis).normalize();
        this.startOffset.copy(object.position).sub(this.midpoint);
        this.startRotation.copy(object.quaternion);
        this.startScale = object.scale.x;
      }

      const scale = Math.min(3, Math.max(0.5, this.startScale * distance / this.startDistance));
      const ratio = scale / this.startScale;
      if (distance > 0.001) {
        this.rotation.setFromUnitVectors(this.startAxis, this.axis.divideScalar(distance));
      }
      // Apply the same clamped ratio to both size and its offset from the hands.
      // Recompute from the gesture start, never from last frame's output.
      object.position.copy(this.startOffset).multiplyScalar(ratio).applyQuaternion(this.rotation).add(this.midpoint);
      object.quaternion.copy(this.startRotation).premultiply(this.rotation);
      object.scale.setScalar(scale);
      object.updateMatrixWorld(true);
      return;
    }
    this.activeBuilding = null;
  }
}
