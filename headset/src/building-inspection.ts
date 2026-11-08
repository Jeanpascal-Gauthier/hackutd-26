import {
  BoxGeometry, Color, EdgesGeometry, Grabbed, InstancedMesh, LineBasicMaterial, LineSegments,
  Object3D, Plane, RayInteractable, UIKitMLAsset, Vector3,
} from '@iwsdk/core';
import type { Entity, Material, World } from '@iwsdk/core';
import type { Building, IncidentState, Room } from './incident-types.js';
import { BUILDING_SCALE, FLOOR_HEIGHT, createOccupantPins, createRoomPicking } from './scene-assets/incident-building.scene-asset.js';
import type { createIncidentBuilding } from './scene-assets/incident-building.scene-asset.js';

type Model = ReturnType<typeof createIncidentBuilding>;
type RoomClick = { pointerType?: string; object?: Object3D; stopPropagation(): void };
const ascii = (value: string): string => value.replace(/[^\x20-\x7e]/g, '');

/** Room picking and its fixed wall card share the building system's lifecycle. */
export class BuildingInspection {
  private selected: string | null = null;
  private rooms: Map<string, Room>;
  private state: IncidentState | null = null;
  private panel: UIKitMLAsset | undefined;
  private outline: LineSegments;
  private lastGrabTime = -1;
  private elapsed = 0;
  private canvasHit = false;
  private maxFloor = 1;
  private cutFloor = 1;
  private localCut = new Plane(new Vector3(0, -1, 0), 0);
  private worldCut = new Plane();
  private clipPlanes = [this.worldCut];
  private clipMaterials = new Set<Material>();
  private setup: UIKitMLAsset | undefined;
  private people: InstancedMesh | null = null;
  private peopleCapacity = 0;
  private peopleSlots: { x: number; y: number; z: number; floor: number }[] = [];
  private pinTransform = new Object3D();
  private personColor = new Color('#609bcc');
  private helpColor = new Color('#db3d46');
  private lastPeopleStretch = -1;
  private peopleDirty = false;
  private picking: ReturnType<typeof createRoomPicking>;
  private cleanups: (() => void)[] = [];

  constructor(
    private world: World, private entity: Entity, private model: Model,
    building: Building, private paintSelection: (id: string | null) => void,
    private severitySwatch: (id: string) => string,
  ) {
    this.rooms = new Map(building.rooms.map(room => [room.id, room]));
    this.maxFloor = Math.max(...building.rooms.map(room => room.floor));
    this.cutFloor = this.maxFloor;
    this.panel = world.getSceneObject<UIKitMLAsset>('inspection-panel');
    const box = new BoxGeometry(1, 1, 1);
    this.outline = new LineSegments(new EdgesGeometry(box), new LineBasicMaterial({ color: '#f4f4ee', toneMapped: false }));
    box.dispose();
    this.outline.name = 'Selected room outline';
    this.outline.scale.setScalar(1.025);
    (this.outline as LineSegments & { pointerEvents: string }).pointerEvents = 'none';
    this.clipMaterials.add(this.outline.material as LineBasicMaterial);
    model.root.traverse(object => {
      const mesh = object as Object3D & { material?: Material | Material[] };
      if (mesh.material) {
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) this.clipMaterials.add(material);
      }
    });
    world.renderer.localClippingEnabled = true;
    this.setup = world.getSceneObject<UIKitMLAsset>('welcome-panel');
    const bindFloor = (id: string, name: string, handler: () => void) => {
      const button = this.setup?.getElementById(id);
      if (button) button.name = name;
      button?.addEventListener('click', handler);
      this.cleanups.push(() => button?.removeEventListener('click', handler));
    };
    bindFloor('floor-up-button', 'Floor up', () => this.setCut(this.cutFloor + 1));
    bindFloor('floor-down-button', 'Floor down', () => this.setCut(this.cutFloor - 1));
    bindFloor('show-all-floors-button', 'Show all floors', () => this.setCut(this.maxFloor));
    this.setCut(this.maxFloor);
    // The grab system owns the handle's pointer policy. Ray-only proxies
    // are siblings of the actual rooms, so neither input path steals the other.
    this.picking = createRoomPicking(model.roomMeshes);
    this.picking.root.position.copy(model.root.position);
    world.createTransformEntity(this.picking.root, { parent: entity }).addComponent(RayInteractable);
    (this.picking.root as Object3D & { pointerEventsType: { deny: string } }).pointerEventsType = { deny: 'grab' };
    const click = (event: RoomClick) => {
      this.canvasHit = true;
      if (event.pointerType === 'grab' || event.pointerType === 'touch' || entity.hasComponent(Grabbed)
        || this.elapsed - this.lastGrabTime < 0.25) return;
      const id = event.object?.userData.roomId as string | undefined;
      if (!id || !this.rooms.has(id)) return;
      event.stopPropagation();
      this.select(this.selected === id ? null : id);
    };
    for (const mesh of this.picking.meshes.values()) {
      const target = mesh;
      target.addEventListener('click', click);
      this.cleanups.push(() => target.removeEventListener('click', click));
    }
    const clear = () => this.select(null);
    const button = this.panel?.getElementById('clear-room-selection');
    if (button) button.name = 'Clear room selection';
    button?.addEventListener('click', clear);
    this.cleanups.push(() => button?.removeEventListener('click', clear));
    const canvas = world.renderer.domElement;
    const down = () => { this.canvasHit = false; };
    const up = () => { queueMicrotask(() => { if (!this.canvasHit) clear(); }); };
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointerup', up);
    this.cleanups.push(() => { canvas.removeEventListener('pointerdown', down); canvas.removeEventListener('pointerup', up); });
    // Empty-space XR selections have no mesh callback to clear the card.
    const attach = () => {
      const session = world.renderer.xr.getSession();
      if (!session) return;
      const missed = (event: XRInputSourceEvent) => {
        const side = event.inputSource.handedness;
        if (side !== 'left' && side !== 'right') return;
        const pointers = world.input.xr.multiPointers[side];
        const hit = pointers.getPointer('ray').getIntersection();
        if ((!hit || hit.distance > world.camera.far) && !entity.hasComponent(Grabbed)) clear();
      };
      session.addEventListener('selectend', missed);
      this.cleanups.push(() => session.removeEventListener('selectend', missed));
    };
    world.renderer.xr.addEventListener('sessionstart', attach);
    this.cleanups.push(() => world.renderer.xr.removeEventListener('sessionstart', attach));
    attach();
    this.renderCard();
  }

  update(delta: number): void {
    this.elapsed += delta;
    if (this.entity.hasComponent(Grabbed)) this.lastGrabTime = this.elapsed;
    if (this.isSectionCut) {
      // Clipping planes are in world space; derive this one from model space
      // after grab/rotate/scale, rather than slicing the studio at a fixed height.
      this.localCut.constant = 0.014 + this.cutFloor * FLOOR_HEIGHT;
      this.model.root.updateWorldMatrix(true, false);
      this.worldCut.copy(this.localCut).applyMatrix4(this.model.root.matrixWorld);
    }
    for (const [id, proxy] of this.picking?.meshes ?? []) {
      const mesh = this.model.roomMeshes.get(id)!;
      proxy.position.y = mesh.position.y + (mesh.parent?.position.y ?? 0);
      proxy.visible = mesh.parent?.visible ?? true;
    }
    this.updatePeople();
  }

  onState(state: IncidentState): void {
    this.state = state;
    for (const [id, material] of this.model.verticalMaterials) {
      const served = state.rooms.filter(room => room.roomId.endsWith(`-${id}`));
      const used = !!state.accepted && !!state.exits?.some(exit => exit.stair === id);
      const safe = served.length > 0 && served.every(room => room.fire < 0.15 && room.smoke < 0.15);
      material.color.set(used && safe ? '#0fbf3a' : id.includes('stair') ? '#434d57' : '#657180');
      material.emissive.copy(material.color);
      material.emissiveIntensity = used && safe ? 0.2 : 0;
    }
    this.syncPeople(state);
    this.renderCard();
  }

  get isSectionCut(): boolean { return this.cutFloor < this.maxFloor; }

  setCut(floor: number): void {
    this.cutFloor = Math.max(1, Math.min(this.maxFloor, Math.round(floor)));
    for (const [level, group] of this.model.floorGroups) group.visible = level <= this.cutFloor;
    for (const material of this.clipMaterials) material.clippingPlanes = this.isSectionCut ? this.clipPlanes : null;
    this.setup?.getElementById('floor-cut-status')?.setProperties({ text: this.isSectionCut ? `Showing floors 1-${this.cutFloor}` : `All ${this.maxFloor} floors. Enlarge above 1.6x to open layers.` });
    this.setup?.getElementById('floor-up-button')?.setProperties({ disabled: this.cutFloor === this.maxFloor });
    this.setup?.getElementById('floor-down-button')?.setProperties({ disabled: this.cutFloor === 1 });
    this.peopleDirty = true;
    this.update(0);
  }

  select(id: string | null): void {
    this.selected = id && this.rooms.has(id) ? id : null;
    const room = this.selected ? this.rooms.get(this.selected) : null;
    if (room && room.floor > this.cutFloor) this.setCut(room.floor);
    this.outline.removeFromParent();
    const mesh = this.selected ? this.model.roomMeshes.get(this.selected) : null;
    if (mesh) mesh.add(this.outline);
    this.paintSelection(this.selected);
    this.renderCard();
  }

  private renderCard(): void {
    const panel = this.panel;
    if (!panel) return;
    const room = this.selected ? this.rooms.get(this.selected) : null;
    panel.getElementById('selected-room-hint')?.setProperties({ display: room ? 'none' : 'flex' });
    panel.getElementById('selected-room-details')?.setProperties({ display: room ? 'flex' : 'none' });
    if (!room) return;
    const value = this.state?.rooms.find(value => value.roomId === room.id);
    const occupants = this.state?.occupants.filter(value => value.room === room.id) ?? [];
    const count = occupants.reduce((total, value) => total + value.count, 0);
    const flags = [...new Set(occupants.flatMap(value => value.flags))];
    const route = !!this.state?.accepted && !!this.state.exits?.some(exit => exit.route?.includes(room.id));
    const fire = value?.fire ?? 0, smoke = value?.smoke ?? 0;
    const safe = fire < 0.15 && smoke < 0.15;
    const set = (id: string, text: string) => panel.getElementById(id)?.setProperties({ text: ascii(text) });
    set('selected-room-title', `${room.name} (${room.id})`);
    set('selected-room-floor', `Floor ${room.floor} | Fire ${Math.round(fire * 100)}% | Smoke ${Math.round(smoke * 100)}%`);
    set('selected-room-occupants', `${count} people | ${flags.length ? `Needs help: ${flags.join(', ')}` : 'No assistance flags'}`);
    set('selected-room-route', route ? safe ? 'On accepted route - currently clear' : 'On accepted route - HAZARD PRESENT' : 'Not on accepted route');
    panel.getElementById('selected-room-swatch')?.setProperties({ backgroundColor: this.severitySwatch(room.id) });
  }

  private syncPeople(state: IncidentState): void {
    const total = state.occupants.reduce((sum, value) => sum + Math.max(0, Math.floor(value.count)), 0);
    const capacity = Math.max(1, Math.min(1024, total));
    if (!this.people || capacity > this.peopleCapacity) {
      if (this.people) {
        this.people.removeFromParent();
        this.people.geometry.dispose();
        this.clipMaterials.delete(this.people.material as Material);
        (this.people.material as Material).dispose();
      }
      this.peopleCapacity = capacity;
      this.people = createOccupantPins(capacity);
      const material = this.people.material as Material;
      material.clippingPlanes = this.isSectionCut ? this.clipPlanes : null;
      this.clipMaterials.add(material);
      this.model.root.add(this.people);
    }
    this.peopleSlots.length = 0;
    const totals = new Map<string, number>();
    const placed = new Map<string, number>();
    for (const value of state.occupants) totals.set(value.room, (totals.get(value.room) ?? 0) + Math.max(0, Math.floor(value.count)));
    for (const occupants of state.occupants) {
      const room = this.rooms.get(occupants.room);
      if (!room) continue;
      const count = Math.min(capacity - this.peopleSlots.length, Math.max(0, Math.floor(occupants.count)));
      const totalInRoom = totals.get(room.id) ?? count;
      const cols = Math.max(1, Math.ceil(Math.sqrt(totalInRoom * room.w / room.d)));
      const rows = Math.max(1, Math.ceil(totalInRoom / cols));
      const start = placed.get(room.id) ?? 0;
      placed.set(room.id, start + count);
      for (let person = 0; person < count; person++) {
        const n = start + person;
        const index = this.peopleSlots.length;
        this.peopleSlots.push({
          x: (room.x + room.w * (0.15 + 0.7 * ((n % cols) + 0.5) / cols)) * BUILDING_SCALE,
          z: (room.z + room.d * (0.15 + 0.7 * (Math.floor(n / cols) + 0.5) / rows)) * BUILDING_SCALE,
          // Cone is 0.01 tall and centred; its base rests on the slab top (0.014).
          y: 0.019 + (room.floor - 1) * FLOOR_HEIGHT, floor: room.floor,
        });
        this.people.setColorAt(index, occupants.flags.length ? this.helpColor : this.personColor);
      }
    }
    this.people.count = this.peopleSlots.length;
    if (this.people.instanceColor) this.people.instanceColor.needsUpdate = true;
    this.peopleDirty = true;
    this.panel?.getElementById('people-pins-status')?.setProperties({ text: `${this.people.count}${total > capacity ? `/${total}` : ''} people pins: blue = people, red = needs help.` });
    this.updatePeople();
  }

  private updatePeople(): void {
    if (!this.people) return;
    const stretch = this.model.floorGroups.get(this.maxFloor)?.position.y ?? 0;
    if (!this.peopleDirty && stretch === this.lastPeopleStretch) return;
    this.peopleDirty = false;
    this.lastPeopleStretch = stretch;
    for (let i = 0; i < this.peopleSlots.length; i++) {
      const pin = this.peopleSlots[i];
      this.pinTransform.position.set(pin.x, pin.y + (this.model.floorGroups.get(pin.floor)?.position.y ?? 0), pin.z);
      this.pinTransform.scale.setScalar(pin.floor <= this.cutFloor ? 1 : 0);
      this.pinTransform.updateMatrix();
      this.people.setMatrixAt(i, this.pinTransform.matrix);
    }
    this.people.instanceMatrix.needsUpdate = true;
  }

  stop(): void {
    for (const cleanup of this.cleanups) cleanup();
    this.picking.root.removeFromParent();
    this.picking.material.dispose();
    this.outline.removeFromParent();
    this.outline.geometry.dispose();
    (this.outline.material as LineBasicMaterial).dispose();
  }
}
