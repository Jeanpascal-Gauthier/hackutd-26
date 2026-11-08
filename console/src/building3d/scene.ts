// Imperative three.js scene behind the Building3D panel. React pushes state in;
// the scene renders on demand (state, controls, eases, resize). The only continuous
// loop is the animated heat field, and only while a floor has fire or smoke.
import {
  BoxGeometry, BufferGeometry, CanvasTexture, Color, DirectionalLight, EdgesGeometry, Float32BufferAttribute, HemisphereLight, LineBasicMaterial,
  LineSegments, Mesh, PerspectiveCamera, PlaneGeometry, type ShaderMaterial, Raycaster, Scene, SRGBColorSpace, Sprite, SpriteMaterial, Vector2, Vector3, WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Building, IncidentState, Room } from "@firewatch/shared/types";
import { createBuildingModel, type BuildingModel } from "./model";
import { createHeatMaterial, hasHeat, heatSources, setHeatBounds, setHeatSources, STILL_TIME, type HeatRect } from "../heat/heatField";
import type { Theme3D } from "./theme";

export interface SceneInput { state: IncidentState | null; floor: number; selectedRoom: string | null }
export interface SceneCallbacks {
  onPick(roomId: string): void;
  /** Hovered room (null when none) and pointer position relative to the host. */
  onHover(roomId: string | null, x: number, y: number): void;
}

const DIM = 0.3; // Opacity and glow multiplier for clear rooms on floors other than the selected one.
const SIGNAL_DIM = 0.6; // Same, for rooms with fire, smoke or a lit route.
const ROUTE_MIN_OPACITY = 0.4;
const EASE_TAU_MS = 70; // Exponential ease constant: ~95% of the way in 200 ms.
const CAMERA_MS = 400;
const FOV = 32;
const VIEW_AZIMUTH = -0.62; // Radians from the entrance side (+z); negative looks in from Stairwell A (-x).
const VIEW_ELEVATION = 0.36;
const DRAG_PX = 5;
/** Heat field layers per burning floor: height above the slab (m) and opacity. Higher layers spread wider (see heatField). */
const HEAT_LAYERS = [{ y: 0.7, opacity: 1 }, { y: 1.7, opacity: 0.7 }, { y: 2.7, opacity: 0.45 }];
const HEAT_MARGIN = 1.5; // Metres the field may bleed past the facade.
const MARKER_SIZE = 2.4; // Origin marker size (m) on the demo; larger buildings scale it with their radius.
/** Tall towers frame a band of about this many storeys (or 1.2x the footprint) around the selected floor. */
const FRAME_FLOORS = 12;

/** Unit-height prism outline (bottom ring, top ring, verticals) around a footprint, for the floor highlight. */
function prismEdges(ring: [number, number][]): BufferGeometry {
  const points: number[] = [];
  ring.forEach(([x, z], i) => {
    const [nx, nz] = ring[(i + 1) % ring.length]!;
    points.push(x, -0.5, z, nx, -0.5, nz, x, 0.5, z, nx, 0.5, nz, x, -0.5, z, x, 0.5, z);
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(points, 3));
  return geometry;
}

/** cubic-bezier(x1, y1, x2, y2) timing function, solved for y at time x. */
function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const error = sx(t) - x;
      if (Math.abs(error) < 1e-6) return sy(t);
      const slope = dx(t);
      if (Math.abs(slope) < 1e-6) break;
      t -= error / slope;
    }
    let lo = 0, hi = 1;
    t = x;
    for (let i = 0; i < 30; i++) { const v = sx(t); if (Math.abs(v - x) < 1e-6) break; if (v < x) lo = t; else hi = t; t = (lo + hi) / 2; }
    return sy(t);
  };
}
const easeInOut = cubicBezier(0.77, 0, 0.175, 1);
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

interface Target { opacity: number; color: Color; emissive: Color; intensity: number }
interface CameraTween { start: number; fromTarget: Vector3; toTarget: Vector3; fromPos: Vector3; toPos: Vector3 }

export class BuildingScene {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(FOV, 1, 1, 2000);
  private readonly controls: OrbitControls;
  private readonly model: BuildingModel;
  private readonly hemi = new HemisphereLight();
  private readonly sun = new DirectionalLight();
  private readonly edgeGeometry = new EdgesGeometry(new BoxGeometry(1, 1, 1));
  private readonly footprintGeometry: BufferGeometry | null;
  private readonly floorRooms = new Map<number, Room[]>();
  private markerSize = MARKER_SIZE;
  private readonly floorLineMaterial = new LineBasicMaterial({ transparent: true });
  private readonly roomLineMaterial = new LineBasicMaterial({ depthTest: false }); // Selection stays visible through slabs.
  private readonly floorOutline: LineSegments;
  private readonly roomOutline: LineSegments;
  private readonly markerCanvas = document.createElement("canvas");
  private readonly markerTexture: CanvasTexture;
  private readonly marker: Sprite;
  private readonly targets = new Map<string, Target>();
  private readonly roomMeshes: Mesh[];
  private readonly heatGeometry = new PlaneGeometry(1, 1);
  private readonly heatLayers = new Map<number, Mesh<PlaneGeometry, ShaderMaterial>[]>();
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private readonly cleanups: (() => void)[] = [];
  private theme: Theme3D;
  private input: SceneInput;
  private raf = 0;
  private hoverRaf = 0;
  private lastTime = 0;
  private visible = true;
  private pending = false;
  private tween: CameraTween | null = null;
  private fitDistance = 100;
  private down: { x: number; y: number } | null = null;
  private hovered: string | null = null;
  private disposed = false;

  constructor(private readonly host: HTMLElement, building: Building, theme: Theme3D, input: SceneInput, private readonly callbacks: SceneCallbacks) {
    this.theme = theme;
    this.input = input;
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.canvas = this.renderer.domElement;
    this.canvas.className = "building3d-canvas";
    host.appendChild(this.canvas);

    this.model = createBuildingModel(building, theme);
    this.scene.add(this.model.root, this.hemi, this.sun, this.sun.target);
    this.roomMeshes = [...this.model.rooms.values()].map((entry) => entry.mesh);
    for (const [id, entry] of this.model.rooms) {
      this.targets.set(id, { opacity: entry.material.opacity, color: entry.material.color.clone(), emissive: new Color(0, 0, 0), intensity: 0 });
      entry.material.emissive.setRGB(0, 0, 0);
      entry.material.emissiveIntensity = 0;
    }

    for (const room of building.rooms) {
      const list = this.floorRooms.get(room.floor);
      if (list) list.push(room); else this.floorRooms.set(room.floor, [room]);
    }
    // Mapped footprints highlight the selected floor along the real outline; box buildings use a box.
    this.footprintGeometry = this.model.slabOutline ? prismEdges(this.model.slabOutline) : null;
    this.floorOutline = new LineSegments(this.footprintGeometry ?? this.edgeGeometry, this.floorLineMaterial);
    this.roomOutline = new LineSegments(this.edgeGeometry, this.roomLineMaterial);
    this.roomOutline.renderOrder = 5;
    this.scene.add(this.floorOutline, this.roomOutline);

    this.markerCanvas.width = this.markerCanvas.height = 64;
    this.markerTexture = new CanvasTexture(this.markerCanvas);
    this.markerTexture.colorSpace = SRGBColorSpace;
    this.marker = new Sprite(new SpriteMaterial({ map: this.markerTexture, depthTest: false, transparent: true }));
    this.marker.renderOrder = 10;
    this.marker.scale.setScalar(this.markerSize);
    this.scene.add(this.marker);

    const b = this.model.bounds;
    this.sun.position.set(b.maxX + 40, b.height + 60, b.maxZ + 50);
    this.sun.target.position.set((b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2);

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minPolarAngle = 0.12;
    this.controls.maxPolarAngle = Math.PI * 0.48; // Never dips under the ground plane.
    this.controls.autoRotate = false;
    this.controls.screenSpacePanning = true;
    // Let one-finger vertical swipes scroll the page on touch screens.
    this.canvas.style.touchAction = "pan-y";
    const onChange = () => this.requestRender();
    this.controls.addEventListener("change", onChange);
    this.cleanups.push(() => this.controls.removeEventListener("change", onChange));

    this.applyTheme();
    this.updateTargets(true);
    this.updateHeat();
    this.updateSelection();
    this.resize();
    this.fit(true);

    const resizeObserver = new ResizeObserver(() => this.resize());
    resizeObserver.observe(host);
    const intersection = new IntersectionObserver(([entry]) => {
      this.visible = entry?.isIntersecting ?? true;
      if (this.visible && this.pending) { this.pending = false; this.requestRender(); }
    });
    intersection.observe(host);
    this.cleanups.push(() => resizeObserver.disconnect(), () => intersection.disconnect());
    this.listen();
  }

  setState(state: IncidentState | null) { this.input = { ...this.input, state }; this.updateTargets(); this.updateHeat(); this.updateSelection(); this.requestRender(); }
  setSelectedRoom(selectedRoom: string | null) { this.input = { ...this.input, selectedRoom }; this.updateSelection(); this.requestRender(); }
  setFloor(floor: number) {
    if (floor === this.input.floor) return;
    this.input = { ...this.input, floor };
    this.updateTargets();
    this.updateHeat();
    this.updateSelection();
    const toTarget = this.controls.target.clone().setY(this.model.floorCenterY(floor));
    const offset = toTarget.clone().sub(this.controls.target);
    this.startTween(toTarget, this.camera.position.clone().add(offset));
  }
  setTheme(theme: Theme3D) { this.theme = theme; this.applyTheme(); this.updateTargets(true); this.requestRender(); }

  /** Reset to the default three-quarter view centred on the selected floor. */
  fit(instant = false) {
    const b = this.model.bounds;
    const target = new Vector3((b.minX + b.maxX) / 2, this.model.floorCenterY(this.input.floor), (b.minZ + b.maxZ) / 2);
    const direction = new Vector3(Math.sin(VIEW_AZIMUTH) * Math.cos(VIEW_ELEVATION), Math.sin(VIEW_ELEVATION), Math.cos(VIEW_AZIMUTH) * Math.cos(VIEW_ELEVATION));
    const position = target.clone().addScaledVector(direction, this.fitDistance);
    if (instant) {
      this.controls.target.copy(target);
      this.camera.position.copy(position);
      this.controls.update();
      this.requestRender();
    } else this.startTween(target, position);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    cancelAnimationFrame(this.hoverRaf);
    for (const cleanup of this.cleanups) cleanup();
    this.controls.dispose();
    this.model.dispose();
    this.edgeGeometry.dispose();
    this.footprintGeometry?.dispose();
    this.floorLineMaterial.dispose();
    this.roomLineMaterial.dispose();
    this.marker.material.dispose();
    this.markerTexture.dispose();
    for (const layers of this.heatLayers.values()) for (const mesh of layers) mesh.material.dispose();
    this.heatGeometry.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }

  private requestRender = () => {
    if (this.disposed || this.raf) return;
    this.raf = requestAnimationFrame(this.frame);
  };

  private frame = (now: number) => {
    this.raf = 0;
    if (!this.visible) { this.pending = true; this.lastTime = 0; return; }
    const dt = this.lastTime ? Math.min(64, now - this.lastTime) : 16;
    this.lastTime = now;
    let animating = this.stepTween(now);
    animating = this.stepRooms(dt) || animating;
    animating = this.stepHeat(now) || animating;
    this.controls.update(); // Emits 'change' (and so another frame) while damping settles.
    this.renderer.render(this.scene, this.camera);
    if (animating) this.requestRender();
    else if (!this.raf) this.lastTime = 0;
  };

  private resize() {
    const width = this.host.clientWidth, height = this.host.clientHeight;
    if (!width || !height) return;
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    // Frame the whole building's bounding sphere in the narrower field of view. Towers much taller than
    // they are wide frame a band of storeys around the selected floor instead (the demo frames all of it),
    // and can still zoom out to the whole building.
    const b = this.model.bounds;
    const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
    const storey = this.model.floorCenterY(2) - this.model.floorCenterY(1);
    const band = Math.min(b.height, Math.max(span * 1.2, FRAME_FLOORS * storey));
    const radius = 0.5 * Math.hypot(b.maxX - b.minX, band, b.maxZ - b.minZ);
    const whole = 0.5 * Math.hypot(b.maxX - b.minX, b.height, b.maxZ - b.minZ);
    const vertical = (FOV * Math.PI) / 180;
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * this.camera.aspect);
    const previous = this.fitDistance;
    const fitFor = (r: number) => (r / Math.sin(Math.min(vertical, horizontal) / 2)) * 0.92;
    this.fitDistance = fitFor(radius);
    this.controls.minDistance = this.fitDistance * 0.3;
    this.controls.maxDistance = Math.max(this.fitDistance * 2.2, fitFor(whole) * 1.3);
    const far = Math.max(2000, fitFor(whole) * 4);
    if (far !== this.camera.far) { this.camera.far = far; this.camera.updateProjectionMatrix(); }
    this.markerSize = Math.max(MARKER_SIZE, radius * 0.08);
    this.marker.scale.setScalar(this.markerSize);
    // Keep the user's relative zoom when the panel changes size.
    if (previous !== this.fitDistance && this.camera.position.lengthSq() > 0) {
      const offset = this.camera.position.clone().sub(this.controls.target);
      offset.multiplyScalar(this.fitDistance / previous);
      this.camera.position.copy(this.controls.target).add(offset);
    }
    this.requestRender();
  }

  private startTween(toTarget: Vector3, toPos: Vector3) {
    if (reducedMotion()) {
      this.tween = null;
      this.controls.target.copy(toTarget);
      this.camera.position.copy(toPos);
      this.controls.update();
      this.requestRender();
      return;
    }
    this.tween = { start: performance.now(), fromTarget: this.controls.target.clone(), toTarget, fromPos: this.camera.position.clone(), toPos };
    this.requestRender();
  }

  private stepTween(now: number): boolean {
    const tween = this.tween;
    if (!tween) return false;
    const t = Math.min(1, (now - tween.start) / CAMERA_MS);
    const k = easeInOut(t);
    this.controls.target.lerpVectors(tween.fromTarget, tween.toTarget, k);
    this.camera.position.lerpVectors(tween.fromPos, tween.toPos, k);
    if (t >= 1) this.tween = null;
    return t < 1;
  }

  /** Headset colouring rules (headset/src/building-system.ts), with floor dimming. */
  private updateTargets(snap = false) {
    const { state, floor } = this.input;
    const base = new Color(this.theme.muted), smoke = new Color(this.theme.smoke), fire = new Color(this.theme.fire), route = new Color(this.theme.safe);
    const roomStates = new Map((state?.rooms ?? []).map((room) => [room.roomId, room]));
    const routeRooms = state?.accepted != null ? new Set((state.exits ?? []).flatMap((exit) => exit.route ?? [])) : null;
    for (const [id, entry] of this.model.rooms) {
      const target = this.targets.get(id)!;
      const current = roomStates.get(id);
      const f = Math.min(1, Math.max(0, current?.fire ?? 0));
      const s = Math.min(1, Math.max(0, current?.smoke ?? 0));
      const onRoute = !!routeRooms?.has(id) && f < 0.15 && s < 0.15;
      // Clear rooms on other floors recede; hazards and the route stay readable.
      const dim = entry.room.floor === floor ? 1 : onRoute || Math.max(f, s) > 0.05 ? SIGNAL_DIM : DIM;
      target.opacity = (0.16 + Math.max(f, s) * 0.6) * dim;
      // Diffuse tint follows the same smoke -> fire mix so hazards read under flat lighting.
      target.color.copy(entry.baseColor).lerp(smoke, s).lerp(fire, f);
      if (onRoute) {
        // Lift the glow above the 0.16 base so green reads on a flat page, not only in VR.
        target.opacity = Math.max(target.opacity, ROUTE_MIN_OPACITY * dim);
        target.emissive.copy(route);
        target.intensity = 0.9 * dim;
      } else {
        target.emissive.copy(base).lerp(smoke, s).lerp(fire, f);
        target.intensity = Math.max(f, s * 0.6) * dim;
      }
      if (snap || reducedMotion()) {
        entry.material.opacity = target.opacity;
        entry.material.emissive.copy(target.emissive);
        entry.material.color.copy(target.color);
        entry.material.emissiveIntensity = target.intensity;
      }
    }
  }

  private stepRooms(dt: number): boolean {
    const k = 1 - Math.exp(-dt / EASE_TAU_MS);
    let moving = false;
    for (const [id, entry] of this.model.rooms) {
      const target = this.targets.get(id)!;
      const m = entry.material;
      const dOpacity = target.opacity - m.opacity, dIntensity = target.intensity - m.emissiveIntensity;
      const e = m.emissive, te = target.emissive;
      const c = m.color, tc = target.color;
      const dColor = Math.abs(te.r - e.r) + Math.abs(te.g - e.g) + Math.abs(te.b - e.b) + Math.abs(tc.r - c.r) + Math.abs(tc.g - c.g) + Math.abs(tc.b - c.b);
      if (Math.abs(dOpacity) < 0.002 && Math.abs(dIntensity) < 0.002 && dColor < 0.004) {
        m.opacity = target.opacity; m.emissiveIntensity = target.intensity; e.copy(te); c.copy(tc);
        continue;
      }
      m.opacity += dOpacity * k;
      m.emissiveIntensity += dIntensity * k;
      e.lerp(te, k);
      c.lerp(tc, k);
      moving = true;
    }
    return moving;
  }

  /** One set of floating heat-field layers per floor with fire or smoke; the selected floor reads strongest. */
  private updateHeat() {
    const { state, floor } = this.input;
    const b = this.model.bounds;
    const clip: HeatRect = [b.minX, b.minZ, b.maxX, b.maxZ];
    const bounds: HeatRect = [b.minX - HEAT_MARGIN, b.minZ - HEAT_MARGIN, b.maxX + HEAT_MARGIN, b.maxZ + HEAT_MARGIN];
    for (let level = 1; level <= this.model.floors; level++) {
      const sources = heatSources(this.floorRooms.get(level) ?? [], state);
      let layers = this.heatLayers.get(level);
      if (!hasHeat(sources)) {
        if (layers) { for (const mesh of layers) { this.scene.remove(mesh); mesh.material.dispose(); } this.heatLayers.delete(level); }
        continue;
      }
      if (!layers) {
        const slab = this.model.slab(level);
        layers = HEAT_LAYERS.map((spec, index) => {
          const material = createHeatMaterial({ layer: index });
          material.depthTest = false; // Visible through the slabs above, like the selection outline.
          const mesh = new Mesh(this.heatGeometry, material);
          mesh.rotation.x = -Math.PI / 2; // Plane +y becomes world -z, matching the shader's uv mapping.
          mesh.scale.set(bounds[2] - bounds[0], bounds[3] - bounds[1], 1);
          mesh.position.set((bounds[0] + bounds[2]) / 2, slab.y + spec.y * this.model.floorScale, (bounds[1] + bounds[3]) / 2);
          mesh.renderOrder = 6 + index;
          setHeatBounds(material, bounds, clip);
          this.scene.add(mesh);
          return mesh;
        });
        this.heatLayers.set(level, layers);
      }
      layers.forEach((mesh, index) => {
        setHeatSources(mesh.material, sources);
        mesh.material.uniforms.uOpacity!.value = HEAT_LAYERS[index]!.opacity * (level === floor ? 1 : SIGNAL_DIM);
      });
    }
  }

  /** Advances the heat field clock; true while it should keep animating. */
  private stepHeat(now: number): boolean {
    if (!this.heatLayers.size) return false;
    const still = reducedMotion();
    for (const layers of this.heatLayers.values()) for (const mesh of layers) mesh.material.uniforms.uTime!.value = still ? STILL_TIME : now / 1000;
    return !still;
  }

  private updateSelection() {
    const { floor, selectedRoom, state } = this.input;
    const b = this.model.bounds;
    const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
    const bottom = this.model.slab(floor), top = this.model.slab(floor + 1);
    if (this.footprintGeometry) {
      this.floorOutline.position.set(0, (bottom.y + top.y) / 2, 0);
      this.floorOutline.scale.set(1, top.y - bottom.y + bottom.h, 1);
    } else {
      this.floorOutline.position.set(cx, (bottom.y + top.y) / 2, cz);
      this.floorOutline.scale.set(bottom.w, top.y - bottom.y + bottom.h, bottom.d);
    }

    const room = selectedRoom ? this.model.rooms.get(selectedRoom) : undefined;
    this.roomOutline.visible = !!room;
    if (room) {
      const s = this.model.root.scale.x;
      this.roomOutline.position.copy(room.mesh.position).multiplyScalar(s);
      this.roomOutline.scale.copy(room.mesh.scale).multiplyScalar(s * 1.01);
    }

    const origin = state?.origin ? this.model.rooms.get(state.origin.roomId) : undefined;
    this.marker.visible = !!origin;
    if (origin) {
      const s = this.model.root.scale.x;
      this.marker.position.set(origin.mesh.position.x * s, (origin.mesh.position.y + origin.mesh.scale.y / 2) * s + this.markerSize * 0.75, origin.mesh.position.z * s);
    }
  }

  private applyTheme() {
    const t = this.theme;
    this.model.applyTheme(t);
    this.renderer.setClearColor(t.surface, 1);
    this.hemi.color.set("#ffffff");
    this.hemi.groundColor.set(t.bg);
    this.hemi.intensity = t.isLight ? 1.7 : 0.9;
    this.sun.intensity = t.isLight ? 1.1 : 0.8;
    this.floorLineMaterial.color.set(t.accent);
    this.floorLineMaterial.opacity = 0.9;
    this.roomLineMaterial.color.set(t.text);
    const ctx = this.markerCanvas.getContext("2d");
    if (ctx) {
      ctx.clearRect(0, 0, 64, 64);
      ctx.beginPath(); ctx.arc(32, 32, 30, 0, Math.PI * 2); ctx.fillStyle = t.surface; ctx.fill();
      ctx.beginPath(); ctx.arc(32, 32, 24, 0, Math.PI * 2); ctx.fillStyle = t.fire; ctx.fill();
      ctx.beginPath(); ctx.arc(32, 32, 8, 0, Math.PI * 2); ctx.fillStyle = t.surface; ctx.fill();
      this.markerTexture.needsUpdate = true;
    }
  }

  private pick(clientX: number, clientY: number): string | null {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    this.pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    this.model.root.updateMatrixWorld();
    const hits = this.raycaster.intersectObjects(this.roomMeshes, false);
    // Rooms are translucent, so prefer the highlighted floor whenever the ray passes through it.
    const hit = hits.find((h) => this.model.rooms.get(h.object.userData.roomId as string)?.room.floor === this.input.floor) ?? hits[0];
    return (hit?.object.userData.roomId as string | undefined) ?? null;
  }

  private listen() {
    const canvas = this.canvas;
    const onDown = (event: PointerEvent) => { this.down = event.isPrimary && event.button === 0 ? { x: event.clientX, y: event.clientY } : null; };
    const onUp = (event: PointerEvent) => {
      const down = this.down;
      this.down = null;
      if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > DRAG_PX) return;
      const id = this.pick(event.clientX, event.clientY);
      if (id) this.callbacks.onPick(id);
    };
    const onCancel = () => { this.down = null; };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onCancel);
    this.cleanups.push(() => { canvas.removeEventListener("pointerdown", onDown); canvas.removeEventListener("pointerup", onUp); canvas.removeEventListener("pointercancel", onCancel); });

    // Hover feedback only where a precise pointer can hover.
    const fine = window.matchMedia("(hover: hover) and (pointer: fine)");
    let last = { x: 0, y: 0 };
    const setHover = (id: string | null) => {
      if (id === this.hovered && !id) return;
      this.hovered = id;
      canvas.style.cursor = id ? "pointer" : "";
      const rect = canvas.getBoundingClientRect();
      this.callbacks.onHover(id, last.x - rect.left, last.y - rect.top);
    };
    const onMove = (event: PointerEvent) => {
      if (!fine.matches || event.pointerType === "touch") return;
      last = { x: event.clientX, y: event.clientY };
      if (event.buttons) { if (this.hovered) setHover(null); return; }
      if (this.hoverRaf) return;
      this.hoverRaf = requestAnimationFrame(() => { this.hoverRaf = 0; setHover(this.pick(last.x, last.y)); });
    };
    const onLeave = () => { cancelAnimationFrame(this.hoverRaf); this.hoverRaf = 0; if (this.hovered) setHover(null); };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);
    this.cleanups.push(() => { canvas.removeEventListener("pointermove", onMove); canvas.removeEventListener("pointerleave", onLeave); });
  }
}
