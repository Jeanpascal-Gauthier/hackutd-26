import { createSystem, GrabSystem, UIKitMLAsset, Vector3, VisibilityState } from '@iwsdk/core';
import { BuildingModel } from './components.js';

export class PanelSystem extends createSystem({ buildings: { required: [BuildingModel] } }) {
  private position = new Vector3();
  private direction = new Vector3();
  private setupPending = false;
  private placeSetup: (() => void) | null = null;

  init(): void {
    const panel = this.world.getSceneObject<UIKitMLAsset>('welcome-panel');
    const xrButton = panel?.getElementById('xr-button');
    const exitButton = panel?.getElementById('exit-button');
    const centerButton = panel?.getElementById('center-room-button');
    const bringButton = panel?.getElementById('bring-building-button');
    const status = panel?.getElementById('setup-status');
    const placeSetup = () => {
      if (!panel) return;
      this.world.camera.getWorldDirection(this.direction);
      this.direction.y = 0;
      if (this.direction.lengthSq() < 0.01) this.direction.set(0, 0, -1);
      this.direction.normalize();
      this.player.head.getWorldPosition(this.position);
      panel.position.copy(this.position).addScaledVector(this.direction, 0.55);
      panel.position.x -= this.direction.z * 0.5;
      panel.position.z += this.direction.x * 0.5;
      panel.position.y = this.position.y - 0.1;
      panel.rotation.set(0, Math.atan2(-this.direction.x, -this.direction.z), 0);
      panel.updateMatrixWorld(true);
    };
    this.placeSetup = placeSetup;
    const bringBuilding = () => {
      this.world.camera.getWorldDirection(this.direction);
      this.direction.y = 0;
      this.direction.normalize();
      this.player.head.getWorldPosition(this.position);
      this.position.addScaledVector(this.direction, 0.55);
      this.position.x += this.direction.z * 0.22;
      this.position.z -= this.direction.x * 0.22;
      this.position.y -= 0.35;
      for (const entity of this.queries.buildings.entities) {
        this.world.getSystem(GrabSystem)?.forceRelease(entity);
        const object = entity.object3D;
        if (!object) continue;
        object.position.copy(this.position);
        object.rotation.set(0, 0, 0);
        object.scale.setScalar(0.75);
        object.updateMatrixWorld(true);
      }
      status?.setProperties({ text: 'Building within reach. Pinch to grab; use two hands to zoom.' });
    };
    const centerRoom = () => {
      this.world.camera.getWorldDirection(this.direction);
      this.direction.y = 0;
      if (this.direction.lengthSq() > 0.01) {
        const yaw = Math.atan2(-this.direction.x, -this.direction.z);
        this.player.rotation.y -= yaw;
      }
      this.player.updateMatrixWorld(true);
      this.player.head.getWorldPosition(this.position);
      this.player.position.x -= this.position.x;
      this.player.position.z -= this.position.z;
      this.player.updateMatrixWorld(true);
      bringBuilding();
      placeSetup();
      status?.setProperties({ text: 'Room centered. Building ready to grab in front of you.' });
    };
    const launchXR = () => this.world.launchXR();
    const exitXR = () => this.world.exitXR();
    xrButton?.addEventListener('click', launchXR);
    exitButton?.addEventListener('click', exitXR);
    centerButton?.addEventListener('click', centerRoom);
    bringButton?.addEventListener('click', bringBuilding);
    this.cleanupFuncs.push(
      () => xrButton?.removeEventListener('click', launchXR),
      () => exitButton?.removeEventListener('click', exitXR),
      () => centerButton?.removeEventListener('click', centerRoom),
      () => bringButton?.removeEventListener('click', bringBuilding),
      this.world.visibilityState.subscribe((state) => {
        const is2D = state === VisibilityState.NonImmersive;
        xrButton?.setProperties({ display: is2D ? 'flex' : 'none' });
        exitButton?.setProperties({ display: is2D ? 'none' : 'flex' });
        this.setupPending = !is2D;
      }),
    );
  }

  update(): void {
    // The visibility event can arrive before the first tracked viewer pose.
    if (!this.setupPending) return;
    this.player.head.getWorldPosition(this.position);
    if (this.position.y < 0.25) return;
    this.placeSetup?.();
    this.setupPending = false;
  }
}
