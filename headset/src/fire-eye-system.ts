import { Box3, Group, Quaternion, Raycaster, UIKitMLAsset, Vector3, VisibilityState, createSystem, type Entity, type Object3D } from '@iwsdk/core';
import { fetchBuilding, IncidentSocket } from './incident-client.js';
import type { IncidentState, MapIncident } from './incident-types.js';
import { FireEyeMap } from './fire-eye-map.js';
import { FireEyeAtmosphere } from './fire-eye-atmosphere.js';
import { FireEyeStatus, type FireEyePhase, type FireEyeState } from './fire-eye-state.js';
import { PullGesture } from './pull-gesture.js';
import { StreetViewClient, type PanoMetadata } from './street-view-client.js';
import { AimReticle, StreetViewScene } from './street-view.js';

type Hand = 'left' | 'right';
const HANDS: Hand[] = ['right', 'left'];
/** Search radius around an aimed point; aiming is coarse at city distance. */
const AIM_RADIUS_METRES = 50;
const INCIDENT_RADIUS_METRES = 100;
/** Incident rows shown per list page; Previous/Next pages through the rest. */
const LIST_ROWS = 5;

/** Keep the original command desk available at ?view=firewatch. */
export const fireEyeRequested = (): boolean => new URLSearchParams(location.search).get('view') !== 'firewatch';
const clean = (text: string): string => text.replace(/[\u2013\u2014]/g, '-').replace(/[^\x20-\x7e]/g, '');
const validLocation = (lat: number, lon: number): boolean => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
const shortPlace = (incident: MapIncident): string => {
  const place = (incident.formatted ?? incident.query ?? '').split(',').slice(0, 2).join(',').trim();
  return place.length > 44 ? `${place.slice(0, 43)}...` : place;
};

export class FireEyeSystem extends createSystem({}) {
  private panel: UIKitMLAsset | null = null;
  private room: Object3D | null = null;
  private marker: Object3D | null = null;
  private map: FireEyeMap | null = null;
  private atmosphere: FireEyeAtmosphere | null = null;
  private mapEntity: Entity | null = null;
  private lifecycle: Entity | null = null;
  private socket: IncidentSocket | null = null;
  private abort: AbortController | null = null;
  private state: FireEyeState = { phase: 'briefing', status: 'Waiting for agent recommendations', latitude: null, longitude: null, tilesLoaded: 0, perspective: 'overview', street: 'off', panoId: null };
  private streetClient: StreetViewClient | null = null;
  private streetScene: StreetViewScene | null = null;
  private reticle: AimReticle | null = null;
  private streetAbort: AbortController | null = null;
  private hopping = false;
  private readonly gesture = new PullGesture();
  private gestureHand: Hand | null = null;
  private gestureTarget: Vector3 | null = null;
  private aimHand: Hand = 'right';
  private readonly raycaster = new Raycaster();
  private readonly eye = new Vector3();
  private readonly handPos = new Vector3();
  private readonly handDir = new Vector3();
  private readonly handQuat = new Quaternion();
  private readonly panelBox = new Box3();
  private actions: string[] = [];
  private actionLines: string[] = [];
  private actionPage = 0;
  private fingerprint = '';
  private buildingKey = '';
  private generation = 0;
  private elapsed = 0;
  private countdown = 0;
  private transition = 0;
  private connected = false;
  private manualPreview = false;
  private token = '';
  private incidents: MapIncident[] = [];
  private selectedId: string | null = null;
  private incidentPage = 0;
  private menuOpen = false;
  /** The city opens only after an explicit pick, once its map is ready. */
  private flyWhenReady = false;
  private overlayKey = '';
  private overlayMap: FireEyeMap | null = null;

  init(): void {
    this.panel = this.world.getSceneObject<UIKitMLAsset>('fire-eye-panel') ?? null;
    this.room = this.world.getSceneObject('briefing-room') ?? null;
    this.marker = this.world.getSceneObject('fire-eye-marker') ?? null;
    if (this.marker) this.marker.visible = false;
    if (!fireEyeRequested()) {
      if (this.panel) this.panel.visible = false;
      if (this.room) this.room.visible = false;
      return;
    }
    for (const id of ['command-room', 'command-desk', 'welcome-panel', 'voice-panel', 'resources-panel', 'inspection-panel']) {
      const object = this.world.getSceneObject(id);
      if (object) object.visible = false;
    }
    this.atmosphere = new FireEyeAtmosphere(this.world);
    this.world.renderer.shadowMap.enabled = false;
    // City meshes are hundreds of metres away; the desk's 1 mm near plane loses
    // enough depth precision there to make roofs and roads fight each other.
    this.world.camera.near = 0.5;
    this.world.camera.far = 3000;
    this.world.camera.updateProjectionMatrix();
    const statusObject = new Group(); statusObject.name = 'FireEye status';
    this.lifecycle = this.world.createTransformEntity(statusObject);
    this.lifecycle.addComponent(FireEyeStatus);
    this.token = import.meta.env.GOOGLE_MAPS_API_KEY ?? '';
    // Street View reuses the same Map Tiles API key with its own session.
    this.streetClient = this.token ? new StreetViewClient(this.token) : null;
    this.streetScene = new StreetViewScene();
    this.streetScene.setAnisotropy(Math.min(4, this.world.renderer.capabilities.getMaxAnisotropy()));
    this.reticle = new AimReticle();
    const streetEntities = [this.world.createTransformEntity(this.streetScene.root), this.world.createTransformEntity(this.reticle.root)];
    this.raycaster.far = 3000;
    for (const id of ['fireeye-streetview', 'fireeye-streetview-cancel', 'fireeye-streetview-exit']) this.bind(id, () => this.toggleStreet());
    for (let i = 0; i < LIST_ROWS; i++) this.bind(`fireeye-incident-${i}`, () => this.pickIncident(this.incidentPage * LIST_ROWS + i));
    this.bind('fireeye-incident-toggle', () => { this.menuOpen = !this.menuOpen; this.renderIncidents(); });
    this.bind('fireeye-incident-prev', () => this.pageIncidents(-1));
    this.bind('fireeye-incident-next', () => this.pageIncidents(1));
    this.bind('fireeye-enter', () => { void this.world.launchXR(); });
    this.bind('fireeye-exit', () => { void this.world.exitXR(); });
    this.bind('fireeye-retry', () => { void this.resolveLocation(); });
    this.bind('fireeye-back', () => { this.manualPreview = false; this.flyWhenReady = false; this.showBriefing(); });
    this.bind('fireeye-resume', () => { this.manualPreview = true; this.maybeStartCountdown(true); });
    this.bind('fireeye-more', () => {
      this.actionPage = (this.actionPage + 1) % Math.max(1, Math.ceil(this.actionLines.length / 3));
      this.renderRecommendations();
    });
    for (const view of ['overview', 'north', 'east', 'south', 'west'] as const) {
      this.bind(`fireeye-${view}`, () => {
        if (this.state.phase !== 'city') return;
        this.exitStreet();
        this.map?.setPerspective(view);
        if (this.marker && this.map) this.marker.position.copy(this.map.anchor.position);
        this.state.perspective = view;
        this.lifecycle?.setValue(FireEyeStatus, 'perspective', view);
        this.set('fireeye-map-status', { text: `City view / ${view} / target 45 degrees below eye level` });
      });
    }
    let wasImmersive = false;
    this.cleanupFuncs.push(this.world.visibilityState.subscribe(value => {
      const isImmersive = value !== VisibilityState.NonImmersive;
      this.set('fireeye-enter', { display: isImmersive ? 'none' : 'flex' });
      this.set('fireeye-exit', { display: isImmersive ? 'flex' : 'none' });
      if (wasImmersive && !isImmersive) {
        this.manualPreview = false;
        this.flyWhenReady = false;
        this.showBriefing();
      }
      wasImmersive = isImmersive;
    }));
    this.socket = new IncidentSocket(state => this.onState(state), status => {
      this.connected = status === 'connected';
      if (!this.manualPreview && !this.connected && (this.state.phase === 'countdown' || this.state.phase === 'transition')) this.showBriefing();
      this.renderRecommendations();
      this.maybeStartCountdown();
    });
    this.socket.connect();
    void this.resolveLocation();
    this.cleanupFuncs.push(() => {
      this.generation++;
      this.abort?.abort();
      this.socket?.close();
      this.clearMap();
      this.atmosphere?.dispose();
      this.lifecycle?.dispose();
      this.streetScene?.dispose();
      this.reticle?.dispose();
      for (const entity of streetEntities) entity.dispose();
    });
    if (import.meta.env.DEV) (window as unknown as { __fireeye: unknown }).__fireeye = { state: this.state, system: this };
  }

  private bind(id: string, handler: () => void): void {
    const element = this.panel?.getElementById(id);
    if (!element) return;
    element.name = id;
    element.addEventListener('click', handler);
    this.cleanupFuncs.push(() => element.removeEventListener('click', handler));
  }

  private set(id: string, props: Record<string, unknown>): void { this.panel?.getElementById(id)?.setProperties(props); }

  private phase(phase: FireEyePhase): void {
    this.state.phase = phase;
    this.atmosphere?.setCityVisible(phase === 'city');
    this.lifecycle?.setValue(FireEyeStatus, 'phase', phase);
    this.set('fireeye-status-box', { backgroundColor: phase === 'error' ? '#64372b' : phase === 'city' ? '#174c42' : '#193b48' });
  }

  private onState(state: IncidentState): void {
    this.incidents = (state.mapIncidents ?? [])
      .filter(incident => incident.location && validLocation(incident.location.lat, incident.location.lon));
    this.renderIncidents();
    const selected = this.selectedIncident();
    const key = state.building ? `${state.building.id}:${state.building.version}` : 'demo';
    if (this.buildingKey && key !== this.buildingKey && !selected) {
      this.actions = []; this.fingerprint = '';
      void this.resolveLocation();
    }
    this.buildingKey = key;
    this.syncOverlay();
    const recommendation = selected ? selected.recommendation ?? selected.accepted?.recommendation : state.recommendation;
    this.setActions(recommendation?.actions?.filter(action => typeof action === 'string' && action.trim()) ?? []);
  }

  private selectedIncident(): MapIncident | undefined {
    return this.selectedId ? this.incidents.find(incident => incident.id === this.selectedId) : undefined;
  }

  /** Fly the city to the picked incident and show its own recommendations. */
  private pickIncident(index: number): void {
    const incident = this.incidents[index];
    if (!incident?.location) return;
    this.selectedId = incident.id;
    this.menuOpen = false;
    this.renderIncidents();
    const recommendation = incident.recommendation ?? incident.accepted?.recommendation;
    this.setActions(recommendation?.actions?.filter(action => typeof action === 'string' && action.trim()) ?? []);
    const here = this.map && this.state.latitude === incident.location.lat && this.state.longitude === incident.location.lon;
    if (!here) void this.resolveLocation();
    else this.syncOverlay();
    this.flyWhenReady = this.state.phase !== 'city';
    this.maybeStartCountdown();
  }

  private pageIncidents(step: number): void {
    const pages = Math.max(1, Math.ceil(this.incidents.length / LIST_ROWS));
    this.incidentPage = (this.incidentPage + step + pages) % pages;
    this.renderIncidents();
  }

  private renderIncidents(): void {
    const total = this.incidents.length;
    const pages = Math.max(1, Math.ceil(total / LIST_ROWS));
    this.incidentPage = Math.min(this.incidentPage, pages - 1);
    const first = this.incidentPage * LIST_ROWS;
    this.set('fireeye-incidents', { display: total ? 'flex' : 'none' });
    this.set('fireeye-incident-menu', { display: this.menuOpen ? 'flex' : 'none' });
    const selected = this.selectedIncident();
    const arrow = this.menuOpen ? '^' : 'v';
    this.set('fireeye-incident-toggle-label', { text: clean(selected ? `${selected.label} - ${shortPlace(selected)}  ${arrow}` : `Select an incident (${total})  ${arrow}`) });
    this.set('fireeye-incident-pager', { display: total > LIST_ROWS ? 'flex' : 'none' });
    this.set('fireeye-incidents-header', { text: `INCIDENTS ${first + 1}-${Math.min(total, first + LIST_ROWS)} OF ${total} / PINCH ONE TO VIEW IT` });
    for (let i = 0; i < LIST_ROWS; i++) {
      const incident = this.incidents[first + i];
      this.set(`fireeye-incident-${i}`, { display: incident ? 'flex' : 'none' });
      if (incident) this.set(`fireeye-incident-label-${i}`, { text: clean(`${incident.id === this.selectedId ? '> ' : ''}${incident.label} - ${shortPlace(incident)}`) });
    }
  }

  /** Crashes draw their blocked and queued road segments in red on the city. */
  private syncOverlay(): void {
    if (!this.map) return;
    const paths = this.selectedIncident()?.crash?.segments.map(segment => segment.path) ?? [];
    const key = JSON.stringify(paths);
    if (key === this.overlayKey && this.overlayMap === this.map) return;
    this.overlayKey = key; this.overlayMap = this.map;
    this.map.setRoadOverlay(paths);
  }

  private setActions(actions: string[]): void {
    const fingerprint = JSON.stringify(actions);
    if (fingerprint !== this.fingerprint) {
      this.fingerprint = fingerprint;
      this.actions = actions;
      this.actionPage = 0;
      this.actionLines = actions.flatMap((action, index) => {
        const words = clean(action).split(/\s+/);
        const lines: string[] = [];
        let line = `${index + 1}.`;
        for (const word of words) {
          if (line.length + word.length > 150) { lines.push(line); line = 'Continued:'; }
          line += ` ${word}`;
        }
        lines.push(line);
        return lines;
      });
      if (!this.manualPreview && (this.state.phase === 'countdown' || this.state.phase === 'transition')) this.showBriefing();
      this.renderRecommendations();
      this.maybeStartCountdown();
    }
  }

  private renderRecommendations(): void {
    const lines = this.actionLines.slice(this.actionPage * 3, this.actionPage * 3 + 3);
    for (let i = 0; i < 3; i++) this.set(`fireeye-action-${i}`, {
      text: lines[i] ?? 'Recommendations appear here when the agent finishes.',
      display: i === 0 || lines[i] ? 'flex' : 'none',
    });
    this.set('fireeye-more', { display: this.actionLines.length > 3 ? 'flex' : 'none' });
    this.set('fireeye-page', { text: this.actionLines.length > 3 ? `Recommendation page ${this.actionPage + 1} / ${Math.ceil(this.actionLines.length / 3)}` : '' });
    if (this.state.phase === 'city') {
      this.state.status = !this.connected ? 'Connection interrupted / Showing last received recommendations' : this.actions.length ? 'Agent recommendations / Operator review required' : 'Agent is updating recommendations';
      this.set('fireeye-status', { text: this.state.status });
      return;
    }
    if (['transition', 'countdown', 'error'].includes(this.state.phase)) return;
    this.state.status = !this.connected ? 'Agent connection interrupted - reconnecting' : this.actions.length ? 'Agent recommendations ready' : 'Waiting for agent recommendations';
    this.set('fireeye-status', { text: this.state.status });
  }

  private clearMap(): void {
    this.exitStreet();
    this.map?.dispose();
    this.mapEntity?.dispose();
    this.mapEntity = null; this.map = null;
    this.lifecycle?.setValue(FireEyeStatus, 'mapReady', false);
  }

  private async resolveLocation(): Promise<void> {
    const generation = ++this.generation;
    this.manualPreview = false;
    this.abort?.abort();
    const abort = new AbortController(); this.abort = abort;
    this.clearMap();
    this.state.latitude = null; this.state.longitude = null; this.state.tilesLoaded = 0;
    this.state.perspective = 'overview';
    this.lifecycle?.setValue(FireEyeStatus, 'perspective', 'overview');
    this.showBriefing();
    this.set('fireeye-retry', { display: 'none' });
    if (!this.token) { this.error('Google Maps key is missing. Set GOOGLE_MAPS_API_KEY in the root .env.'); return; }
    const timer = setTimeout(() => abort.abort(), 15000);
    try {
      const params = new URLSearchParams(location.search);
      let lat: number, lon: number;
      if (params.has('lat') || params.has('lon')) {
        lat = Number(params.get('lat')); lon = Number(params.get('lon'));
        if (!params.has('lat') || !params.has('lon') || !params.get('lat')?.trim() || !params.get('lon')?.trim() || !validLocation(lat, lon)) throw new Error('Invalid coordinates. Supply lat (-90..90) and lon (-180..180).');
        this.set('fireeye-location', { text: 'Explicit map coordinates (URL override)' });
      } else if (this.selectedIncident()?.location) {
        const incident = this.selectedIncident()!;
        ({ lat, lon } = incident.location!);
        this.set('fireeye-location', { text: clean(`${incident.label} | ${incident.formatted ?? incident.query ?? ''}`) });
      } else {
        const info = await fetchBuilding(abort.signal);
        if (generation !== this.generation) return;
        const profile = info.building.profile;
        if (!profile?.location || !validLocation(profile.location.lat, profile.location.lon)) throw new Error('No mapped incident location yet. Select a building in the operator console.');
        ({ lat, lon } = profile.location);
        this.set('fireeye-location', { text: clean(`${profile.name}${profile.address ? ` | ${profile.address}` : ''}`) });
      }
      if (generation !== this.generation) return;
      this.state.latitude = lat; this.state.longitude = lon;
      this.set('fireeye-coordinates', { text: `${lat.toFixed(6)}, ${lon.toFixed(6)} | Selected location - confirm with caller` });
      this.set('fireeye-map-status', { text: 'Loading Google 3D city...' });
      const map = new FireEyeMap(this.token, lat, lon, reason => {
        console.error(`FireEye map failed at ${lat}, ${lon}: ${reason}`);
        if (generation === this.generation) this.error(clean(`Map unavailable (${reason}). Retry.`));
      });
      map.anchor.visible = false;
      this.map = map;
      this.mapEntity = this.world.createTransformEntity(map.anchor);
      this.syncOverlay();
    } catch (error) {
      if (generation === this.generation) this.error(error instanceof Error && error.name !== 'AbortError' ? error.message : 'Location lookup timed out. Retry when the server is connected.');
    } finally { clearTimeout(timer); }
  }

  private error(message: string): void {
    this.showBriefing();
    this.phase('error');
    this.state.status = message;
    this.set('fireeye-status', { text: message });
    this.set('fireeye-map-status', { text: 'Briefing remains available' });
    this.set('fireeye-retry', { display: 'flex' });
  }

  private showBriefing(): void {
    this.exitStreet();
    this.phase('briefing'); this.countdown = 0; this.transition = 0;
    this.renderStreetButtons();
    if (this.room) this.room.visible = true;
    if (this.marker) this.marker.visible = false;
    if (this.map) this.map.anchor.visible = false;
    if (this.panel) { this.panel.position.y = 1.5; this.panel.scale.setScalar(0.32); }
    this.set('fireeye-title', { text: 'Incident briefing' });
    this.set('fireeye-map-status', { text: this.map?.ready ? 'Google 3D city ready / Preview available' : 'Loading Google 3D city...' });
    this.set('fireeye-perspectives', { display: 'none' });
    this.set('fireeye-back', { display: 'none' });
    this.set('fireeye-resume', { display: this.map?.ready ? 'flex' : 'none' });
    this.renderRecommendations();
  }

  private maybeStartCountdown(explicit = false): void {
    if (!this.map?.ready || this.state.phase !== 'briefing') return;
    // Never open the city on its own: only a pick (deferred until the map is ready) or Preview city.
    if (!explicit && !this.flyWhenReady) return;
    this.flyWhenReady = false;
    this.phase('countdown'); this.countdown = 2;
    this.set('fireeye-status', { text: this.actions.length ? 'Recommendations ready / City opens in 2 seconds' : 'City preview opens in 2 seconds / Waiting for agent' });
    this.set('fireeye-resume', { display: 'none' });
  }

  update(delta: number): void {
    const map = this.map;
    if (!map) return;
    const visible = document.visibilityState !== 'hidden' && this.world.visibilityState.peek() !== VisibilityState.VisibleBlurred;
    if (!visible) return;
    const dt = Math.min(delta, 0.1);
    // The hidden city needs no tile streaming while a panorama surrounds the user.
    if (this.state.street !== 'street' && map.update(dt, this.world.camera, this.world.renderer)) {
      this.lifecycle?.setValue(FireEyeStatus, 'mapReady', true);
      this.set('fireeye-map-status', { text: 'Google 3D city ready' });
      this.set('fireeye-resume', { display: this.state.phase === 'briefing' ? 'flex' : 'none' });
    }
    this.maybeStartCountdown();
    if (this.state.phase === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.phase('transition');
        this.set('fireeye-status', { text: 'Opening the incident location' });
      }
    }
    if (this.state.phase === 'transition') {
      this.transition = Math.min(1, this.transition + dt / 1.2);
      const t = this.transition * this.transition * (3 - 2 * this.transition);
      if (this.panel) { this.panel.position.y = 1.5 + t * 0.75; this.panel.scale.setScalar(0.32 - t * 0.08); }
      if (this.transition >= 1) {
        if (this.room) this.room.visible = false;
        map.anchor.visible = true;
        if (this.marker) { this.marker.position.copy(map.anchor.position); this.marker.visible = true; }
        this.phase('city');
        this.set('fireeye-title', { text: 'Incident overview' });
        this.renderRecommendations();
        this.set('fireeye-map-status', { text: `City view / ${this.state.perspective} / target 45 degrees below eye level` });
        this.set('fireeye-perspectives', { display: 'flex' });
        this.set('fireeye-back', { display: 'flex' });
        this.renderStreetButtons();
      }
    }
    this.updateStreet(dt);
    this.elapsed += dt;
    if (this.elapsed >= 1) {
      this.elapsed = 0;
      this.state.tilesLoaded = map.tiles.visibleTiles.size;
      const pano = this.state.street === 'street' ? this.streetScene?.meta : null;
      this.set('fireeye-attribution', { text: clean(pano ? `Google Street View | ${pano.copyright}${pano.date ? ` | ${pano.date}` : ''}` : `Google Maps | ${map.attribution()}`) });
    }
  }

  // --- Street View -------------------------------------------------------------

  private street(mode: FireEyeState['street']): void {
    this.state.street = mode;
    this.renderStreetButtons();
  }

  private renderStreetButtons(): void {
    const mode = this.state.street;
    this.set('fireeye-street-row', { display: this.state.phase === 'city' ? 'flex' : 'none' });
    this.set('fireeye-streetview', { display: mode === 'off' ? 'flex' : 'none' });
    this.set('fireeye-streetview-cancel', { display: mode === 'aiming' || mode === 'loading' ? 'flex' : 'none' });
    this.set('fireeye-streetview-exit', { display: mode === 'street' || mode === 'ground' ? 'flex' : 'none' });
  }

  /** The panel toggle: arm aiming, or leave Street View from any street state. */
  private toggleStreet(): void {
    if (this.state.phase !== 'city' || !this.map) return;
    if (this.state.street !== 'off') { this.exitStreet(); return; }
    // A flat browser has no hands or rays to aim with; drop straight to the incident.
    if (!this.world.renderer.xr.isPresenting) { void this.diveAt(null); return; }
    this.street('aiming');
    this.set('fireeye-map-status', { text: 'Street View / Point at the city, pinch, then pull toward you' });
  }

  private exitStreet(): void {
    if (this.state.street === 'off') return;
    this.streetAbort?.abort(); this.streetAbort = null;
    this.hopping = false;
    this.gesture.reset(); this.gestureHand = null; this.gestureTarget = null;
    this.reticle?.hide();
    this.streetScene?.hide();
    this.state.panoId = null;
    this.world.camera.near = 0.5; this.world.camera.updateProjectionMatrix();
    const map = this.map;
    if (map) {
      // Restores the elevated observer after a ground-level drop.
      map.setPerspective(this.state.perspective);
      if (this.state.phase === 'city') {
        map.anchor.visible = true;
        if (this.marker) { this.marker.position.copy(map.anchor.position); this.marker.visible = true; }
        this.set('fireeye-title', { text: 'Incident overview' });
        this.set('fireeye-map-status', { text: `City view / ${this.state.perspective} / target 45 degrees below eye level` });
      }
    }
    this.street('off');
  }

  /** Eye position in world space: the tracked head in XR, the flat camera otherwise. */
  private eyePosition(): Vector3 {
    if (this.world.renderer.xr.isPresenting) this.player.head.getWorldPosition(this.eye);
    else this.world.camera.getWorldPosition(this.eye);
    return this.eye;
  }

  /** Aim the shared raycaster along a hand's target ray. False when that hand is not tracked. */
  private castFrom(hand: Hand): boolean {
    if (!this.input.xr.getPrimaryInputSource(hand)) return false;
    const space = this.player.raySpaces[hand];
    space.getWorldPosition(this.handPos);
    space.getWorldQuaternion(this.handQuat);
    this.handDir.set(0, 0, -1).applyQuaternion(this.handQuat);
    this.raycaster.set(this.handPos, this.handDir);
    return true;
  }

  /** Pinches aimed at the panel belong to its buttons, not to the street gestures. */
  private rayHitsPanel(): boolean {
    if (!this.panel?.visible) return false;
    this.panelBox.setFromObject(this.panel);
    return this.raycaster.ray.intersectsBox(this.panelBox);
  }

  private updateStreet(dt: number): void {
    const map = this.map;
    if (!map || this.state.phase !== 'city') return;
    const eye = this.eyePosition();
    this.streetScene?.update(dt, eye);
    if (!this.world.renderer.xr.isPresenting) return;
    const xr = this.input.xr;
    for (const hand of HANDS) if (xr.getSelectState(hand).start) this.aimHand = hand;

    if (this.state.street === 'aiming') {
      if (this.gesture.active && this.gestureHand) {
        if (!this.castFrom(this.gestureHand)) { this.gesture.reset(); this.reticle?.hide(); return; }
        const result = this.gesture.update(this.handPos, xr.getSelectState(this.gestureHand).active);
        if (result === 'commit') { void this.diveAt(this.gestureTarget); this.gestureTarget = null; return; }
        if (result === 'pulling') {
          this.reticle?.place(this.gestureTarget ?? map.anchor.position, eye, this.gesture.progress, true);
          this.reticle?.update(this.handPos);
          return;
        }
        this.gestureTarget = null;
      }
      if (!this.castFrom(this.aimHand)) { this.reticle?.hide(); return; }
      const overPanel = this.rayHitsPanel();
      const point = overPanel ? null : map.hit(this.raycaster);
      if (point) {
        this.reticle?.place(point, eye, 0, false);
        this.reticle?.update(this.handPos);
      } else {
        this.reticle?.hide();
      }
      if (!overPanel && xr.getSelectState(this.aimHand).start) {
        // Pinching at the sky still works: it lands at the incident coordinate.
        this.gestureHand = this.aimHand;
        this.gestureTarget = point;
        this.gesture.begin(this.handPos, this.handDir);
      }
      return;
    }

    if (this.state.street === 'street' && this.streetScene) {
      let hovered = -1;
      if (!this.hopping && this.castFrom(this.aimHand) && !this.rayHitsPanel()) hovered = this.streetScene.pick(this.raycaster);
      this.streetScene.setHovered(hovered);
      const link = hovered >= 0 && xr.getSelectState(this.aimHand).start ? this.streetScene.link(hovered) : undefined;
      if (link) void this.hop(link.panoId);
    }
  }

  /**
   * Drop to street level at a world point on the city (null: the incident coordinate).
   * Uses the nearest Street View panorama; without imagery, stands on the 3D city.
   */
  async diveAt(target: Vector3 | null): Promise<void> {
    const map = this.map;
    if (!map || this.state.phase !== 'city') return;
    // The incident coordinate sits at the city anchor (recentred, surface-levelled).
    const ground = target ?? map.anchor.position.clone();
    const location = target ? map.toLatLon(target) : this.state.latitude !== null && this.state.longitude !== null ? { lat: this.state.latitude, lon: this.state.longitude } : null;
    const radius = target ? AIM_RADIUS_METRES : INCIDENT_RADIUS_METRES;
    this.streetAbort?.abort();
    const abort = new AbortController(); this.streetAbort = abort;
    this.reticle?.hide();
    this.street('loading');
    this.set('fireeye-map-status', { text: 'Street View / Finding street imagery...' });
    try {
      const meta = this.streetClient && location
        ? await this.streetClient.nearest(location.lat, location.lon, radius, abort.signal)
        : null;
      if (abort.signal.aborted) return;
      if (meta) { await this.openPano(meta, abort); return; }
      // No Google imagery here: stand on the photorealistic city instead.
      const eye = this.eyePosition();
      map.standAt(ground, eye.x, eye.z);
      this.world.camera.near = 0.1; this.world.camera.updateProjectionMatrix();
      if (this.marker) this.marker.visible = false;
      this.street('ground');
      this.set('fireeye-title', { text: 'Street level' });
      this.set('fireeye-map-status', { text: `Street level / 3D city / No Street View imagery within ${radius} m` });
    } catch (error) {
      if (abort.signal.aborted) return;
      this.exitStreet();
      this.set('fireeye-map-status', { text: clean(`Street View unavailable / ${error instanceof Error ? error.message : 'request failed'}`) });
    }
  }

  /** Move to a linked panorama from a floor chevron. */
  async hop(panoId: string): Promise<void> {
    if (!this.streetClient || this.hopping || this.state.street !== 'street') return;
    this.hopping = true;
    this.streetAbort?.abort();
    const abort = new AbortController(); this.streetAbort = abort;
    this.set('fireeye-map-status', { text: 'Street View / Moving...' });
    try {
      const meta = await this.streetClient.metadata(panoId, abort.signal);
      if (abort.signal.aborted) return;
      if (!meta) { this.set('fireeye-map-status', { text: 'Street View / That direction is no longer available' }); return; }
      await this.openPano(meta, abort);
    } catch {
      if (!abort.signal.aborted) this.set('fireeye-map-status', { text: 'Street View / Could not load the next panorama' });
    } finally {
      if (this.streetAbort === abort) this.hopping = false;
    }
  }

  private async openPano(meta: PanoMetadata, abort: AbortController): Promise<void> {
    if (!this.streetClient || !this.streetScene || !this.map) return;
    const map = this.map;
    await this.streetScene.open(meta, this.streetClient, map.yaw, abort.signal, () => {
      map.anchor.visible = false;
      if (this.marker) this.marker.visible = false;
      this.hopping = false;
      this.state.panoId = meta.panoId;
      this.street('street');
      const place = [meta.street, meta.date ? `imagery ${meta.date}` : ''].filter(Boolean).join(' / ');
      this.set('fireeye-title', { text: 'Street View' });
      this.set('fireeye-map-status', { text: clean(`Street View / ${place || 'Street level'}${meta.links.length ? ' / Point at an arrow and pinch to move' : ''}`) });
    });
  }
}
