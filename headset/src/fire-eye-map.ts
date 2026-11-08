import { BoxGeometry, BufferGeometry, DoubleSide, Float32BufferAttribute, Group, LinearFilter, LinearMipmapLinearFilter, Mesh, MeshBasicMaterial, PerspectiveCamera, Raycaster, Texture, Vector3, type Camera, type WebGLRenderer } from '@iwsdk/core';
import { Scheduler, TilesRenderer } from '3d-tiles-renderer';
import { GoogleCloudAuthPlugin } from '3d-tiles-renderer/core/plugins';
import { ReorientationPlugin, TileCompressionPlugin } from '3d-tiles-renderer/plugins';
import type { FireEyeState } from './fire-eye-state.js';

const DEG = Math.PI / 180;
// Pull low-detail building silhouettes farther from the observer. Matching height
// and horizontal distance keeps the selected coordinate about 45 degrees below eye level.
const HEIGHT = 250;
const SIDE_VIEW_DISTANCE = 200;
// Road strips must read from 250 m up; drawn over the city so terrain never hides them.
const ROAD_WIDTH = 10;
const ROAD_MATERIAL = new MeshBasicMaterial({ color: 0xff2020, transparent: true, opacity: 0.9, depthTest: false });
const WATER_MATERIAL = new MeshBasicMaterial({ color: 0x2f86ff, transparent: true, opacity: 0.5, depthTest: false, side: DoubleSide });
/** Water floats just above the sampled ground so it reads as a surface, under the road strips. */
const WATER_HEIGHT = 1.5;

/** Owns one streamed tileset. The observer stays still; changing sides rotates the city. */
export class FireEyeMap {
  readonly anchor = new Group();
  readonly pivot = new Group();
  readonly tiles = new TilesRenderer();
  private readonly overlay = new Group();
  private overlayPaths: { lat: number; lon: number }[][] = [];
  private water: Mesh | null = null;
  private waterInput: { center: { lat: number; lon: number }; steps: { minute: number; water: { lat: number; lon: number }[] }[] } | null = null;
  private waterRings: { minute: number; points: Vector3[] }[] = [];
  private waterCenter = new Vector3();
  private waterMinute = 30;
  ready = false;
  failed = false;
  surfaceY = 0;
  private rootReady = false;
  private elapsed = 0;
  private total = 0;
  private readonly ray = new Raycaster();
  private readonly down = new Vector3(0, -1, 0);
  private readonly origin = new Vector3();
  private readonly hits: ReturnType<Raycaster['intersectObject']> = [];
  private readonly auth: GoogleCloudAuthPlugin;
  private readonly preloadCamera = new PerspectiveCamera(50, 1, 0.5, 3000);
  private selectionCamera: Camera | null = null;
  private preloadRegistered = true;
  private anisotropy = 1;
  private samplingConfigured = false;

  constructor(token: string, lat: number, lon: number, private readonly onError: (reason: string) => void) {
    this.anchor.name = 'FireEye city';
    this.pivot.name = 'Incident perspective';
    this.anchor.position.set(0, -HEIGHT, -HEIGHT);
    this.anchor.add(this.pivot);
    this.pivot.add(this.tiles.group);
    this.overlay.name = 'Incident road overlay';
    this.pivot.add(this.overlay);
    this.auth = new GoogleCloudAuthPlugin({ apiToken: token, autoRefreshToken: true });
    this.tiles.registerPlugin(this.auth);
    // Distant, oblique roads and roofs need mipmaps; stripping them causes head-motion shimmer.
    this.tiles.registerPlugin(new TileCompressionPlugin({ disableMipmaps: false }));
    this.tiles.registerPlugin({
      name: 'FIREEYE_TEXTURE_FILTERING',
      processTileModel: (scene: Group) => {
        scene.traverse(object => {
          if (!(object instanceof Mesh)) return;
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          for (const material of materials) {
            for (const value of Object.values(material)) {
              if (!(value instanceof Texture)) continue;
              value.generateMipmaps = true;
              value.minFilter = LinearMipmapLinearFilter;
              value.magFilter = LinearFilter;
              value.anisotropy = this.anisotropy;
              value.needsUpdate = true;
            }
          }
        });
      },
    });
    this.tiles.registerPlugin(new ReorientationPlugin({ lat: lat * DEG, lon: lon * DEG, recenter: true }));
    // A modest detail increase rounds out nearby roofs without removing the Quest
    // resolution/cache limits. Runtime verification still owns the triangle budget.
    this.tiles.errorTarget = 72;
    this.tiles.lruCache.maxBytesSize = 96 * 1024 * 1024;
    this.tiles.lruCache.minBytesSize = 64 * 1024 * 1024;
    this.tiles.parseQueue.maxJobs = 1;
    this.preloadCamera.position.set(0, 1.6, 0);
    this.preloadCamera.lookAt(0, -HEIGHT, -HEIGHT);
    this.preloadCamera.updateMatrixWorld(true);
    this.tiles.setCamera(this.preloadCamera);
    this.tiles.setResolution(this.preloadCamera, 600, 600);
    this.tiles.addEventListener('load-root-tileset', () => { this.rootReady = true; });
    this.tiles.addEventListener('load-error', (event: { error?: Error; url?: string | URL }) => {
      // A failed child tile can recover; a rejected root cannot display any map.
      if (!this.rootReady) this.fail(`tileset rejected: ${event.error?.message ?? 'unknown error'}`);
    });
  }

  private fail(reason: string): void {
    if (this.failed) return;
    this.failed = true;
    this.onError(reason);
  }

  update(delta: number, camera: PerspectiveCamera, renderer: WebGLRenderer): boolean {
    if (this.failed) return false;
    // The Quest pauses window rAF during WebXR; tile downloads must follow the session's frames.
    const session = renderer.xr.isPresenting ? renderer.xr.getSession() : null;
    // Typings omit null, which is how the scheduler returns to window rAF.
    Scheduler.setXRSession(session as XRSession);
    if (!this.samplingConfigured) {
      this.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
      this.samplingConfigured = true;
    }
    // The stereo camera's combined frustum covers both eyes. The flat browser camera can
    // incorrectly cull tiles at an eye's edge while the user turns their head.
    const selectionCamera = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
    if (this.selectionCamera !== selectionCamera) {
      if (this.selectionCamera) this.tiles.deleteCamera(this.selectionCamera);
      this.selectionCamera = selectionCamera;
      this.tiles.setCamera(selectionCamera);
    }
    if (renderer.xr.isPresenting) {
      const eye = renderer.xr.getCamera().cameras[0];
      if (eye?.viewport) {
        // Keep geometric detail bounded independently of headset display resolution.
        const scale = Math.min(1, 1024 / Math.max(eye.viewport.z, eye.viewport.w));
        this.tiles.setResolution(selectionCamera, eye.viewport.z * scale, eye.viewport.w * scale);
      }
    } else {
      this.tiles.setResolutionFromRenderer(selectionCamera, renderer);
    }
    // Use the fixed incident camera only while loading behind the briefing. Keeping it
    // alongside the live stereo frustum needlessly retains tiles outside the user's view.
    const preload = !this.anchor.visible;
    if (preload !== this.preloadRegistered) {
      if (preload) {
        this.tiles.setCamera(this.preloadCamera);
        this.tiles.setResolution(this.preloadCamera, 600, 600);
      } else {
        this.tiles.deleteCamera(this.preloadCamera);
      }
      this.preloadRegistered = preload;
    }
    this.anchor.updateMatrixWorld(true);
    this.tiles.update();
    this.total += delta;
    this.elapsed += delta;
    if (!this.ready && this.total > 60) { this.fail(`no ground found after 60 s (${this.tiles.visibleTiles.size} tiles visible)`); return false; }
    if (this.ready || !this.rootReady || this.elapsed < 0.5) return false;
    this.elapsed = 0;
    // Surface sampling only: this ray never handles user interaction.
    this.anchor.updateMatrixWorld(true);
    this.origin.set(0, 2000, -HEIGHT);
    this.ray.set(this.origin, this.down);
    this.hits.length = 0;
    this.ray.intersectObject(this.tiles.group, true, this.hits);
    const hit = this.hits[0];
    if (!hit) return false;
    const altitude = hit.point.y + HEIGHT;
    if (Math.abs(altitude) > 600) return false;
    // Ignore the coarse whole-region proxy until a useful local tile is visible.
    if (this.tiles.visibleTiles.size < 2 || this.total < 3) return false;
    this.surfaceY = altitude;
    this.tiles.group.position.y -= altitude;
    this.ready = true;
    this.buildOverlay();
    this.buildWater();
    return true;
  }

  setPerspective(view: FireEyeState['perspective']): void {
    // Reorientation's local +Z is north, +X west. Keep the target fixed while orbiting.
    this.pivot.rotation.y = { overview: 0, north: 0, east: Math.PI / 2, south: Math.PI, west: -Math.PI / 2 }[view];
    const distance = view === 'overview' ? HEIGHT : SIDE_VIEW_DISTANCE;
    this.anchor.position.set(0, -distance, -distance);
    this.preloadCamera.lookAt(0, -distance, -distance);
    this.preloadCamera.updateMatrixWorld(true);
  }

  /** Yaw of the city frame; Street View shares it so north stays put. */
  get yaw(): number { return this.pivot.rotation.y; }

  /** First city surface under `raycaster`, in world space. */
  hit(raycaster: Raycaster): Vector3 | null {
    // The tiles renderer walks its bounding-volume tree and stops at the first hit.
    (raycaster as Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true;
    this.hits.length = 0;
    raycaster.intersectObject(this.tiles.group, true, this.hits);
    return this.hits[0]?.point.clone() ?? null;
  }

  /** WGS84 latitude/longitude in degrees for a world-space point on the city. */
  toLatLon(world: Vector3): { lat: number; lon: number } {
    this.anchor.updateMatrixWorld(true);
    const local = this.tiles.group.worldToLocal(world.clone());
    const { lat, lon } = this.tiles.ellipsoid.getPositionToCartographic(local, {});
    return { lat: lat / DEG, lon: lon / DEG };
  }

  /** Shift the city so world point `ground` lands on the floor under (x, z). */
  standAt(ground: Vector3, x: number, z: number): void {
    this.anchor.position.x += x - ground.x;
    this.anchor.position.y -= ground.y;
    this.anchor.position.z += z - ground.z;
    this.anchor.updateMatrixWorld(true);
  }

  /** Red strips along each path (blocked or queued road). Rebuilt once the surface height is known. */
  setRoadOverlay(paths: { lat: number; lon: number }[][]): void {
    this.overlayPaths = paths;
    this.buildOverlay();
  }

  private buildOverlay(): void {
    for (const child of [...this.overlay.children]) { (child as Mesh).geometry.dispose(); this.overlay.remove(child); }
    if (!this.ready) return;
    this.tiles.group.updateMatrix();
    const a = new Vector3(), b = new Vector3();
    for (const path of this.overlayPaths) {
      for (let i = 1; i < path.length; i++) {
        this.toLocal(path[i - 1], a); this.toLocal(path[i], b);
        const length = a.distanceTo(b);
        if (length < 0.5) continue;
        const strip = new Mesh(new BoxGeometry(ROAD_WIDTH, 1, length), ROAD_MATERIAL);
        strip.position.copy(a).add(b).multiplyScalar(0.5);
        strip.rotation.y = Math.atan2(b.x - a.x, b.z - a.z);
        strip.renderOrder = 10;
        this.overlay.add(strip);
      }
    }
  }

  /** Flood water: one ring per forecast minute around `center`. Null clears it. */
  setWater(center: { lat: number; lon: number } | null, steps: { minute: number; water: { lat: number; lon: number }[] }[] = []): void {
    this.waterInput = center && steps.length ? { center, steps } : null;
    this.buildWater();
  }

  /** Show the water as it is at `minute`, blending between the neighbouring forecast rings. */
  setWaterMinute(minute: number): void {
    this.waterMinute = minute;
    const water = this.water;
    const rings = this.waterRings;
    if (!water || !rings.length) return;
    const count = rings[0].points.length;
    const position = water.geometry.getAttribute('position') as Float32BufferAttribute;
    let from: Vector3[] | null = null, to = rings[0].points, t = 1;
    if (minute <= rings[0].minute) {
      // Before the first ring the water grows out of the reported spot.
      t = Math.max(0, minute / rings[0].minute);
    } else {
      const next = rings.findIndex(ring => ring.minute > minute);
      if (next === -1) to = rings[rings.length - 1].points;
      else {
        const prev = rings[next - 1];
        from = prev.points; to = rings[next].points;
        t = (minute - prev.minute) / (rings[next].minute - prev.minute);
        // Rings with different point counts cannot blend; hold the earlier one.
        if (from.length !== to.length) { to = from; from = null; t = 1; }
      }
    }
    position.setXYZ(0, this.waterCenter.x, WATER_HEIGHT, this.waterCenter.z);
    for (let i = 0; i < count; i++) {
      const a = from ? from[i] : this.waterCenter;
      const b = to[i] ?? to[to.length - 1];
      position.setXYZ(i + 1, a.x + (b.x - a.x) * t, WATER_HEIGHT, a.z + (b.z - a.z) * t);
    }
    position.needsUpdate = true;
    water.geometry.computeBoundingSphere();
  }

  private buildWater(): void {
    if (this.water) { this.water.geometry.dispose(); this.water.removeFromParent(); this.water = null; }
    this.waterRings = [];
    const input = this.waterInput;
    if (!this.ready || !input) return;
    this.tiles.group.updateMatrix();
    this.toLocal(input.center, this.waterCenter);
    this.waterRings = input.steps
      .filter(step => step.water.length >= 3)
      .map(step => ({ minute: step.minute, points: step.water.map(point => this.toLocal(point, new Vector3())) }));
    if (!this.waterRings.length) return;
    // Fan from the reported spot: the model's rings are radial around it, so the fan never folds.
    const count = this.waterRings[0].points.length;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(new Float32Array((count + 1) * 3), 3));
    const index: number[] = [];
    for (let i = 0; i < count; i++) index.push(0, 1 + i, 1 + ((i + 1) % count));
    geometry.setIndex(index);
    this.water = new Mesh(geometry, WATER_MATERIAL);
    this.water.name = 'Flood water';
    this.water.renderOrder = 9;
    this.water.frustumCulled = false;
    this.pivot.add(this.water);
    this.setWaterMinute(this.waterMinute);
  }

  /** Geographic point at the sampled ground height, in the pivot's frame. */
  private toLocal(point: { lat: number; lon: number }, target: Vector3): Vector3 {
    this.tiles.ellipsoid.getCartographicToPosition(point.lat * DEG, point.lon * DEG, this.surfaceY, target);
    return target.applyMatrix4(this.tiles.group.matrix);
  }

  attribution(): string {
    const entries: { type: string; value: string }[] = [];
    this.tiles.getAttributions(entries);
    return entries.filter(entry => entry.type === 'string').map(entry => entry.value).join(' | ');
  }

  dispose(): void {
    this.overlayPaths = [];
    this.waterInput = null;
    this.ready = false;
    this.buildOverlay();
    this.buildWater();
    this.tiles.dispose();
  }
}
