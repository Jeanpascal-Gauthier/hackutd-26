import { Group, UIKitMLAsset, VisibilityState, createSystem, type Entity, type Object3D } from '@iwsdk/core';
import { fetchBuilding, IncidentSocket } from './incident-client.js';
import type { IncidentState } from './incident-types.js';
import { FireEyeMap } from './fire-eye-map.js';
import { FireEyeAtmosphere } from './fire-eye-atmosphere.js';
import { FireEyeStatus, type FireEyePhase, type FireEyeState } from './fire-eye-state.js';

/** Keep the original command desk available at ?view=firewatch. */
export const fireEyeRequested = (): boolean => new URLSearchParams(location.search).get('view') !== 'firewatch';
const clean = (text: string): string => text.replace(/[\u2013\u2014]/g, '-').replace(/[^\x20-\x7e]/g, '');
const validLocation = (lat: number, lon: number): boolean => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

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
  private state: FireEyeState = { phase: 'briefing', status: 'Waiting for agent recommendations', latitude: null, longitude: null, tilesLoaded: 0, perspective: 'overview' };
  private actions: string[] = [];
  private actionLines: string[] = [];
  private actionPage = 0;
  private fingerprint = '';
  private buildingKey = '';
  private generation = 0;
  private elapsed = 0;
  private countdown = 0;
  private transition = 0;
  private paused = false;
  private connected = false;
  private manualPreview = false;
  private token = '';

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
    this.bind('fireeye-enter', () => { void this.world.launchXR(); });
    this.bind('fireeye-exit', () => { void this.world.exitXR(); });
    this.bind('fireeye-retry', () => { void this.resolveLocation(); });
    this.bind('fireeye-back', () => { this.manualPreview = false; this.paused = true; this.showBriefing(); });
    this.bind('fireeye-resume', () => { this.manualPreview = true; this.paused = false; this.maybeStartCountdown(true); });
    this.bind('fireeye-more', () => {
      this.actionPage = (this.actionPage + 1) % Math.max(1, Math.ceil(this.actionLines.length / 3));
      this.renderRecommendations();
    });
    for (const view of ['overview', 'north', 'east', 'south', 'west'] as const) {
      this.bind(`fireeye-${view}`, () => {
        if (this.state.phase !== 'city') return;
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
        this.paused = true;
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
    const key = state.building ? `${state.building.id}:${state.building.version}` : 'demo';
    if (this.buildingKey && key !== this.buildingKey) {
      this.actions = []; this.fingerprint = '';
      void this.resolveLocation();
    }
    this.buildingKey = key;
    const actions = state.recommendation?.actions?.filter(action => typeof action === 'string' && action.trim()) ?? [];
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
      const map = new FireEyeMap(this.token, lat, lon, () => {
        if (generation === this.generation) this.error('Map unavailable. Check Map Tiles API access or the network, then retry.');
      });
      map.anchor.visible = false;
      this.map = map;
      this.mapEntity = this.world.createTransformEntity(map.anchor);
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
    this.phase('briefing'); this.countdown = 0; this.transition = 0;
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
    if (!this.map?.ready || this.paused || this.state.phase !== 'briefing') return;
    if (!explicit && (!this.connected || !this.actions.length)) return;
    if (document.visibilityState === 'hidden' && !explicit) return;
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
    if (map.update(dt, this.world.camera, this.world.renderer)) {
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
      }
    }
    this.elapsed += dt;
    if (this.elapsed >= 1) {
      this.elapsed = 0;
      this.state.tilesLoaded = map.tiles.visibleTiles.size;
      this.set('fireeye-attribution', { text: clean(`Google Maps | ${map.attribution()}`) });
    }
  }
}
