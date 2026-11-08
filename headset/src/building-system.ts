import {
  Box3, Color, Group, MeshStandardMaterial, TwoHandsGrabbable, UIKitMLAsset, Vector3, createSystem,
} from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import { BuildingModel } from './components.js';
import { BuildingInspection } from './building-inspection.js';
import { fetchBuilding, IncidentSocket } from './incident-client.js';
import { placeBuildingOnDesk } from './room-layout.js';
import { createIncidentBuilding, FLOOR_HEIGHT } from './scene-assets/incident-building.scene-asset.js';
import type { Building, IncidentState } from './incident-types.js';

/** The building the incident runs on, as named in state.building (absent: the demo). */
type BuildingRef = { id: string; version: number | null; name?: string };
const DEMO_ID = 'demo';
const panelText = (value: string): string => value.replace(/[\u2013\u2014]/g, '-').replace(/[^\x20-\x7e]/g, '');

const unit = (value: number): number => Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
interface RoomVisual {
  id: string;
  material: MeshStandardMaterial;
  neighbours: RoomVisual[];
  fire: number;
  smoke: number;
  own: number;
  target: number;
  displayed: number;
  route: boolean;
}

export class BuildingSystem extends createSystem({}) {
  private roomMaterials = new Map<string, MeshStandardMaterial>();
  private visuals: RoomVisual[] = [];
  private byId = new Map<string, RoomVisual>();
  private handle: Group | null = null;
  private floorGroups: Map<number, Group> | null = null;
  private floorCount = 1;
  private origin: string | undefined;
  private elapsed = 0;
  private selected: string | null = null;
  private inspection: BuildingInspection | null = null;
  // The neutral bridge avoids a green band between cyan and yellow. Green is
  // reserved for an accepted, clear evacuation route.
  private stops = [
    [0, new Color('#ece8de')], [0.15, new Color('#3a6fd8')],
    [0.30, new Color('#22b8e0')], [0.375, new Color('#bdbdbd')],
    [0.45, new Color('#f2e14c')], [0.60, new Color('#ff9a1f')],
    [0.75, new Color('#e8331c')], [0.90, new Color('#9e0d1e')],
    [1, new Color('#d63bd6')],
  ] as const;
  private routeColor = new Color('#0fbf3a');
  private routeGlow = new Color('#078a26');
  private mixColor = new Color();
  private socket: IncidentSocket | null = null;
  private stopped = false;
  private loadTimer: ReturnType<typeof setTimeout> | null = null;
  private loadAbort: AbortController | null = null;
  private entity: Entity | null = null;
  /** Building currently drawn; version null = loaded before any state named one. */
  private loaded: BuildingRef | null = null;
  /** Building the latest state says is active (null until a state arrives). */
  private wanted: BuildingRef | null = null;
  private loadGeneration = 0;
  private latestState: IncidentState | null = null;
  private panel: UIKitMLAsset | null = null;

  init(): void {
    this.cleanupFuncs.push(() => this.stop());
    this.panel = this.world.getSceneObject<UIKitMLAsset>('inspection-panel') ?? null;
    this.showBuildingLabel(null, 'Loading building...');
    // Listen first, so a building switch is seen even while the first load runs.
    this.socket = new IncidentSocket(state => this.onState(state));
    this.socket.connect();
    void this.loadBuilding();
  }

  /** Fetch GET /building and draw it, unless a newer switch superseded this load. */
  private async loadBuilding(): Promise<void> {
    if (this.stopped) return;
    if (this.loadTimer != null) clearTimeout(this.loadTimer);
    this.loadTimer = null;
    this.loadAbort?.abort();
    const generation = ++this.loadGeneration;
    const abort = new AbortController();
    this.loadAbort = abort;
    const timeout = setTimeout(() => abort.abort(), 8000);
    const target = this.wanted;
    let building: Building;
    try {
      building = (await fetchBuilding(abort.signal)).building;
    } catch (error) {
      if (!this.stopped && generation === this.loadGeneration) {
        console.warn('[BuildingSystem] waiting for building server', error);
        if (target && target.id !== DEMO_ID) this.showBuildingLabel(null, `Could not load ${target.name ?? 'the active building'} yet. Retrying.`);
        this.loadTimer = setTimeout(() => { void this.loadBuilding(); }, 2000);
      }
      return;
    } finally {
      clearTimeout(timeout);
    }
    if (this.stopped || generation !== this.loadGeneration) return;
    const id = building.profile?.id ?? DEMO_ID;
    // Never draw a building other than the active one: the server may still be switching.
    if (this.wanted && this.wanted.id !== id) {
      this.loadTimer = setTimeout(() => { void this.loadBuilding(); }, 1000);
      return;
    }
    this.loaded = { id, version: this.wanted?.id === id ? this.wanted.version : null, name: building.profile?.name };
    this.buildModel(building);
    if (this.latestState && this.matches(this.latestState)) this.onState(this.latestState);
  }

  /** Remove the drawn building and everything bound to it (rooms, picking, pins). */
  private clearModel(): void {
    this.inspection?.stop();
    this.inspection = null;
    this.entity?.dispose();
    this.entity = null;
    this.handle = null;
    this.floorGroups = null;
    this.roomMaterials = new Map();
    this.visuals = [];
    this.byId.clear();
    this.selected = null;
    this.origin = undefined;
  }

  private buildModel(building: Building): void {
    this.clearModel();
    const model = createIncidentBuilding(building);
    model.root.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(model.root);
    const center = bounds.getCenter(new Vector3());
    model.root.position.copy(center).multiplyScalar(-1);
    const handle = new Group();
    handle.name = 'Incident Building';
    handle.userData.modelHeight = bounds.max.y - bounds.min.y;
    handle.add(model.root);
    placeBuildingOnDesk(handle);
    const entity = this.world.createTransformEntity(handle);
    this.entity = entity;
    entity.addComponent(BuildingModel);
    entity.addComponent(TwoHandsGrabbable, {
      translate: true, rotate: true, scale: true,
      scaleMin: [0.5, 0.5, 0.5], scaleMax: [3, 3, 3],
    });
    this.roomMaterials = model.roomMaterials;
    this.handle = handle;
    this.floorGroups = model.floorGroups;
    this.floorCount = Math.max(1, ...model.floorGroups.keys());
    for (const [id, material] of this.roomMaterials) {
      const visual: RoomVisual = { id, material, neighbours: [], fire: 0, smoke: 0, own: 0, target: 0, displayed: 0, route: false };
      this.visuals.push(visual);
      this.byId.set(id, visual);
    }
    const floors = new Map(building.rooms.map(room => [room.id, room.floor]));
    for (const link of building.links) {
      if (link.kind !== 'door' || floors.get(link.a) !== floors.get(link.b)) continue;
      const a = this.byId.get(link.a), b = this.byId.get(link.b);
      if (a && b) { a.neighbours.push(b); b.neighbours.push(a); }
    }
    this.inspection = new BuildingInspection(this.world, entity, model, building, id => {
      this.selected = id;
      for (const room of this.visuals) this.paint(room);
    }, id => {
      this.severityColor(this.byId.get(id)?.own ?? 0, this.mixColor);
      return `#${this.mixColor.getHexString()}`;
    });
    this.showBuildingLabel(building);
  }

  /** The inspection panel's BUILDING card: name, floors and source, plus the estimate warning. */
  private showBuildingLabel(building: Building | null, status?: string): void {
    const panel = this.panel;
    if (!panel) return;
    const set = (id: string, props: Record<string, unknown>) => panel.getElementById(id)?.setProperties(props);
    if (!building) {
      set('building-name', { text: panelText(this.wanted?.name ?? 'Building') });
      set('building-detail', { text: panelText(status ?? '') });
      set('building-estimated', { display: 'none' });
      return;
    }
    const profile = building.profile;
    const floors = profile?.floors ?? Math.max(...building.rooms.map(room => room.floor));
    const source = !profile || profile.source === 'demo' ? 'Demo building' : 'Outline from OpenStreetMap';
    set('building-name', { text: panelText(profile?.name ?? 'Meridian Tower (demo)') });
    set('building-detail', { text: panelText(`${floors} floor${floors === 1 ? '' : 's'} | ${source}${profile?.address ? ` | ${profile.address}` : ''}`) });
    set('building-estimated', { display: profile?.layoutEstimated ? 'flex' : 'none' });
  }

  /** Does this state belong to the building that is drawn? */
  private matches(state: IncidentState): boolean {
    const ref = state.building ?? { id: DEMO_ID, version: null };
    return !!this.loaded && this.loaded.id === ref.id
      && (this.loaded.version === null || ref.version === null || this.loaded.version === ref.version);
  }

  stop(): void {
    this.stopped = true;
    if (this.loadTimer != null) clearTimeout(this.loadTimer);
    this.loadAbort?.abort();
    this.socket?.close();
    this.inspection?.stop();
  }

  update(delta: number): void {
    this.elapsed += Math.min(delta, 0.1);
    // Only deliberate enlargement opens the model; ordinary resizing stays intact.
    if (this.handle && this.floorGroups) {
      const stretch = this.inspection?.isSectionCut ? 0 : Math.max(0, this.handle.scale.x - 1.6);
      for (const [floor, group] of this.floorGroups) {
        group.position.y = stretch * (floor / this.floorCount) * FLOOR_HEIGHT * 1.5;
      }
    }
    this.inspection?.update(delta);
    const ease = 1 - Math.exp(-Math.max(0, delta) / 0.8);
    for (const room of this.visuals) {
      room.displayed += (room.target - room.displayed) * ease;
      this.paint(room);
    }
  }

  private paint(room: RoomVisual): void {
    const material = room.material;
    // A clear room is a 6% ghost; skipping its draw call keeps tall looked-up
    // buildings (up to ~480 rooms) inside the Quest 2 draw-call budget.
    material.visible = room.route || room.displayed > 0.01 || room.own > 0 || this.selected === room.id;
    if (room.route && room.fire < 0.15 && room.smoke < 0.15) {
      material.opacity = 0.9;
      material.color.copy(this.routeColor);
      material.emissive.copy(this.routeGlow);
      material.emissiveIntensity = 0.6;
      return;
    }
    this.severityColor(room.displayed, this.mixColor);
    const hazard = Math.max(room.fire, room.smoke);
    const haloOnly = room.own === 0 && room.target > 0;
    // Halos are context, not a claim of measured fire/smoke in an adjacent room.
    material.opacity = haloOnly ? Math.min(0.25, 0.06 + room.displayed * 0.35) : 0.06 + hazard * 0.7;
    if (this.selected === room.id) material.opacity = Math.max(0.4, material.opacity);
    material.color.copy(this.mixColor);
    material.emissive.copy(this.mixColor);
    const base = Math.min(0.6, room.displayed * 0.7);
    material.emissiveIntensity = room.id === this.origin && room.own > 0
      ? Math.min(0.6, base * (0.8 + 0.2 * Math.sin(this.elapsed * 3))) : base;
  }

  private severityColor(severity: number, target: Color): void {
    const s = unit(severity);
    for (let i = 1; i < this.stops.length; i++) {
      const [end, b] = this.stops[i];
      if (s <= end) {
        const [start, a] = this.stops[i - 1];
        target.lerpColors(a, b, (s - start) / (end - start));
        return;
      }
    }
    target.copy(this.stops[this.stops.length - 1][1]);
  }

  private onState(state: IncidentState): void {
    this.latestState = state;
    const ref: BuildingRef = state.building
      ? { id: state.building.id, version: state.building.version, name: state.building.name }
      : { id: DEMO_ID, version: null };
    this.wanted = ref;
    if (this.loaded && this.loaded.id === ref.id && this.loaded.version === null) this.loaded.version = ref.version;
    if (!this.matches(state)) {
      // The active building changed (new address, or back to the demo): drop the old
      // model at once so the headset never shows the wrong building, then load the new one.
      if (this.loaded) {
        this.clearModel();
        this.loaded = null;
        this.showBuildingLabel(null, 'Loading the active building...');
        void this.loadBuilding();
      }
      return;
    }
    this.origin = state.origin?.roomId;
    const routeRooms = new Set(state.accepted ? (state.exits ?? []).flatMap(exit => exit.route ?? []) : []);
    for (const room of this.visuals) {
      room.fire = 0; room.smoke = 0; room.own = 0;
      room.route = routeRooms.has(room.id);
    }
    for (const value of state.rooms) {
      const room = this.byId.get(value.roomId);
      if (!room) continue;
      room.fire = unit(value.fire); room.smoke = unit(value.smoke);
      room.own = room.fire > 0.05 ? 0.55 + 0.45 * room.fire : 0.5 * room.smoke;
    }
    for (const room of this.visuals) {
      let neighbour = 0;
      for (const other of room.neighbours) neighbour = Math.max(neighbour, other.own);
      room.target = Math.max(room.own, 0.55 * neighbour);
      // A reset must not leave a lingering incident on a clean demo.
      if (!state.origin && !state.reports.length) room.displayed = room.target;
      this.paint(room);
    }
    this.inspection?.onState(state);
  }
}
