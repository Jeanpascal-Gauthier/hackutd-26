import {
  type BufferGeometry, CanvasTexture, CircleGeometry, Color, Group, LinearFilter, LinearMipmapLinearFilter, Mesh, MeshBasicMaterial,
  RingGeometry, Shape, ShapeGeometry, SphereGeometry, SRGBColorSpace, type Raycaster, type Vector3,
} from '@iwsdk/core';
import { STREET_VIEW_PREVIEW_ZOOM, STREET_VIEW_ZOOM, type PanoLink, type PanoMetadata, type StreetViewClient } from './street-view-client.js';

const DEG = Math.PI / 180;
const SPHERE_RADIUS = 40;
const ARROW_RADIUS = 2.4;
const FADE_SECONDS = 0.35;
const ARROW_COLOR = new Color('#f4f8fa');
const ARROW_HOVER = new Color('#27d8ef');

/**
 * Street View panorama wrapped around the viewer, plus floor chevrons toward linked
 * panoramas. The root shares the city pivot's yaw so north stays where it was in the
 * city view: in that frame +Z is north and +X is west.
 */
export class StreetViewScene {
  readonly root = new Group();
  private readonly sphere: Mesh<SphereGeometry, MeshBasicMaterial>;
  private readonly arrows = new Group();
  private readonly hitTargets: Mesh[] = [];
  private links: PanoLink[] = [];
  private texture: CanvasTexture | null = null;
  private fade = 1;
  private hovered = -1;
  private anisotropy = 1;
  meta: PanoMetadata | null = null;

  constructor() {
    this.root.name = 'Street View';
    const geometry = new SphereGeometry(SPHERE_RADIUS, 64, 32);
    // View the equirectangular image from inside without mirroring it.
    geometry.scale(-1, 1, 1);
    // Drawn first and never writing depth, so the panel and arrows always sit in front.
    const material = new MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, depthWrite: false, fog: false });
    this.sphere = new Mesh(geometry, material);
    this.sphere.name = 'Street View panorama';
    this.sphere.renderOrder = -10;
    this.sphere.frustumCulled = false;
    this.arrows.name = 'Street View links';
    this.root.add(this.sphere, this.arrows);
    this.root.visible = false;
  }

  setAnisotropy(value: number): void { this.anisotropy = value; }

  /**
   * Show `meta`: a low-resolution preview first, then the full panorama when every
   * tile has arrived. `onPreview` fires when the panorama first becomes visible;
   * the promise resolves once the full image is on screen.
   */
  async open(meta: PanoMetadata, client: StreetViewClient, yaw: number, signal: AbortSignal, onPreview: () => void): Promise<void> {
    const preview = document.createElement('canvas');
    await client.stitch(meta, STREET_VIEW_PREVIEW_ZOOM, preview, () => {}, signal);
    if (signal.aborted) return;
    this.meta = meta;
    this.root.rotation.y = yaw;
    // Image centre (u = 0.5) faces the panorama heading; see the frame note above.
    // Verified against Google-rendered thumbnails at known compass headings.
    this.sphere.rotation.y = Math.PI / 2 - meta.heading * DEG;
    this.setTexture(preview);
    this.buildArrows(meta.links);
    if (!this.root.visible) { this.fade = 0; this.root.visible = true; }
    onPreview();
    const full = document.createElement('canvas');
    try {
      await client.stitch(meta, STREET_VIEW_ZOOM, full, () => {}, signal);
    } catch (error) {
      // The preview is already up; a failed upgrade keeps it rather than ejecting the user.
      if (!signal.aborted) console.warn('Street View full-resolution load failed; keeping preview', error);
      return;
    }
    if (signal.aborted || this.meta !== meta) return;
    this.setTexture(full);
  }

  private setTexture(canvas: HTMLCanvasElement): void {
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.generateMipmaps = true;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    texture.anisotropy = this.anisotropy;
    this.sphere.material.map = texture;
    this.sphere.material.needsUpdate = true;
    this.texture?.dispose();
    this.texture = texture;
  }

  private buildArrows(links: PanoLink[]): void {
    this.clearArrows();
    this.links = links;
    const chevron = new Shape();
    chevron.moveTo(0, 0.32); chevron.lineTo(0.34, -0.06); chevron.lineTo(0.2, -0.18);
    chevron.lineTo(0, 0.06); chevron.lineTo(-0.2, -0.18); chevron.lineTo(-0.34, -0.06); chevron.closePath();
    const shapeGeometry = new ShapeGeometry(chevron);
    const hitGeometry = new CircleGeometry(0.75, 16);
    links.forEach((link, index) => {
      // A holder turned by (pi - heading) carries local -Z onto that compass heading.
      const holder = new Group();
      holder.name = `Link ${link.text || link.panoId}`;
      holder.rotation.y = Math.PI - link.heading * DEG;
      const arrow = new Mesh(shapeGeometry, new MeshBasicMaterial({ color: ARROW_COLOR, transparent: true, opacity: 0.85, depthTest: false }));
      arrow.rotation.x = -Math.PI / 2;
      arrow.position.set(0, 0.03, -ARROW_RADIUS);
      arrow.renderOrder = 5;
      const hit = new Mesh(hitGeometry, new MeshBasicMaterial());
      hit.visible = false; // Raycast-only: three tests invisible meshes, the renderer skips them.
      hit.rotation.x = -Math.PI / 2;
      hit.position.copy(arrow.position);
      hit.userData.linkIndex = index;
      holder.add(arrow, hit);
      this.arrows.add(holder);
      this.hitTargets.push(hit);
    });
    this.hovered = -1;
  }

  private clearArrows(): void {
    // Chevron and hit geometries are shared by every link; dispose each once.
    const geometries = new Set<BufferGeometry>();
    for (const holder of [...this.arrows.children]) {
      holder.traverse(object => {
        if (!(object instanceof Mesh)) return;
        geometries.add(object.geometry);
        (object.material as MeshBasicMaterial).dispose();
      });
      this.arrows.remove(holder);
    }
    geometries.forEach(geometry => geometry.dispose());
    this.hitTargets.length = 0;
    this.links = [];
  }

  /** Index of the link chevron under the ray, or -1. */
  pick(raycaster: Raycaster): number {
    if (!this.root.visible) return -1;
    const hit = raycaster.intersectObjects(this.hitTargets, false)[0];
    return hit ? hit.object.userData.linkIndex as number : -1;
  }

  link(index: number): PanoLink | undefined { return this.links[index]; }

  setHovered(index: number): void {
    if (index === this.hovered) return;
    this.hovered = index;
    this.arrows.children.forEach((holder, i) => {
      const arrow = holder.children[0] as Mesh<ShapeGeometry, MeshBasicMaterial>;
      arrow.material.color.copy(i === index ? ARROW_HOVER : ARROW_COLOR);
      arrow.scale.setScalar(i === index ? 1.2 : 1);
    });
  }

  /** Keep the panorama centred on the eyes (no parallax) and the chevrons at the feet. */
  update(delta: number, head: Vector3): void {
    if (!this.root.visible) return;
    this.root.position.set(head.x, 0, head.z);
    this.sphere.position.y = head.y;
    if (this.fade < 1) {
      this.fade = Math.min(1, this.fade + delta / FADE_SECONDS);
      this.sphere.material.opacity = this.fade;
    }
  }

  hide(): void {
    this.root.visible = false;
    this.meta = null;
    this.clearArrows();
    this.sphere.material.map = null;
    this.sphere.material.opacity = 0;
    this.sphere.material.needsUpdate = true;
    this.texture?.dispose();
    this.texture = null;
  }

  dispose(): void {
    this.hide();
    this.sphere.geometry.dispose();
    this.sphere.material.dispose();
  }
}

/** Aim marker on the city: a ring that fills as the pull progresses. */
export class AimReticle {
  readonly root = new Group();
  private readonly fill: Mesh<CircleGeometry, MeshBasicMaterial>;
  private readonly ring: Mesh<RingGeometry, MeshBasicMaterial>;

  constructor() {
    this.root.name = 'Street View aim';
    this.ring = new Mesh(new RingGeometry(0.75, 1, 40), new MeshBasicMaterial({ color: '#27d8ef', depthTest: false, transparent: true, opacity: 0.95 }));
    this.fill = new Mesh(new CircleGeometry(0.75, 40), new MeshBasicMaterial({ color: '#27d8ef', depthTest: false, transparent: true, opacity: 0.55 }));
    this.ring.renderOrder = 30; this.fill.renderOrder = 31;
    this.fill.scale.setScalar(0.001);
    this.root.add(this.ring, this.fill);
    this.root.visible = false;
  }

  /** Face the viewer at a constant apparent size; `progress` 0..1 fills the ring. */
  place(point: Vector3, eye: Vector3, progress: number, locked: boolean): void {
    this.root.visible = true;
    this.root.position.copy(point);
    this.root.lookAt(eye);
    this.root.scale.setScalar(Math.max(0.05, point.distanceTo(eye) * 0.022));
    this.fill.scale.setScalar(Math.max(0.001, progress));
    this.ring.material.color.set(locked ? '#ffd166' : '#27d8ef');
    this.fill.material.color.set(locked ? '#ffd166' : '#27d8ef');
  }

  hide(): void { this.root.visible = false; }

  dispose(): void {
    this.ring.geometry.dispose(); this.ring.material.dispose();
    this.fill.geometry.dispose(); this.fill.material.dispose();
  }
}
